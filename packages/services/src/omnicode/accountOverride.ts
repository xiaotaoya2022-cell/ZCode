// [OmniCode] 模式二：单实例多账号并发会话——per-session 账号覆盖边界（spec:
// docs/omnicode/multi-account-sessions.md §4/§6/§8）。
//
// 设计要点：
// - 官方"用哪份凭据"的唯一汇聚点 = resolveCurrentAccountAccess 的三个注入闭包
//   （node.ts 的 loadOAuthAccountMaterial / loadStartPlanMaterial / readAccountProviderSettings）。
//   本模块只做"作用域激活时替换这三个 loader 的答案"，官方 oauthCredentialRepo 单账号快照
//   语义零改动。
// - 作用域 = AsyncLocalStorage（会话/任务运行期绑定 accountId），事件驱动、无轮询；
//   作用域未激活 → 三个 loader 原样透传官方路径（官方 flavor 行为逐字不变）。
// - 门控默认 = OMNICODE_PROFILE_ID env（仅 omnicode Profile 实例进程注入；管理器/官方进程
//   恒 inert）。刻意不用 ZCODE_PRODUCT_FLAVOR 编译期常量做门控——services bundle 的 define
//   注入面存在不确定性（node.ts:2021 自证 host bundle define 不齐），运行时 env 是已验证事实
//   （node.ts:2429 同款）。
// - fail-closed：作用域激活但材料缺失/family 不匹配 → 返回 null/空视图（请求以
//   AccountRequestCredentialUnavailableError 收口），绝不回落主账号材料（防串号）。
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {
  providerFamilyConnectionSelectionSettingsSchema,
} from "@zcode/shared";
import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import type { AccountProviderConnectionSettings } from "../model-provider/accountProviderConnectionResolver.js";
import type { OAuthAccountMaterial, OAuthStartPlanMaterial } from "../oauth/repo/oauthCredentialRepo.js";

/** 附加账号材料快照（omnicode-accounts/<accountId>.json 解密后的形状；bridge-proxy 来源在 R2 复用同一形状）。 */
export interface OmnicodeAccountOverrideMaterial {
  accountId: string;
  family: ProviderFamilyDomain;
  /** 该账号自己的连接选择（resolveCurrentAccountAccess 读 selections[family]）。 */
  selections: ProviderFamilyConnectionSelectionSettings;
  accountIdentity: string;
  startPlanMaterial: OAuthStartPlanMaterial | null;
  familyMaterial: OAuthAccountMaterial | null;
  /** billing X-Device-Mid 红线（§5）：bridge-proxy 来源=源 profile 的 MID；local 来源=本实例 MID。 */
  deviceMid: string | null;
}

const providerFamilyEnum = z.enum(["zai", "bigmodel"]);
const oauthAccountMaterialBaseShape = {
  family: providerFamilyEnum,
  loginProvider: z.string().min(1),
  zcodeUserId: z.string().min(1),
  sessionRevision: z.string().nullable(),
  accountIdentity: z.string().min(1),
  zcodeJwtToken: z.string().nullable(),
};

/** omnicode-accounts/<accountId>.json 解密后（KV 各值 JSON.parse）的校验 schema。 */
export const omnicodeAccountMaterialFileSchema = z
  .object({
    accountId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/u, "accountId 形态非法"),
    family: providerFamilyEnum,
    selections: providerFamilyConnectionSelectionSettingsSchema,
    accountIdentity: z.string().min(1),
    startPlanMaterial: z.object(oauthAccountMaterialBaseShape).strict().nullable(),
    familyMaterial: z
      .object({ ...oauthAccountMaterialBaseShape, accessToken: z.string().min(1) })
      .strict()
      .nullable(),
    deviceMid: z.string().min(1).nullable(),
  })
  .strict();

/** 文件数据（schema 推断；字段形状与官方材料类型结构兼容，读取侧按官方类型收口）。 */
export type OmnicodeAccountMaterialFileData = z.infer<typeof omnicodeAccountMaterialFileSchema>;

// ─── 会话作用域（AsyncLocalStorage；Host/agent 运行期由编排层包裹） ───

const scopeStorage = new AsyncLocalStorage<{ accountId: string }>();

/** 在绑定了附加账号的作用域内执行 fn（agent 会话运行期包裹点；R1.5 接入 host 会话循环）。 */
export function runWithOmnicodeAccountScope<T>(accountId: string, fn: () => T): T {
  return scopeStorage.run({ accountId }, fn);
}

/** 当前作用域绑定的附加账号 id；未激活返回 null（官方路径）。 */
export function getOmnicodeAccountScopeAccountId(): string | null {
  return scopeStorage.getStore()?.accountId ?? null;
}

// ─── 材料提供者接口（local 文件实现见 accountMaterialFile.ts；bridge-proxy 实现属 R2） ───

export interface OmnicodeAccountMaterialProvider {
  /** 返回 null = 材料缺失/损坏（fail-closed，不回落主账号）。 */
  load(accountId: string): Promise<OmnicodeAccountOverrideMaterial | null>;
}

/** 官方 loader 形状（与 node.ts 三个注入闭包同签名；fallback=官方路径）。 */
export interface OmnicodeAccountOverrideLoaderFallbacks {
  loadFamilyMaterial(family: ProviderFamilyDomain): Promise<OAuthAccountMaterial | null>;
  loadStartPlanMaterial(family: ProviderFamilyDomain): Promise<OAuthStartPlanMaterial | null>;
}

export interface OmnicodeAccountOverride {
  /** 当前作用域绑定的附加账号 id（门控关闭恒 null）。 */
  scopedAccountId(): string | null;
  loadFamilyMaterial(
    family: ProviderFamilyDomain,
    fallback: OmnicodeAccountOverrideLoaderFallbacks["loadFamilyMaterial"],
  ): Promise<OAuthAccountMaterial | null>;
  loadStartPlanMaterial(
    family: ProviderFamilyDomain,
    fallback: OmnicodeAccountOverrideLoaderFallbacks["loadStartPlanMaterial"],
  ): Promise<OAuthStartPlanMaterial | null>;
  readSettings(
    fallback: () => Promise<AccountProviderConnectionSettings>,
  ): Promise<AccountProviderConnectionSettings>;
}

export interface OmnicodeAccountOverrideOptions {
  materialProvider: OmnicodeAccountMaterialProvider;
  /** 实例身份门控（测试注入）；缺省 = OMNICODE_PROFILE_ID env 非空（omnicode Profile 实例）。 */
  isActive?: () => boolean;
  /** 材料缓存 TTL（同账号短 TTL 现取语义，spec §7）；默认 60s。 */
  cacheTtlMs?: number;
  now?: () => number;
}

function defaultIsActive(): boolean {
  return Boolean(process.env.OMNICODE_PROFILE_ID?.trim());
}

/**
 * 构造覆盖边界（node.ts 装配点消费；每个 services 容器一份）。三个 wrap 方法在
 * 作用域未激活时**原样调用 fallback**——官方路径逐字不变；激活时按附加账号材料作答，
 * 材料缺失/family 不匹配一律 null（fail-closed）。
 */
export function createOmnicodeAccountOverride(
  options: OmnicodeAccountOverrideOptions,
): OmnicodeAccountOverride {
  const isActive = options.isActive ?? defaultIsActive;
  const now = options.now ?? (() => Date.now());
  const ttl = options.cacheTtlMs ?? 60_000;
  const cache = new Map<string, { value: OmnicodeAccountOverrideMaterial | null; expiresAt: number }>();

  const loadMaterial = async (accountId: string): Promise<OmnicodeAccountOverrideMaterial | null> => {
    const cached = cache.get(accountId);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = await options.materialProvider.load(accountId);
    cache.set(accountId, { value, expiresAt: now() + ttl });
    return value;
  };

  const scopedAccountId = (): string | null => {
    if (!isActive()) return null;
    return getOmnicodeAccountScopeAccountId();
  };

  return {
    scopedAccountId,
    async loadFamilyMaterial(family, fallback) {
      const accountId = scopedAccountId();
      if (accountId === null) return fallback(family);
      const material = await loadMaterial(accountId);
      if (!material || material.family !== family) return null;
      return material.familyMaterial;
    },
    async loadStartPlanMaterial(family, fallback) {
      const accountId = scopedAccountId();
      if (accountId === null) return fallback(family);
      const material = await loadMaterial(accountId);
      if (!material || material.family !== family) return null;
      return material.startPlanMaterial;
    },
    async readSettings(
      fallback: () => Promise<AccountProviderConnectionSettings>,
    ): Promise<AccountProviderConnectionSettings> {
      const accountId = scopedAccountId();
      if (accountId === null) return fallback();
      const material = await loadMaterial(accountId);
      // fail-closed：材料缺失时给出"无家族域"的空视图——resolveCurrentAccountAccess 对
      // 任何 family 都判负（凭据不可用），绝不回落主账号材料（防串号，spec §4）。
      if (!material) {
        // fail-closed 空视图：resolveCurrentAccountAccess 对任何 family 都判负（凭据不可用），
        // 绝不回落主账号材料（防串号，spec §4）。
        return { providerFamilyDomain: null, selections: {}, unresolvedFamilies: [] };
      }
      return {
        providerFamilyDomain: material.family,
        selections: material.selections,
        unresolvedFamilies: [],
      };
    },
  };
}

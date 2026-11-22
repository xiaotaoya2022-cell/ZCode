// [OmniCode] 模式二 R2 预留：bridge-proxy 附加账号材料的 main↔Host 请求/应答契约
// （spec: docs/omnicode/multi-account-sessions.md §5）。R1.5 只定义协议类型与 main 侧
// 路由占位（缺省处理者回结构化失败应答，先例同款 shared-asset-fetch）；实接——管理器
// 用批次3 读取链解密其他 profile 的 credentials.json 并代理应答、实例内存短 TTL 缓存
// （不落盘不进日志）——属 R2。
//
// 传输形态约定：
// - 请求只带 accountId（与 omnicode-accounts/<id>.json 文件名同一形态约束，防串号）。
// - 应答 ok=true 时 dataBase64 = 解密后的账号材料 JSON（OmniCode 仓 services 侧
//   omnicodeAccountMaterialFileSchema 同构形状）的 UTF-8 base64；Host 侧按该 schema
//   二次校验（纵深防御），校验失败按材料缺失 fail-closed，绝不回落主账号材料。
// - 材料不落盘不进日志（spec §5 红线）；R1.5 的 local 来源不经本消息（Host 直读本地
//   文件，见 services omnicode/accountMaterialFile.ts）。
import { z } from "zod";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

/** host → main：请求某附加账号的凭据材料（bridge-proxy 来源；accountId 形态与本地账号库一致）。 */
export const omnicodeAccountMaterialRequestPayloadSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/u, "accountId 形态非法"),
  })
  .strict();
export type OmnicodeAccountMaterialRequestPayload = z.infer<
  typeof omnicodeAccountMaterialRequestPayloadSchema
>;

/** main → host 应答：ok=false（桥未连/管理器不可用/账号不存在/解密失败）时只带结构化错误。 */
export const omnicodeAccountMaterialResultPayloadSchema = z
  .object({
    ok: z.boolean(),
    /** 解密后的账号材料 JSON（omnicodeAccountMaterialFileSchema 同构形状）的 UTF-8 base64。 */
    dataBase64: z.string().max(1024 * 1024).optional(),
    error: z.string().max(200).optional(),
  })
  .strict();
export type OmnicodeAccountMaterialResultPayload = z.infer<
  typeof omnicodeAccountMaterialResultPayloadSchema
>;

// ─── [OmniCode] 模式二 R2：附加账号材料快照形状（唯一事实源） ───
// R1 把该 schema 定义在 services 侧 accountOverride.ts；R2 落地 bridge-proxy 来源后，
// main（管理器解密代理）与 Host（二次校验）都要按同一形状作答——下沉到本 shared 契约
// 文件（架构 policy omnicode-account-material-shared-shape 已准入的精确路径），services
// 侧经 accountOverride.ts 原名再导出（R1 公共面不变）。字段形状与官方
// OAuthAccountMaterial/OAuthStartPlanMaterial 结构兼容（读取侧按官方类型收口）。

const providerFamilyEnum = z.enum(["zai", "bigmodel"]);
const oauthAccountMaterialBaseShape = {
  family: providerFamilyEnum,
  loginProvider: z.string().min(1),
  zcodeUserId: z.string().min(1),
  sessionRevision: z.string().nullable(),
  accountIdentity: z.string().min(1),
  zcodeJwtToken: z.string().nullable(),
};

/** omnicode-accounts/<accountId>.json（或 bridge-proxy 应答 dataBase64）解密后的校验 schema。 */
export const omnicodeAccountMaterialFileSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/u, "accountId 形态非法"),
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

/** 材料快照文件数据（schema 推断）。 */
export type OmnicodeAccountMaterialFileData = z.infer<typeof omnicodeAccountMaterialFileSchema>;

// ─── [OmniCode] 模式二 R3：附加账号目录 / 槽位 元数据契约（无凭据红线） ───
// renderer（选择器账号层 + 任务徽标）与 Host 调度器（智能挑选候选）都需要附加账号的
// **元数据**列表。两类消费者共用同一形状事实源（本文件）；与 R1.5 材料契约同风格：
// 严格 zod、载荷只带键名/显示名/family 等**非凭据**字段——deviceMid、任何 token/JWT/材料
// 内容永不进入本契约（spec §5 红线"材料永不进 renderer/日志"）。

const omnicodeAccountFamilyEnum = z.enum(["zai", "bigmodel"]);

/** 附加账号目录条目（元数据 only；accountId = acct-<sourceProfileId>，与材料请求同形态）。 */
export const omnicodeAccountDirectoryEntrySchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/u, "accountId 形态非法"),
    sourceProfileId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^p[0-9a-z]{8,20}$/u, "sourceProfileId 形态非法"),
    family: omnicodeAccountFamilyEnum,
    displayName: z.string().min(1).max(200),
  })
  .strict();
export type OmnicodeAccountDirectoryEntry = z.infer<typeof omnicodeAccountDirectoryEntrySchema>;

/** 目录查询请求载荷（桥上行 / Host→main 同形；无参数——请求方身份由通道认证）。 */
export const omnicodeAccountDirectoryListRequestPayloadSchema = z.object({}).strict();
export type OmnicodeAccountDirectoryListRequestPayload = z.infer<
  typeof omnicodeAccountDirectoryListRequestPayloadSchema
>;

/**
 * 目录查询应答载荷（ok=false 时只带结构化错误键；accounts 条目数上限 32 防桥载荷放大）。
 * 条目结构在此只做传输层装框（unknown record），**逐条严格校验在消费方**（Host 提供者 /
 * 实例目录客户端按 omnicodeAccountDirectoryEntrySchema 逐条校验后入缓存/renderer）——
 * 单个坏 profile 不应让整份目录失效。
 */
export const omnicodeAccountDirectoryListResultPayloadSchema = z
  .object({
    ok: z.boolean(),
    accounts: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
    error: z.string().max(200).optional(),
  })
  .strict();
export type OmnicodeAccountDirectoryListResultPayload = z.infer<
  typeof omnicodeAccountDirectoryListResultPayloadSchema
>;

/** 单账号槽位用量（调度器计数快照；running/limit 为非负整数，上限字段与 spec §6 可配上限一致）。 */
export const omnicodeAccountSlotUsageSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/u, "accountId 形态非法"),
    running: z.number().int().min(0).max(10_000),
    limit: z.number().int().min(0).max(10_000),
  })
  .strict();
export type OmnicodeAccountSlotUsage = z.infer<typeof omnicodeAccountSlotUsageSchema>;

/** 槽位用量查询应答载荷（调度器计数快照，元数据 only；ok=false 只带结构化错误键）。 */
export const omnicodeAccountSlotsResultPayloadSchema = z
  .object({
    ok: z.boolean(),
    slots: z.array(omnicodeAccountSlotUsageSchema).max(64).optional(),
    error: z.string().max(200).optional(),
  })
  .strict();
export type OmnicodeAccountSlotsResultPayload = z.infer<
  typeof omnicodeAccountSlotsResultPayloadSchema
>;

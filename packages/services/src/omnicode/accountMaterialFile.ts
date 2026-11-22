// [OmniCode] 模式二：附加账号材料本地文件提供者（spec:
// docs/omnicode/multi-account-sessions.md §5）。
//
// 存储形态与官方 credentials.json 同构：omnicode-accounts/<accountId>.json =
// credentialRecordSchema 形状的 KV（值 = 逐字段 JSON 序列化后经
// createSystemCredentialCipher({filePath}) 加密）——实例数据根内、实例固化密钥可解，
// Host 进程与实例 main 进程均可直读（无跨进程管道，R1 端到端闭合）。
//
// 写入侧（谁生产这个文件）：R2/R3 接登录捕获/管理器导出；本模块提供 write 助手供
// 生产者与测试共用。读取侧 fail-closed：文件缺失/损坏/schema 不符 → null（绝不回落）。
// 任何错误路径不得把材料内容写进日志（红线沿用凭据链 redaction 约定）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSystemCredentialCipher, type SystemCredentialCipher } from "@zcode/shared/credential-security";
import { credentialRecordSchema } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import {
  omnicodeAccountMaterialFileSchema,
  type OmnicodeAccountMaterialProvider,
  type OmnicodeAccountOverrideMaterial,
} from "./accountOverride.js";

const ACCOUNTS_DIRNAME = "omnicode-accounts";

export function resolveOmnicodeAccountsDir(baseDir?: string): string {
  return baseDir ?? join(getAppConfigDir(), ACCOUNTS_DIRNAME);
}

export function resolveOmnicodeAccountMaterialFilePath(accountId: string, baseDir?: string): string {
  return join(resolveOmnicodeAccountsDir(baseDir), `${accountId}.json`);
}

type CipherFactory = (filePath: string) => Pick<SystemCredentialCipher, "encrypt" | "decrypt">;

export interface OmnicodeAccountFileMaterialOptions {
  /** 账号库根目录（测试注入；缺省 = <dataRoot>/v2/omnicode-accounts）。 */
  accountsDir?: string;
  readFile?: typeof readFile;
  writeFile?: typeof writeFile;
  mkdir?: typeof mkdir;
  createCipher?: CipherFactory;
  cacheTtlMs?: number;
  now?: () => number;
}

/** 把材料快照写成加密 KV 文件（R2/R3 生产者与测试共用；返回文件路径）。 */
export async function writeOmnicodeAccountMaterialFile(
  material: OmnicodeAccountOverrideMaterial,
  options: OmnicodeAccountFileMaterialOptions = {},
): Promise<string> {
  const filePath = resolveOmnicodeAccountMaterialFilePath(material.accountId, options.accountsDir);
  const createCipher = options.createCipher ?? ((p: string) => createSystemCredentialCipher({ filePath: p }));
  const cipher = createCipher(filePath);
  const record: Record<string, string> = {};
  const fields: Array<[string, unknown]> = [
    ["accountId", material.accountId],
    ["family", material.family],
    ["selections", material.selections],
    ["accountIdentity", material.accountIdentity],
    ["startPlanMaterial", material.startPlanMaterial],
    ["familyMaterial", material.familyMaterial],
    ["deviceMid", material.deviceMid],
  ];
  for (const [key, value] of fields) {
    record[key] = await cipher.encrypt(JSON.stringify(value));
  }
  const write = options.writeFile ?? writeFile;
  const mkdirFn = options.mkdir ?? mkdir;
  await mkdirFn(dirname(filePath), { recursive: true });
  await write(filePath, JSON.stringify(record), "utf8");
  return filePath;
}

/**
 * 本地文件材料提供者（OmnicodeAccountMaterialProvider 实现）。
 * 每账号短 TTL 缓存（与 resolver 覆盖边界同语义：现取 + 兜底，不追刷新写回）。
 */
export function createOmnicodeAccountFileMaterialProvider(
  options: OmnicodeAccountFileMaterialOptions = {},
): OmnicodeAccountMaterialProvider {
  const readFileFn = options.readFile ?? readFile;
  const createCipher = options.createCipher ?? ((p: string) => createSystemCredentialCipher({ filePath: p }));
  const now = options.now ?? (() => Date.now());
  const ttl = options.cacheTtlMs ?? 60_000;
  const cache = new Map<string, { value: OmnicodeAccountOverrideMaterial | null; expiresAt: number }>();

  const loadUncached = async (accountId: string): Promise<OmnicodeAccountOverrideMaterial | null> => {
    const filePath = resolveOmnicodeAccountMaterialFilePath(accountId, options.accountsDir);
    let raw: string;
    try {
      raw = await readFileFn(filePath, "utf8");
    } catch {
      // ENOENT/权限/IO 一律按"材料缺失"收口（fail-closed），不区分错误细节给上游。
      return null;
    }
    try {
      const record = credentialRecordSchema.parse(JSON.parse(raw));
      const cipher = createCipher(filePath);
      const decoded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        decoded[key] = JSON.parse(await cipher.decrypt(value));
      }
      const parsed = omnicodeAccountMaterialFileSchema.parse(decoded);
      // accountId 与文件名一致校验（防串号：文件内容声称的账号必须与请求键一致）。
      if (parsed.accountId !== accountId) return null;
      return {
        accountId: parsed.accountId,
        family: parsed.family,
        selections: parsed.selections,
        accountIdentity: parsed.accountIdentity,
        // 字段形状已由 schema 校验；此处按官方材料类型收口（loginProvider 等联合类型收窄）。
        startPlanMaterial: parsed.startPlanMaterial as OmnicodeAccountOverrideMaterial["startPlanMaterial"],
        familyMaterial: parsed.familyMaterial as OmnicodeAccountOverrideMaterial["familyMaterial"],
        deviceMid: parsed.deviceMid,
      };
    } catch {
      // 损坏/解密失败/schema 不符：fail-closed 且不写日志（材料内容永不入日志）。
      return null;
    }
  };

  return {
    async load(accountId) {
      const cached = cache.get(accountId);
      if (cached && cached.expiresAt > now()) return cached.value;
      const value = await loadUncached(accountId);
      cache.set(accountId, { value, expiresAt: now() + ttl });
      return value;
    },
  };
}

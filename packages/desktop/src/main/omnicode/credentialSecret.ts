// [OmniCode] 凭据密钥固化（Cockpit ZCODE_CREDENTIAL_SECRET 不变量移植，用户拍板
// "环境隔离"根治方案）：为每个 OmniCode 数据根显式固化独立凭据密钥文件。
//
// 背景（互踩机制实证）：官方 v3.18.0 凭据密钥存 OS keyring（Windows 凭据管理器），
// entry 按凭据文件路径哈希区分，且解密时强制"密文来源标记 == 当前密钥来源"
// （systemCredentialCipher.ts:276 source 不一致直接 unavailable）。omni.5 共享
// ~/.zcode 时期，官方产品与 OmniCode 双双对同一路径的 keyring entry 做过迁移写入
// （各自生成随机密钥互相覆盖）→ 一边活动重写密钥 → 另一边全部密文解不开 →
// 双向互换报 credential unavailable。路径分库（omni.1）后新 entry 独立，但 keyring
// 层的历史污染与平台不稳定性仍是隐患。
//
// 根治：数据根内固化 credential-secret 文件（43 字符 base64url 随机密钥，首次生成
// 永不变），注入 ZCODE_CREDENTIAL_SECRET → 官方加密器 getKey 直接采用 env 密钥
// （source="env"，systemCredentialCipher.ts:197-198），完全绕过 OS keyring——
// 互踩通道物理消除；密钥文件可随凭据备份一起回滚（密钥+密文=完整快照）。
//
// 兼容性：
// - Profile 实例凭据为 legacy 格式（enc:v1:）：legacyKeyCandidates 的 fallback
//   （真实 home 派生）仍在候选列表——legacy 密文无缝可解，无需重登；
// - 主实例凭据若已迁移为 os 格式（enc:v2:os:）：切换后 source 不匹配解不出——
//   主实例需重新登录一次（一次性成本），之后永久稳定；
// - 官方 ZCode 零影响（其进程无本 env，继续走自己的 keyring）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const SECRET_FILE_NAME = "credential-secret";
const SECRET_BYTES = 32;

/**
 * 确保 dataRoot 下存在固化的凭据密钥文件并返回其内容（base64url，43 字符）。
 * 文件已存在且格式合法则原样返回（永不变）；不存在则生成（随机、一次性）。
 * 任何失败返回空串（调用方不注入，回退官方默认派生行为——fail-open）。
 */
export function ensureOmnicodeCredentialSecret(dataRoot: string): string {
  const secretPath = join(dataRoot, ".zcode", "v2", SECRET_FILE_NAME);
  try {
    if (existsSync(secretPath)) {
      const value = readFileSync(secretPath, "utf8").trim();
      if (value.length >= 32 && value.length <= 4096) return value;
      // 格式非法（手改/损坏）：重新生成覆盖，避免永久卡死在坏密钥上
      console.warn(`[omnicode] 凭据密钥文件格式非法，重新生成: ${secretPath}`);
    }
    const value = randomBytes(SECRET_BYTES).toString("base64url");
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, value, "utf8");
    console.info(`[omnicode] 凭据密钥已固化: ${secretPath}`);
    return value;
  } catch (error) {
    console.warn("[omnicode] 凭据密钥文件读写失败（回退官方默认派生）:", error);
    return "";
  }
}

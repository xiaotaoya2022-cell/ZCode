/**
 * [OmniCode] 实例专属登录浏览器：授权 URL 形状识别与实例身份判定（纯函数，shared 层）。
 * spec: docs/omnicode/instance-login-browser.md（renderer 不感知，仅 main 消费；放 shared
 * 以便后续手动粘贴恢复入口在 renderer 侧复用同一形状规则）。
 * 批次2 B2-1 增补进程模式判据（spec profile-runtime.md §批次2：进程模式与身份 D7）：
 * 实例 = OMNICODE_PROFILE_ID 过白名单；管理器 = omnicode flavor ∧ 无实例身份；
 * 官方 flavor（production/preview）永远不落入两种 omnicode 模式。
 */

const OMNICODE_PROFILE_ID_PATTERN = /^p[0-9a-z]{8,20}$/u;

/** 当前进程是否为 Profile 实例身份（由 profileBootstrap 在最早导入点注入 env）。 */
export function isOmnicodeProfileInstanceEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const profileId = env.OMNICODE_PROFILE_ID?.trim() ?? "";
  return OMNICODE_PROFILE_ID_PATTERN.test(profileId);
}

/**
 * [OmniCode] 批次2 B2-1：从 env 解析本进程的实例 id（过白名单才认；空/非法归一为 null）。
 * renderer 侧经 preload 暴露的同名通道取值（preload 与 renderer 进程共享 main 注入的 env）。
 */
export function resolveOmnicodeInstanceIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const profileId = env.OMNICODE_PROFILE_ID?.trim() ?? "";
  return OMNICODE_PROFILE_ID_PATTERN.test(profileId) ? profileId : null;
}

/**
 * [OmniCode] 批次2 B2-1：管理器模式判据（spec §1 进程模型不变式）。
 * 管理器 = omnicode flavor ∧ argv/env 无实例身份。官方 flavor 恒为 false
 * （官方行为零影响的门控基点：一切管理器分流都以此为前置条件）。
 * flavor 是编译期常量字符串（ZCODE_PRODUCT_FLAVOR），由调用方传入以保持纯函数可测。
 */
export function isOmnicodeManagerProcess(
  flavor: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flavor === "omnicode" && resolveOmnicodeInstanceIdFromEnv(env) === null;
}

export function isOmnicodeProfileId(value: string): boolean {
  return OMNICODE_PROFILE_ID_PATTERN.test(value);
}

/**
 * OAuth 授权 URL 形状（与 cockpit-tools is_zcode_callback_url 的 authorize 侧检查同源）：
 * - ZAI:  https://chat.z.ai/api/oauth/authorize?…
 * - BigModel: https://bigmodel.cn/login?appId=zcode…
 * 命中即表示该 openExternal 调用是"发起 OAuth 登录"，实例身份下应改走内置授权窗口。
 */
export function isOmnicodeAuthorizeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "chat.z.ai" && parsed.pathname === "/api/oauth/authorize") return true;
  if (host.endsWith("bigmodel.cn") && parsed.pathname === "/login") return true;
  return false;
}

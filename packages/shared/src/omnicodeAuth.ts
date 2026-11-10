/**
 * [OmniCode] 实例专属登录浏览器：授权 URL 形状识别与实例身份判定（纯函数，shared 层）。
 * spec: docs/omnicode/instance-login-browser.md（renderer 不感知，仅 main 消费；放 shared
 * 以便后续手动粘贴恢复入口在 renderer 侧复用同一形状规则）。
 */

const OMNICODE_PROFILE_ID_PATTERN = /^p[0-9a-z]{8,20}$/u;

/** 当前进程是否为 Profile 实例身份（由 profileBootstrap 在最早导入点注入 env）。 */
export function isOmnicodeProfileInstanceEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const profileId = env.OMNICODE_PROFILE_ID?.trim() ?? "";
  return OMNICODE_PROFILE_ID_PATTERN.test(profileId);
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

// [OmniCode] Profile 实例身份引导 —— 必须是 main 的第一个副作用导入。
// spec: docs/omnicode/profile-runtime.md
// 职责：解析实例身份来源（argv `--omnicode-profile=<id>`，控制台 spawn 时与 env 一次
// 性同步注入），并在任何官方早期模块（均在导入期读 env）之前把身份 env 五件套写入
// 自身 process.env（自派生重赋值覆盖，与 spawn 注入双保险、产出一致）。
//
// 安全边界（决策 D6：身份通道 = 一次 spawn 的 argv + env 原子注入）：
// - profileId 过白名单正则（生成器形态，兼作目录穿越防护），无敏感语义；
// - 无跨进程文件握手（一次性 handoff 文件已退役：它在 relaunch 重放与消费竞态下
//   不可靠——文件读取即删后退出登录触发 relaunch 会原样重放已消费的旗标，身份丢失）；
// - 带身份旗标的进程若解析不到合法 profileId 必须 process.exit(1) 快速失败：
//   裸进程会与主实例共用 userData → 抢单实例锁聚焦主窗口 + 数据根回落 + 登录走
//   系统浏览器，比显式失败危险得多，绝不允许静默裸奔。
// 约束：本模块只做同步的小 IO（身份注入 + setting sanitize 写回）；不导入 electron；不依赖网络。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ensureOmnicodeCredentialSecret } from "./credentialSecret.js";

const PROFILE_FLAG = "--omnicode-profile=";
const CONSOLE_FLAG = "--omnicode-console";
// [OmniCode] 已退役（D6）：保留字面量检测是为了拦截"旧版本控制台 + 新版本实例"混部
// 场景——旧控制台仍带 handoff 旗标拉起时，新实例快速退出而不是静默裸奔。
const RETIRED_HANDOFF_FLAG = "--omnicode-handoff";
const PROFILE_ROOT_ENV = "OMNICODE_PROFILE_ROOT";
const PROFILE_ID_PATTERN = /^p[0-9a-z]{8,20}$/u;

function resolveProfileRoot(): string {
  const override = process.env[PROFILE_ROOT_ENV]?.trim();
  return override ? override : join(homedir(), ".omnicode", "profiles");
}

/** argv 身份旗标（首个匹配项）；返回原始旗标与剥离后的 id（空值归一为 undefined）。 */
function resolveProfileIdFromArgv(): { hasFlag: boolean; profileId?: string } {
  const raw = process.argv.find((entry) => entry.startsWith(PROFILE_FLAG));
  if (!raw) return { hasFlag: false };
  return { hasFlag: true, profileId: raw.slice(PROFILE_FLAG.length).trim() || undefined };
}

function injectIdentityEnv(profileId: string, profileDir: string): void {
  // profile 是身份唯一事实源：直接赋值（非 ??=），覆盖继承自控制台的任何同名 env
  process.env.ZCODE_DESKTOP_APPLICATION_NAME = `OmniCode-${profileId}`;
  process.env.ZCODE_DESKTOP_USER_DATA_DIR = join(profileDir, "electron-userdata");
  process.env.ZCODE_DESKTOP_SESSION_DATA_DIR = join(profileDir, "electron-session");
  process.env.ZCODE_DATA_BASE_DIR = profileDir;
  // [OmniCode] 第五件套（D6 修订）：ZCODE_DESKTOP_HOME_DIR = profileDir。
  // 消费面 1：services/settingService.resolveUserHomeDir 优先读该 env → 实例的
  //   setting.json 落 <profileDir>/.zcode/v2/setting.json（官方 lastActiveWorkspace
  //   等 settings 在实例间按实例隔离，消除与官方安装版共享 setting.json 的串流通道）。
  // 消费面 2：desktopRuntimeEnv.runtimeHomePath → index.ts app.setPath("home")，
  //   实例的 Electron home 概念指向 profileDir（预期行为：home 级别的默认目录也按
  //   实例隔离，与 Cockpit env 清单对齐——Cockpit 注入 ZCODE_DESKTOP_HOME_DIR=<root>/data）。
  // 不受影响：services 的 resolveAgentUserInstructionsHomeDir（AGENTS.md 位置）只认
  //   HOME/USERPROFILE 不认该 env → AGENTS.md 保持全局共享（合理语义）。
  process.env.ZCODE_DESKTOP_HOME_DIR = profileDir;
  // 实例自声明（供 Host 侧锁服务识别"本实例占用"）；由本进程自己设置，与 spawn
  // 注入的值一致（双保险）
  process.env.OMNICODE_PROFILE_ID = profileId;
  // [OmniCode] 凭据密钥固化（环境隔离根治方案）：Profile 数据根内固化独立密钥文件
  // 并注入 ZCODE_CREDENTIAL_SECRET → 凭据加密完全脱离 OS keyring 与 homedir 派生。
  // Profile legacy 密文无缝兼容（fallback 候选仍在 legacyKeyCandidates 列表）。
  const credentialSecret = ensureOmnicodeCredentialSecret(profileDir);
  if (credentialSecret) {
    process.env.ZCODE_CREDENTIAL_SECRET = credentialSecret;
  }
}

/**
 * [OmniCode] Cockpit sanitize_managed_setting 移植（spec §实时视窗/Cockpit 深读）：
 * 每次启动删除实例自身 setting.json 的 dataBaseDir 键——禁止实例配置把数据根引回
 * 共享目录（拷贝来的/官方 UI 写入的都可能含该键）。实例数据根由五件套 env 唯一决定，
 * 任何配置文件都不得覆盖（Cockpit 同名不变量 + 单测锁定）。
 * 同步小 IO（文件 <100KB）；任何失败 fail-open（env 注入已是兜底事实源）。
 */
function sanitizeInstanceSetting(profileDir: string): void {
  try {
    const settingPath = join(profileDir, ".zcode", "v2", "setting.json");
    if (!existsSync(settingPath)) return;
    const parsed = JSON.parse(readFileSync(settingPath, "utf8")) as Record<string, unknown>;
    if (parsed.dataBaseDir === undefined) return;
    delete parsed.dataBaseDir;
    const tempPath = `${settingPath}.sanitize.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    renameSync(tempPath, settingPath);
    console.info("[omnicode] 已清理实例 setting.json 的 dataBaseDir（防串根守卫）");
  } catch (error) {
    console.warn("[omnicode] 实例 setting.json sanitize 失败（fail-open）:", error);
  }
}

const { hasFlag: hasProfileFlag, profileId: argvProfileId } = resolveProfileIdFromArgv();
const hasHandoffFlag = process.argv.includes(RETIRED_HANDOFF_FLAG);
const hasConsoleFlag = process.argv.includes(CONSOLE_FLAG);

// [OmniCode] 快速失败（D6）：带身份旗标（--omnicode-profile / 已退役的
// --omnicode-handoff）但解析不出合法 profileId 的进程一律 process.exit(1)。
if ((hasProfileFlag || hasHandoffFlag) && (!argvProfileId || !PROFILE_ID_PATTERN.test(argvProfileId))) {
  console.error(
    `[omnicode] 实例身份旗标存在但 profileId 非法/缺失（${argvProfileId ?? "<empty>"}），快速退出（裸进程会与主实例共用 userData）`,
  );
  process.exit(1);
}

if (argvProfileId && hasConsoleFlag) {
  console.warn("[omnicode] --omnicode-profile 与 --omnicode-console 互斥，按 spec 以 profile 为准");
}

if (argvProfileId) {
  const profileDir = join(resolveProfileRoot(), argvProfileId);
  injectIdentityEnv(argvProfileId, profileDir);
  sanitizeInstanceSetting(profileDir);
  console.info(`[omnicode] profile 身份注入完成: ${argvProfileId}`);
} else if (hasConsoleFlag) {
  // 控制台身份：与官方安装版、Profile 实例的 userData 三方互斥（spec §产品规则 3）
  process.env.ZCODE_DESKTOP_APPLICATION_NAME ??= "OmniCode Console";
}

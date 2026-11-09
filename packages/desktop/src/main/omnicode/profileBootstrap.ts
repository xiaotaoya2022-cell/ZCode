// [OmniCode] Profile 实例身份引导 —— 必须是 main 的第一个副作用导入。
// spec: docs/omnicode/profile-runtime.md
// 职责：解析实例身份来源（argv `--omnicode-profile=<id>` 供手动/外部启动，或控制台
// 一次性 handoff），并在任何官方早期模块（均在导入期读 env）之前把身份 env 四件套
// 写入自身 process.env。
// 安全边界：handoff 为固定文件名（全字面量路径，无动态拼接），仅控制台拉起的实例
// （带 --omnicode-handoff 字面量旗标）消费；profileId 不进命令行、不进长期 env。
// 约束：本模块只做同步、只读的小 IO；不导入 electron；不依赖网络。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const PROFILE_FLAG = "--omnicode-profile=";
const CONSOLE_FLAG = "--omnicode-console";
const HANDOFF_LAUNCH_FLAG = "--omnicode-handoff";
const PROFILE_ROOT_ENV = "OMNICODE_PROFILE_ROOT";
const HANDOFF_DIRNAME = ".handoff";
const HANDOFF_FILENAME = "current.json";

function resolveProfileRoot(): string {
  const override = process.env[PROFILE_ROOT_ENV]?.trim();
  return override ? override : join(homedir(), ".omnicode", "profiles");
}

function resolveProfileIdFromArgv(): string | undefined {
  const raw = process.argv.find((entry) => entry.startsWith(PROFILE_FLAG));
  if (!raw) return undefined;
  return raw.slice(PROFILE_FLAG.length).trim() || undefined;
}

/** 一次性 handoff：仅控制台拉起的实例（带 --omnicode-handoff 字面量旗标）消费，读取即删。 */
function resolveProfileIdFromHandoff(): string | undefined {
  if (!process.argv.includes(HANDOFF_LAUNCH_FLAG)) return undefined;
  const handoffPath = join(resolveProfileRoot(), HANDOFF_DIRNAME, HANDOFF_FILENAME);
  try {
    if (!existsSync(handoffPath)) {
      console.error("[omnicode] handoff 文件不存在（可能已被消费）");
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(handoffPath, "utf8")) as {
      profileId?: string;
    };
    const profileId = parsed.profileId?.trim();
    rmSync(handoffPath, { force: true });
    return profileId || undefined;
  } catch (error) {
    console.error("[omnicode] handoff 读取失败:", error);
    return undefined;
  }
}

function injectIdentityEnv(profileId: string, profileDir: string): void {
  // profile 是身份唯一事实源：直接赋值（非 ??=），覆盖继承自控制台的任何同名 env
  process.env.ZCODE_DESKTOP_APPLICATION_NAME = `OmniCode-${profileId}`;
  process.env.ZCODE_DESKTOP_USER_DATA_DIR = join(profileDir, "electron-userdata");
  process.env.ZCODE_DESKTOP_SESSION_DATA_DIR = join(profileDir, "electron-session");
  process.env.ZCODE_DATA_BASE_DIR = profileDir;
  // 实例自声明（供 Host 侧锁服务识别"本实例占用"）；由本进程自己设置，不经 spawn 通道
  process.env.OMNICODE_PROFILE_ID = profileId;
}

const argvProfileId = resolveProfileIdFromArgv();
const handoffProfileId = resolveProfileIdFromHandoff();
const profileId = argvProfileId ?? handoffProfileId;
const hasConsoleFlag = process.argv.includes(CONSOLE_FLAG);

if (profileId && hasConsoleFlag) {
  console.warn("[omnicode] --omnicode-profile 与 --omnicode-console 互斥，按 spec 以 profile 为准");
}

if (profileId) {
  if (!/^p[0-9a-z]{8,20}$/u.test(profileId)) {
    console.error(`[omnicode] 非法 profileId，忽略身份注入: ${profileId}`);
  } else {
    injectIdentityEnv(profileId, join(resolveProfileRoot(), profileId));
    console.info(`[omnicode] profile 身份注入完成: ${profileId}`);
  }
} else if (hasConsoleFlag) {
  // 控制台身份：与官方安装版、Profile 实例的 userData 三方互斥（spec §产品规则 3）
  process.env.ZCODE_DESKTOP_APPLICATION_NAME ??= "OmniCode Console";
}

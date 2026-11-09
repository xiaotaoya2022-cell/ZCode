// [OmniCode] Profile 实例编排：spawn/stop/运行态（运行态唯一所有者，spec §产品规则 7）。
// 文件事实源在 ./profileRuntime.ts；本模块只持有内存运行态，进程退出即重建。
//
// 安全边界（spec §产品规则 8）：
// - renderer 侧 profileId 入口过白名单正则（assertValidProfileId）；
// - profileId 不进命令行、不进子进程 env：身份经固定路径 handoff 文件传递
//   （`<profileRoot>/.handoff/current.json`），子进程用 `--omnicode-handoff` 字面量
//   旗标声明自己是控制台拉起、有权消费该文件；
// - spawn 参数 = 字面量旗标 + appPath（app.getAppPath() 内部 API），不覆盖子进程 env；
// - 停止 = child.kill() 硬停（优雅停机随 M2 实例控制通道落地）。
// 并发（spec §并发与竞态）：launch 单飞 + 全局启动串行链（上一 handoff 被消费后下一次才写）。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { app } from "electron";
import { assertValidProfileId, getOmnicodeProfileDir, getOmnicodeProfileRoot } from "./profileRuntime.js";
// [OmniCode] 桥接服务直接从实现文件导入：经 contract.ts 会与本文件形成导出循环
import { ensureOmnicodeInstanceBridgeServerStarted } from "./instanceBridgeServer.js";

export interface OmnicodeRunningInstance {
  profileId: string;
  pid: number;
  startedAt: string;
}

interface RunningEntry extends OmnicodeRunningInstance {
  child: ChildProcess;
}

const runningByProfileId = new Map<string, RunningEntry>();
const launchInFlightByProfileId = new Map<string, Promise<number>>();
let launchChain: Promise<unknown> = Promise.resolve();

export function isOmnicodeProfileRunning(profileId: string): boolean {
  return runningByProfileId.has(profileId);
}

export function getOmnicodeRunningInstance(profileId: string): OmnicodeRunningInstance | undefined {
  const entry = runningByProfileId.get(profileId);
  return entry ? { profileId: entry.profileId, pid: entry.pid, startedAt: entry.startedAt } : undefined;
}

export function listOmnicodeRunningInstances(): OmnicodeRunningInstance[] {
  return [...runningByProfileId.values()].map(({ profileId, pid, startedAt }) => ({
    profileId,
    pid,
    startedAt,
  }));
}

export function launchOmnicodeProfile(profileId: string): Promise<number> {
  assertValidProfileId(profileId);
  const inFlight = launchInFlightByProfileId.get(profileId);
  if (inFlight) return inFlight; // 单飞：双击/并发点击合并为一次启动（spec §并发与竞态）
  const existing = runningByProfileId.get(profileId);
  if (existing) return Promise.resolve(existing.pid); // 已运行幂等返回
  const pending = launchChain.then(
    () => doLaunch(profileId),
    () => doLaunch(profileId), // 前一次失败不阻断后续启动
  );
  launchInFlightByProfileId.set(profileId, pending);
  launchChain = pending.catch(() => undefined);
  void pending.finally(() => launchInFlightByProfileId.delete(profileId));
  return pending;
}

async function doLaunch(profileId: string): Promise<number> {
  const profileDir = getOmnicodeProfileDir(profileId);
  await mkdir(join(profileDir, "electron-userdata"), { recursive: true });
  await mkdir(join(profileDir, "electron-session"), { recursive: true });

  // [OmniCode] M2：桥接服务就绪后再启动实例（handoff 携带回连端口/token）
  const bridge = await ensureOmnicodeInstanceBridgeServerStarted();
  // 一次性 handoff：固定文件名（全字面量路径）；实例 bootstrap 凭
  // --omnicode-handoff 旗标消费（读取即删）
  const handoffPath = join(getOmnicodeProfileRoot(), ".handoff", "current.json");
  await mkdir(join(getOmnicodeProfileRoot(), ".handoff"), { recursive: true });
  await writeFile(
    handoffPath,
    JSON.stringify({
      profileId,
      bridgePort: bridge.port,
      bridgeToken: bridge.token,
      issuedAt: new Date().toISOString(),
    }),
    "utf8",
  );

  // packaged：execPath 即应用本体；开发态：electron.exe + appPath（与 dev:desktop 等价）。
  // 参数只有内部 API 的 appPath 与字面量旗标，不覆盖子进程 env（spec §产品规则 8）。
  const appPath = app.isPackaged ? undefined : app.getAppPath();
  const args = appPath ? [appPath, "--omnicode-handoff"] : ["--omnicode-handoff"];
  const child = spawn(process.execPath, args, {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  if (!pid) {
    child.kill();
    rmSync(handoffPath, { force: true });
    throw new Error("[omnicode] 实例进程启动失败（未获得 pid）");
  }
  const entry: RunningEntry = { profileId, pid, startedAt: new Date().toISOString(), child };
  child.once("exit", () => {
    const current = runningByProfileId.get(profileId);
    if (current?.pid === pid) runningByProfileId.delete(profileId);
  });
  child.once("error", (error) => {
    console.error("[omnicode] 实例进程错误:", error);
    runningByProfileId.delete(profileId);
  });
  runningByProfileId.set(profileId, entry);
  // 串行化下一次 launch：等子进程消费 handoff（bootstrap 首个导入即读即删）
  void waitForHandoffConsumed(handoffPath, 15_000);
  return pid;
}

export async function stopOmnicodeProfile(profileId: string): Promise<void> {
  assertValidProfileId(profileId);
  const entry = runningByProfileId.get(profileId);
  if (!entry) return;
  const { child } = entry;
  // M1：硬停。优雅停机（WM_CLOSE → 官方 appShutdownPolicy）需要 taskkill 或实例侧
  // 控制通道，随 M2 视窗编排落地（spec §产品规则 4）。
  child.kill();
  await waitForExit(child, 5_000);
}

/** 控制台启动时清理崩溃残留的 handoff 文件（下次 launch 会覆盖，仅为整洁）。 */
export function cleanupStaleHandoff(): void {
  try {
    const handoffPath = join(getOmnicodeProfileRoot(), ".handoff", "current.json");
    if (existsSync(handoffPath)) {
      rmSync(handoffPath, { force: true });
      console.info("[omnicode] 清理残留 handoff 文件");
    }
  } catch (error) {
    console.warn("[omnicode] 清理 handoff 失败:", error);
  }
}

async function waitForHandoffConsumed(handoffPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(handoffPath)) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  console.warn("[omnicode] 等待 handoff 消费超时（实例可能启动失败）");
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

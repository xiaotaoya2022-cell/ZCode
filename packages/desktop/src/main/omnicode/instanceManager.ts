// [OmniCode] Profile 实例编排：spawn/stop/运行态（运行态唯一所有者，spec §产品规则 7）。
// 文件事实源在 ./profileRuntime.ts；本模块只持有内存运行态，进程退出即重建。
//
// 安全边界（spec §产品规则 8，决策 D6：身份通道 = 一次 spawn 的 argv + env 原子注入）：
// - renderer 侧 profileId 入口过白名单正则（assertValidProfileId）；
// - 实例身份经 spawn 一次性同步注入：argv `--omnicode-profile=<id>` + env（数据根/
//   Chromium 存储/桥接回连）。profileId 只允许生成器形态（白名单正则 + 目录穿越防护，
//   无敏感语义），bridge port/token 为父进程自产的白名单格式；一次 spawn 原子注入
//   无跨进程文件握手（一次性 handoff 文件已退役：它存在"读取即删 vs relaunch 原样
//   重放"与"非原子写 vs 读后删"两类竞态，且退出登录 relaunch 后身份丢失——见 spec D6）；
// - spawn 一律 argv 数组直传、禁用 shell 拼接；实例子进程 bootstrap 仍独立校验并
//   快速失败（双保险）。
// 并发（spec §并发与竞态）：launch 单飞 + 全局启动串行链，屏障 = 上一实例「启动确认」
// 完成（成功或失败都 settle 后才进下一次 doLaunch，串行链因此是真串行而非毫秒级假串行）。
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { app, screen } from "electron";
import {
  assertValidProfileId,
  clearProfileLaunched,
  getOmnicodeProfileDir,
  recordProfileLaunched,
} from "./profileRuntime.js";
import { scanOmnicodeInstanceProcesses } from "./instanceReconcile.js";
// [OmniCode] 桥接服务直接从实现文件导入：经 contract.ts 会与本文件形成导出循环
import { ensureOmnicodeInstanceBridgeServerStarted, sendOmnicodeInstanceCommand } from "./instanceBridgeServer.js";

export interface OmnicodeRunningInstance {
  profileId: string;
  pid: number;
  startedAt: string;
}

interface RunningEntry extends OmnicodeRunningInstance {
  /**
   * 本会话 spawn 的 child 句柄（exit/error 监听 + 运行态自清理）。
   * 控制台重启后 reconcile 重建的条目没有句柄（child: undefined）——这类条目的
   * stop/focus/arrange 全部 pid/桥驱动（P1-7 stopByPid 已不依赖句柄），实例自身
   * 退出时的运行态清理由 list 时的存活校验与下一次 reconcile 兜底。
   */
  child?: ChildProcess;
}

const runningByProfileId = new Map<string, RunningEntry>();
const launchInFlightByProfileId = new Map<string, Promise<number>>();
let launchChain: Promise<unknown> = Promise.resolve();

const PROFILE_FLAG_PREFIX = "--omnicode-profile=";
/** 桥接 token 白名单（与实例侧 startOmnicodeInstanceBridgeClient 校验同形）。 */
const BRIDGE_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
/** 启动确认稳定窗口（spec §接口 launch）：窗口内未退出即视为启动成功。 */
const BOOT_CONFIRM_WINDOW_MS = 750;
/** 三段式优雅停第一段（WM_CLOSE/SIGTERM）等待窗口。 */
const GRACEFUL_STOP_TIMEOUT_MS = 2_000;
/** 三段式优雅停第二段（强杀）等待窗口。 */
const FORCE_STOP_TIMEOUT_MS = 2_000;
/** 存活轮询节奏（Windows 每次 tasklist 子进程查询天然有节流效果）。 */
const STOP_POLL_INTERVAL_MS = 150;

export function isOmnicodeProfileRunning(profileId: string): boolean {
  return runningByProfileId.has(profileId);
}

export function getOmnicodeRunningInstance(profileId: string): OmnicodeRunningInstance | undefined {
  const entry = runningByProfileId.get(profileId);
  return entry ? { profileId: entry.profileId, pid: entry.pid, startedAt: entry.startedAt } : undefined;
}

export function listOmnicodeRunningInstances(): OmnicodeRunningInstance[] {
  // reconcile 重建的条目没有 child 句柄（无 exit 监听自清理）：每次 List 对这类条目
  // 做轻量存活校验，已退出的摘除（进程已是真相源；有句柄条目由 exit 监听自清理）。
  for (const [profileId, entry] of [...runningByProfileId.entries()]) {
    if (entry.child) continue;
    void isPidAlive(entry.pid).then((alive) => {
      if (!alive && runningByProfileId.get(profileId) === entry) {
        runningByProfileId.delete(profileId);
        void clearProfileLaunched(profileId).catch(() => undefined);
      }
    });
  }
  return [...runningByProfileId.values()].map(({ profileId, pid, startedAt }) => ({
    profileId,
    pid,
    startedAt,
  }));
}

/**
 * 批次1 P0-3（Cockpit"运行态真相=进程表实时扫描"）：控制台重启后重建实例运行态。
 * 扫描进程表按 `--omnicode-profile=<id>` 反查存活实例进程 → 填充运行态（child 缺省，
 * stop/focus/arrange 均 pid/桥驱动）。扫描失败保留现状（instanceReconcile 的失败
 * 语义：探测失败 ≠ 无实例）。与 profile.json 的 lastPid 提示相互独立——真相以扫描为准。
 */
export async function reconcileOmnicodeRunningInstances(): Promise<void> {
  const scanned = await scanOmnicodeInstanceProcesses();
  if (!scanned) return;
  for (const [profileId, pid] of scanned) {
    if (runningByProfileId.has(profileId)) continue;
    try {
      assertValidProfileId(profileId);
    } catch {
      continue;
    }
    runningByProfileId.set(profileId, {
      profileId,
      pid,
      startedAt: new Date().toISOString(),
    });
    console.info(`[omnicode] reconcile 重建运行态: profileId=${profileId} pid=${pid}`);
  }
}

/**
 * 启动一个 Profile 实例（spec §接口 launch）。
 * P1-4「启动=重启」：已运行实例先走三段式优雅停（P1-7）再启动，不再幂等返回现有 pid；
 * 运行中的目标在串行链内实时取，避免快照被并发 stop 清掉后误停新进程。
 * 并发：per-profile in-flight 去重 + 全局串行链（屏障 = 上一实例启动确认完成）。
 */
export function launchOmnicodeProfile(profileId: string): Promise<number> {
  assertValidProfileId(profileId);
  const inFlight = launchInFlightByProfileId.get(profileId);
  if (inFlight) return inFlight; // 单飞：双击/并发点击合并为一次启动（spec §并发与竞态）
  const pending = launchChain.then(
    () => doRestartLaunch(profileId),
    () => doRestartLaunch(profileId), // 前一次失败不阻断后续启动
  );
  launchInFlightByProfileId.set(profileId, pending);
  launchChain = pending.catch(() => undefined);
  void pending.finally(() => launchInFlightByProfileId.delete(profileId));
  return pending;
}

async function doRestartLaunch(profileId: string): Promise<number> {
  // 运行态在串行链执行时刻再取（进入链前挂起的调用可能已被并发 stop 清理）
  const entry = runningByProfileId.get(profileId);
  if (entry) {
    await stopByPid(entry.pid); // 停止失败向上抛：不进入启动（IPC → UI toast）
  }
  return doLaunch(profileId);
}

async function doLaunch(profileId: string): Promise<number> {
  assertValidProfileId(profileId); // 串行链入口已校验，防御性再校验
  const profileDir = getOmnicodeProfileDir(profileId);
  await mkdir(join(profileDir, "electron-userdata"), { recursive: true });
  await mkdir(join(profileDir, "electron-session"), { recursive: true });

  // [OmniCode] 桥接服务就绪后再启动实例（回连端口/token 经 spawn env 原子注入）
  const bridge = await ensureOmnicodeInstanceBridgeServerStarted();
  // 注入面白名单校验（spec §产品规则 8）：port 为正整数、token 为父进程自产的
  // 32 位 hex（实例侧 startOmnicodeInstanceBridgeClient 亦独立校验，双保险）
  if (!Number.isInteger(bridge.port) || bridge.port <= 0 || !BRIDGE_TOKEN_PATTERN.test(bridge.token)) {
    throw new Error("[omnicode] 桥接服务回连信息非法，拒绝启动实例");
  }

  // packaged：execPath 即应用本体；开发态：electron.exe + appPath（与 dev:desktop 等价，
  // appPath 必须是 electron.exe 的第一个参数，dev 态保持可用）。
  // 身份 = 字面量旗标 + 白名单 profileId（spec §产品规则 8 / D6）。
  const profileArg = `${PROFILE_FLAG_PREFIX}${profileId}`;
  const appPath = app.isPackaged ? undefined : app.getAppPath();
  const args = appPath ? [appPath, profileArg] : [profileArg];
  const bootLog = await openBootLog(profileDir);
  const child = spawn(process.execPath, args, {
    // [OmniCode] 身份与数据根经 env 一次性同步注入（覆盖继承的同名项）：
    // - OMNICODE_PROFILE_ID：实例自声明（Host 侧锁服务识别"本实例占用"）；
    // - ZCODE_DESKTOP_USER_DATA_DIR / SESSION_DATA_DIR：Chromium 存储按实例隔离；
    // - ZCODE_DATA_BASE_DIR：业务数据根（凭据/会话/sqlite 全部落 profile 内）；
    // - ZCODE_DESKTOP_HOME_DIR：settingService resolveUserHomeDir / app.setPath("home")
    //   的 home 概念 → setting.json 隔离到 <profileDir>/.zcode/v2/setting.json
    //   （AGENTS.md 位置只认 HOME/USERPROFILE，保持全局共享，不受此注入影响）；
    // - OMNICODE_BRIDGE_PORT / TOKEN：实例回连桥（bootstrap 同样注入、值一致，双保险）。
    // 安全性：profileId 过白名单无敏感语义，env 注入是 spawn 调用原子的参数面，
    // 没有文件握手的读写窗口，攻击面小于一次性文件方案（spec D6）。
    env: {
      ...process.env,
      OMNICODE_PROFILE_ID: profileId,
      ZCODE_DESKTOP_USER_DATA_DIR: join(profileDir, "electron-userdata"),
      ZCODE_DESKTOP_SESSION_DATA_DIR: join(profileDir, "electron-session"),
      ZCODE_DATA_BASE_DIR: profileDir,
      ZCODE_DESKTOP_HOME_DIR: profileDir,
      OMNICODE_BRIDGE_PORT: String(bridge.port),
      OMNICODE_BRIDGE_TOKEN: bridge.token,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid;
  if (!pid) {
    child.kill();
    bootLog?.close();
    throw new Error("[omnicode] 实例进程启动失败（未获得 pid）");
  }
  bootLog?.write(`\n[${new Date().toISOString()}] spawn pid=${pid}\n`);
  child.stdout?.on("data", (chunk) => bootLog?.write(chunk));
  child.stderr?.on("data", (chunk) => bootLog?.write(chunk));
  child.once("exit", (code, signal) => {
    bootLog?.close();
    const current = runningByProfileId.get(profileId);
    if (current?.pid === pid) runningByProfileId.delete(profileId);
    console.info(`[omnicode] 实例退出 profileId=${profileId} pid=${pid} code=${code ?? ""} signal=${signal ?? ""}`);
  });
  child.once("error", (error) => {
    console.error("[omnicode] 实例进程错误:", error);
    bootLog?.close();
    const current = runningByProfileId.get(profileId);
    if (current?.pid === pid) runningByProfileId.delete(profileId);
  });

  // [OmniCode] P0-2 启动确认：稳定窗口内未退出 = 成功；窗口内退出/spawn 错误 = 快速
  // 失败（带原因的 Error 经 IPC reject → UI toast，不再静默裸奔）。确认期间未登记
  // 运行态，失败无残留。
  try {
    await confirmBoot(child, pid);
  } catch (error) {
    runningByProfileId.delete(profileId);
    throw error;
  }
  runningByProfileId.set(profileId, { profileId, pid, startedAt: new Date().toISOString(), child });
  // 批次1 P0-3：持久化启动提示（lastPid/lastLaunchedAt），控制台重启后 reconcile 加速提示；
  // 失败不影响启动成功（提示非真相）
  void recordProfileLaunched(profileId, pid).catch((error) => {
    console.warn("[omnicode] lastPid 持久化失败:", error);
  });
  return pid;
}

/**
 * P0-2 启动确认：以 `exit` 事件为主判据（本进程持有 child 句柄，事件可靠），辅以
 * 窗口末的 pid 存活探针兜底 exit 事件内核级丢失的极端情形。窗口内退出 → 快速失败。
 */
function confirmBoot(child: ChildProcess, pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleOk = (): void => {
      if (settled) return;
      settled = true;
      clear();
      void isPidAlive(pid)
        .then((alive) => {
          if (alive) {
            resolve();
          } else {
            reject(new Error(`[omnicode] 实例启动确认失败：稳定窗口后 pid=${pid} 已不存在`));
          }
        })
        .catch(() => resolve()); // 探针本身异常不阻断确认（exit 事件已给出主判据）
    };
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      clear();
      reject(new Error(`[omnicode] 实例启动确认失败：${reason}`));
    };
    const timer = setTimeout(settleOk, BOOT_CONFIRM_WINDOW_MS);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      fail(`稳定窗口内进程退出（code=${code ?? "null"} signal=${signal ?? "null"}），详见 instance-boot.log`);
    };
    const onError = (error: Error): void => {
      fail(`spawn 错误 ${error.message}`);
    };
    const clear = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

interface BootLogSink {
  write: (chunk: Buffer | string) => void;
  close: () => void;
}

/** P0-2 启动日志落盘：追加模式 `<profileDir>/logs/instance-boot.log`；fail-safe（失败仅告警）。 */
async function openBootLog(profileDir: string): Promise<BootLogSink | undefined> {
  try {
    const logsDir = join(profileDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const stream = createWriteStream(join(logsDir, "instance-boot.log"), { flags: "a" });
    stream.on("error", (error) => {
      console.warn("[omnicode] instance-boot.log 写入失败:", error);
    });
    return {
      write: (chunk) => stream.write(chunk),
      close: () => stream.end(),
    };
  } catch (error) {
    console.warn("[omnicode] 打开 instance-boot.log 失败（实例诊断日志停用）:", error);
    return undefined;
  }
}

/** 三段式优雅停（spec §产品规则 4）：Windows WM_CLOSE→强杀；unix SIGTERM→SIGKILL。 */
export async function stopOmnicodeProfile(profileId: string): Promise<void> {
  assertValidProfileId(profileId);
  const entry = runningByProfileId.get(profileId);
  if (!entry) return;
  // P1-7：pid 驱动，不依赖 child 句柄（句柄只随本会话存在；pid 通道对重启过的控制台
  // 未来持久化 pid 场景同样可用）。成功后主动摘除运行态（child exit 监听兜底同值幂等）。
  await stopByPid(entry.pid);
  void clearProfileLaunched(profileId).catch(() => undefined);
}

async function stopByPid(pid: number): Promise<void> {
  sendGracefulStop(pid);
  if (await waitForPidExit(pid, GRACEFUL_STOP_TIMEOUT_MS)) {
    return;
  }
  sendForceStop(pid);
  if (await waitForPidExit(pid, FORCE_STOP_TIMEOUT_MS)) {
    return;
  }
  throw new Error(`[omnicode] 实例进程强制停止后仍残留，pid=${pid}`);
}

function sendGracefulStop(pid: number): void {
  if (process.platform === "win32") {
    // /T 结束进程树；不带 /F = 向窗口投递 WM_CLOSE（配合实例侧 appShutdownPolicy 优雅退出）
    spawn("taskkill", ["/PID", String(pid), "/T"], {
      stdio: "ignore",
      windowsHide: true,
    }).once("error", () => {
      // 目标已退出/工具异常都不阻断三段式推进，最终裁决交给存活轮询
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已退出
    }
  }
}

function sendForceStop(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).once("error", () => {
      // 同上：裁决交给轮询
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPidAlive(pid))) return true;
    await sleep(STOP_POLL_INTERVAL_MS);
  }
  return !(await isPidAlive(pid));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * pid 存活探测。Windows 用 tasklist 查询 OS 进程表（比 process.kill(pid,0) 可靠：
 * 后者会因本进程仍持有已退出子进程的句柄而误报存活）；pid 匹配用引号定界防子串误配
 * （`"123",` 不会匹配 `"12345"`；无匹配时 tasklist 输出本地化 INFO 行、无引号，不会误报）。
 * 查询失败返回 undefined → 调用方按"存活"保守处理（宁可误判残留并报错，不可谎报已停）。
 */
async function isPidAlive(pid: number): Promise<boolean> {
  const windowsVerdict = process.platform === "win32" ? await isPidAliveWindows(pid) : undefined;
  if (windowsVerdict !== undefined) return windowsVerdict;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无信号权限（仍存活）；其余（ESRCH 等）视为已退出
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isPidAliveWindows(pid: number): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const probe = spawn("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    probe.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    const onClose = (): void => {
      cleanup();
      resolve(new RegExp(`"${pid}",`).test(output));
    };
    const onError = (): void => {
      cleanup();
      resolve(undefined); // 工具不可用 → 未知，交由调用方保守处理
    };
    function cleanup(): void {
      probe.off("close", onClose);
      probe.off("error", onError);
    }
    probe.once("close", onClose);
    probe.once("error", onError);
  });
}

/**
 * 退出登录/重启流程的实例身份续接（spec §产品规则 1、决策 D6）：
 * Profile 实例进程（OMNICODE_PROFILE_ID env 存在且过白名单）relaunch 时必须显式携带
 * `--omnicode-profile=<id>`（dev 态并带 appPath 作为 electron.exe 首参），由 argv 身份
 * 通道在新进程重建身份；app.relaunch() 默认重放当前 argv 的行为虽已携带该旗标，但显式
 * 传参使身份传递行为确定性收敛，不依赖平台重放细节。非实例身份（控制台/主实例）返回
 * undefined，调用方走 app.relaunch() 默认重放。
 */
export function buildOmnicodeInstanceRelaunchArgs(): string[] | undefined {
  const profileId = process.env.OMNICODE_PROFILE_ID?.trim() ?? "";
  try {
    assertValidProfileId(profileId);
  } catch {
    return undefined;
  }
  const profileArg = `${PROFILE_FLAG_PREFIX}${profileId}`;
  // packaged 无需 appPath（execPath 即应用本体）；dev 态 appPath 是 electron.exe 首参
  return app.isPackaged ? [profileArg] : [app.getAppPath(), profileArg];
}

/** 平铺编排格间间距（spec §实时视窗 v1）。 */
const ARRANGE_GAP_PX = 8;

/**
 * M2 v1 平铺编排：全部运行中实例窗口 setBounds 到主屏 workArea 网格
 * （spec §实时视窗：cols=ceil(√n)，启动时间升序排位，控制台主窗口不动）。
 * 未连接实例不投递（与 focus 同形）；fire-and-forget，结果以缩略图画面为准。
 */
export function arrangeOmnicodeInstances(): { delivered: string[] } {
  const running = [...runningByProfileId.values()].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  if (running.length === 0) return { delivered: [] };
  const { workArea } = screen.getPrimaryDisplay();
  const count = running.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellWidth = Math.floor((workArea.width - ARRANGE_GAP_PX * (cols + 1)) / cols);
  const cellHeight = Math.floor((workArea.height - ARRANGE_GAP_PX * (rows + 1)) / rows);
  // 屏幕过小排不出实例侧最低规格（200×150）的格子：整批放弃而非投递注定被拒的命令
  if (cellWidth < 200 || cellHeight < 150) {
    console.warn("[omnicode] 编排放弃：workArea 过小，格子规格低于 200x150");
    return { delivered: [] };
  }
  const delivered: string[] = [];
  running.forEach((entry, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const bounds = {
      x: workArea.x + ARRANGE_GAP_PX + col * (cellWidth + ARRANGE_GAP_PX),
      y: workArea.y + ARRANGE_GAP_PX + row * (cellHeight + ARRANGE_GAP_PX),
      width: cellWidth,
      height: cellHeight,
    };
    if (sendOmnicodeInstanceCommand(entry.profileId, { type: "arrange", bounds })) {
      delivered.push(entry.profileId);
    }
  });
  return { delivered };
}

/** M2 v1 还原：向全部运行中实例发 restoreBounds（实例按自身基线回位，未编排实例为 no-op）。 */
export function restoreOmnicodeInstances(): { delivered: string[] } {
  const delivered: string[] = [];
  for (const entry of runningByProfileId.values()) {
    if (sendOmnicodeInstanceCommand(entry.profileId, { type: "restoreBounds" })) {
      delivered.push(entry.profileId);
    }
  }
  return { delivered };
}

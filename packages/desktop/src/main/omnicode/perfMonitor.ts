// [OmniCode] 批次2.5 X1：性能监控采样器（管理器 main，spec: docs/omnicode/console-extras.md §X1）。
//
// 数据源 = 既有 tasklist CSV 管线（instanceReconcile.readOmnicodeProcessMemoryMBs，P2-11②）
// 扩展为周期采样；CPU 列 v1 不做（tasklist 无 CPU 占用列，面板显示 —，spec 已知限制 1）。
//
// 生命周期与降级红线（spec §采样生命周期）：
// - 仅面板打开时采样：renderer 上报 OmnicodePerfState {enabled}，enabled=false 停 timer；
//   重新 enable 重置失败计数并立即采一轮（给降级后的显式重试留出口）。
// - 任一环节不可得整面板降级隐藏、绝不空转：非 win32 即刻 unavailable(platform)；tasklist
//   连续失败 ≥2 次 unavailable(probe) 并停 timer。renderer 收到 unavailable 隐藏「性能」入口。
// - 零运行实例：广播空 samples（面板显示"无运行实例"），不 spawn tasklist。
import process from "node:process";
import { BrowserWindow } from "electron";
import { PlatformChannels, type OmnicodePerfEventPayload } from "@zcode/shared";
import { listOmnicodeRunningInstances } from "./instanceManager.js";
import { readOmnicodeProcessMemoryMBs } from "./instanceReconcile.js";

/** 采样间隔（spec：≥5s）。 */
export const PERF_SAMPLE_INTERVAL_MS = 5_000;
/** tasklist 连续失败多少轮后整面板降级（spec §降级语义）。 */
export const PERF_DEGRADE_FAILURE_THRESHOLD = 2;

// ─── tick 决策（纯函数，单测登记 engineering-test-files.json） ───

/**
 * 单轮采样决策：面板关/未启用 → stop；非 win32 → degrade(platform)；零运行实例 → empty
 * （广播空 samples，不 spawn）；连续失败达阈值 → degrade(probe)；否则 sample。
 */
export function resolveOmnicodePerfTickAction(input: {
  enabled: boolean;
  platform: string;
  runningCount: number;
  consecutiveFailures: number;
}): "sample" | "empty" | "degrade-platform" | "degrade-probe" | "stop" {
  if (!input.enabled) return "stop";
  if (input.platform !== "win32") return "degrade-platform";
  if (input.consecutiveFailures >= PERF_DEGRADE_FAILURE_THRESHOLD) return "degrade-probe";
  if (input.runningCount === 0) return "empty";
  return "sample";
}

// ─── 采样器（模块态） ───

let panelEnabled = false;
let sampleTimer: NodeJS.Timeout | null = null;
let sampling = false;
let consecutiveFailures = 0;

/** [OmniCode] 推送给全部 renderer 窗口（与 instanceBridgeServer 广播同模式）。 */
function broadcastOmnicodePerfEvent(payload: OmnicodePerfEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.OmnicodePerfEvent, payload);
    }
  }
}

function stopSampler(): void {
  if (sampleTimer) {
    clearTimeout(sampleTimer);
    sampleTimer = null;
  }
}

function scheduleNextTick(delayMs: number): void {
  stopSampler();
  sampleTimer = setTimeout(() => {
    sampleTimer = null;
    void runPerfTick();
  }, delayMs);
  sampleTimer.unref?.();
}

async function runPerfTick(): Promise<void> {
  const running = listOmnicodeRunningInstances();
  const action = resolveOmnicodePerfTickAction({
    enabled: panelEnabled,
    platform: process.platform,
    runningCount: running.length,
    consecutiveFailures,
  });
  if (action === "stop") {
    stopSampler();
    return;
  }
  if (action === "degrade-platform" || action === "degrade-probe") {
    // 降级：停 timer + 广播 unavailable（renderer 隐藏入口）；保持 panelEnabled 原值——
    // 用户下次显式开关面板（enabled 重新置 true）会走 setupOmnicodePerfPanel 重试。
    stopSampler();
    broadcastOmnicodePerfEvent({
      type: "unavailable",
      reason: action === "degrade-platform" ? "platform" : "probe",
    });
    return;
  }
  if (action === "empty") {
    // 零运行实例：广播空 samples（面板显示占位），不 spawn tasklist（不空转）。
    broadcastOmnicodePerfEvent({ type: "sample", at: Date.now(), samples: [] });
    if (panelEnabled) scheduleNextTick(PERF_SAMPLE_INTERVAL_MS);
    return;
  }
  if (sampling) {
    // 上一轮 tasklist 尚未返回（慢机/大进程表）：跳过本轮，不并发 spawn。
    if (panelEnabled) scheduleNextTick(PERF_SAMPLE_INTERVAL_MS);
    return;
  }
  sampling = true;
  try {
    const pidByProfileId = new Map(running.map((entry) => [entry.profileId, entry.pid]));
    const memoryByPid = await readOmnicodeProcessMemoryMBs([...pidByProfileId.values()]);
    if (!memoryByPid) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= PERF_DEGRADE_FAILURE_THRESHOLD) {
        stopSampler();
        broadcastOmnicodePerfEvent({ type: "unavailable", reason: "probe" });
        return;
      }
    } else {
      consecutiveFailures = 0;
      const samples = [...pidByProfileId.entries()].flatMap(([profileId, pid]) => {
        const memoryMB = memoryByPid.get(pid);
        // 单实例 pid 消失（查询窗口内退出）：本轮跳过该实例，不编造部分值。
        return memoryMB !== undefined ? [{ profileId, memoryMB }] : [];
      });
      broadcastOmnicodePerfEvent({ type: "sample", at: Date.now(), samples });
    }
  } finally {
    sampling = false;
  }
  if (panelEnabled) scheduleNextTick(PERF_SAMPLE_INTERVAL_MS);
}

/**
 * 面板开关入口（desktopProfileIpc 的 OmnicodePerfState handler 调用）。
 * enabled=true：重置失败计数、立即采一轮（降级后的显式重试出口）并进入周期采样；
 * enabled=false：停 timer。
 */
export function applyOmnicodePerfPanelState(enabled: boolean): void {
  panelEnabled = enabled === true;
  if (!panelEnabled) {
    stopSampler();
    return;
  }
  consecutiveFailures = 0;
  stopSampler();
  void runPerfTick();
}

/** 退出收尾（幂等；timer 已 unref，仅防御性清理）。 */
export function shutdownOmnicodePerfSampler(): void {
  panelEnabled = false;
  stopSampler();
}

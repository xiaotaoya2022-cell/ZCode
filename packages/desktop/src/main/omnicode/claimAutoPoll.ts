// [OmniCode] 批次3 UI 批次：赛博鸡蛋自动领取轮询（main 侧 30min，spec:
// F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3）。
// - 轮询仅在 autoClaimEnabled=true（管理器数据根 console-ui.json，设置页开关写入）时
//   生效；每 tick 重读 console-ui（开关翻转即时生效，不在内存长期缓存）。
// - 执行走既有 claimRunner.startOmnicodeAccountClaimRun({mode:"auto"})——共用 claimPacer
//   节奏器（300-1500ms 抖动/连发保护），UI 侧无任何绕过路径（风控红线）。
// - 检测/领取频率：30min 一拍 + claimRunner 目标解析自身的 preview，无额外循环重试。
import type { OmnicodeAccountClaimEventPayload, OmnicodeAccountDetectResult } from "@zcode/shared";
import { readOmnicodeConsoleUiState } from "./consoleUiState.js";
import { detectOmnicodeClaimableAccounts } from "./accountDetection.js";
import { startOmnicodeAccountClaimRun, hasOmnicodeClaimRunInFlight } from "./claimRunner.js";

/** 自动领取轮询周期（30min；与看板快照 TTL 同量级——低频日查询级别）。 */
export const OMNICODE_CLAIM_AUTO_POLL_INTERVAL_MS = 30 * 60 * 1000;

/** 自动领取动作决策（纯函数，单测锁定）：开关关/无可领/run 在跑 = idle，否则 claim。 */
export type OmnicodeAutoClaimAction = "claim" | "idle";

export function resolveOmnicodeAutoClaimAction(input: {
  autoClaimEnabled: boolean;
  claimableCount: number;
  runInFlight: boolean;
}): OmnicodeAutoClaimAction {
  if (!input.autoClaimEnabled) return "idle";
  if (input.runInFlight) return "idle"; // 连发保护：等待当前 run 结束，不排队
  return input.claimableCount > 0 ? "claim" : "idle";
}

/** 单 tick 依赖注入（单测替换；生产路径用真实实现）。 */
export interface OmnicodeClaimAutoPollDeps {
  readAutoClaimEnabled: () => Promise<boolean>;
  detect: () => Promise<OmnicodeAccountDetectResult>;
  runClaim: () => Promise<{ ok: boolean; reason?: string }>;
}

/** 生产依赖装配（真实 console-ui / 检测 / claimRunner）。 */
export function createOmnicodeClaimAutoPollDeps(
  broadcast: (payload: OmnicodeAccountClaimEventPayload) => void,
): OmnicodeClaimAutoPollDeps {
  return {
    readAutoClaimEnabled: async () => {
      try {
        return (await readOmnicodeConsoleUiState()).autoClaimEnabled === true;
      } catch {
        return false; // 读档失败按关闭处理（宁可不领，不误领）
      }
    },
    detect: () => detectOmnicodeClaimableAccounts(),
    runClaim: () => startOmnicodeAccountClaimRun({ mode: "auto", broadcast }),
  };
}

/**
 * 执行一拍轮询（可测编排；永不抛穿——任何异常静默，下一拍自愈）：
 * 读开关 → 检测 → 决策 → 自动领取。返回本拍动作（诊断用）。
 */
export async function runOmnicodeClaimAutoPollTick(
  deps: OmnicodeClaimAutoPollDeps,
): Promise<OmnicodeAutoClaimAction> {
  try {
    const autoClaimEnabled = await deps.readAutoClaimEnabled().catch(() => false);
    if (!autoClaimEnabled) return "idle";
    const detection = await deps.detect();
    const action = resolveOmnicodeAutoClaimAction({
      autoClaimEnabled: true,
      claimableCount: detection.summary.claimable,
      runInFlight: hasOmnicodeClaimRunInFlight(),
    });
    if (action !== "claim") return action;
    await deps.runClaim().catch(() => undefined); // in_progress/no_targets 均静默（非错误）
    return action;
  } catch {
    return "idle";
  }
}

/** 轮询句柄（stop 仅测试用；生产与管理器进程同生命周期）。 */
export interface OmnicodeClaimAutoPollHandle {
  stop(): void;
  /** 手动触发一拍（测试用；生产路径依赖 interval）。 */
  tick(): Promise<OmnicodeAutoClaimAction>;
}

/** 启动 30min 轮询（main 侧常驻；检测/领取都不打扰 UI——自动领取无动效）。 */
export function startOmnicodeClaimAutoPoll(
  deps: OmnicodeClaimAutoPollDeps,
  options: { intervalMs?: number } = {},
): OmnicodeClaimAutoPollHandle {
  const intervalMs = options.intervalMs ?? OMNICODE_CLAIM_AUTO_POLL_INTERVAL_MS;
  const timer = setInterval(() => {
    void runOmnicodeClaimAutoPollTick(deps);
  }, intervalMs);
  // 不阻塞进程退出
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
  return {
    stop: () => clearInterval(timer),
    tick: () => runOmnicodeClaimAutoPollTick(deps),
  };
}

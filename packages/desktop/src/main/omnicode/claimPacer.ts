// [OmniCode] 批次3：逐张领取节奏器（赛博鸡蛋执行编排的时序内核，纯逻辑可注入单测）。
// spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3（风控设计）：
// - 默认逐张节奏（账号间随机抖动）而非瞬时并发；本实现抖动区间 300-1500ms（任务定案
//   取宽上限，覆盖设计稿 300-800ms 的下沿语义）。
// - 单张失败记录原因后继续下一张（一个账号的失败不阻断其余账号）。
// - 支持中断（skip）：abort 后不再进入下一张（当前张若已开始则执行完并记 skipped 语义
//   由调用方决定；本内核 abort 只拦"尚未开始的下一张"）。
// - 全程 emit 进度事件（started/account_start/account_result/done）。
// 本模块不碰网络、不碰文件——execute 由调用方注入（billingClient/claimRunner）。
import type { OmnicodeClaimHistoryEntry } from "@zcode/shared";

/** 账号间抖动区间（毫秒，闭区间；rand 注入产 0..1）。 */
export const OMNICODE_CLAIM_JITTER_MIN_MS = 300;
export const OMNICODE_CLAIM_JITTER_MAX_MS = 1_500;

/** 抖动延迟计算（纯函数）：rand ∈ [0,1) 均匀映射到 [min, max]。 */
export function resolveOmnicodeClaimJitterMs(rand: number): number {
  const clamped = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0;
  return Math.round(
    OMNICODE_CLAIM_JITTER_MIN_MS +
      clamped * (OMNICODE_CLAIM_JITTER_MAX_MS - OMNICODE_CLAIM_JITTER_MIN_MS),
  );
}

/** 队列单条任务。 */
export interface OmnicodeClaimJob {
  profileId: string;
  planId: string;
}

/** 单张执行结果（execute 注入的返回值；reasonKey 为稳定原因键）。 */
export type OmnicodeClaimJobOutcome = "success" | "failed" | "skipped";

/** 进度事件（与 shared OmnicodeClaimHistoryEntry 口径对齐；runId 由调用方附带）。 */
export type OmnicodeClaimPacerEvent =
  | { type: "started"; total: number }
  | { type: "account_start"; index: number; total: number; profileId: string }
  | { type: "account_result"; index: number; profileId: string; planId: string; outcome: OmnicodeClaimJobOutcome; reasonKey?: string; grantedUnits?: number }
  | { type: "done"; succeeded: number; failed: number; skipped: number; aborted: boolean };

/** 单张执行注入（任何异常按 failed 处理，绝不抛穿队列）。 */
export type OmnicodeClaimJobExecutor = (
  job: OmnicodeClaimJob,
) => Promise<{
  outcome: OmnicodeClaimJobOutcome;
  reasonKey?: string;
  grantedUnits?: number;
  /** plan 展示名（claim 响应 entitlements show_name；可选，仅 success 时有意义）。 */
  planName?: string;
}>;

export interface OmnicodeClaimPacerOptions {
  jobs: readonly OmnicodeClaimJob[];
  mode: OmnicodeClaimHistoryEntry["mode"];
  execute: OmnicodeClaimJobExecutor;
  /** sleep 注入（默认 setTimeout）；测试注入收集型 spy。 */
  sleep?: (ms: number) => Promise<void>;
  /** 抖动随机源（默认 Math.random）；测试注入固定序列。 */
  random?: () => number;
  /** 进度事件回调（同步发射；异常被吞——进度不影响执行）。 */
  onEvent?: (event: OmnicodeClaimPacerEvent) => void;
  /** 中断开关轮询点：每张开始前调用；返回 true = 跳过剩余（本张不执行）。 */
  shouldAbort?: () => boolean;
}

export interface OmnicodeClaimPacerResult {
  succeeded: number;
  failed: number;
  skipped: number;
  /** 中断发生在队列耗尽之前 = true。 */
  aborted: boolean;
  /** 逐张明细（顺序与 jobs 一致；未执行到的不出现在结果里）。 */
  entries: OmnicodeClaimHistoryEntry[];
}

/** 默认 sleep（真实定时器）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 逐张执行领取队列：
 * 1. emit started → 逐张：先查 abort（true = 剩余全记 skipped、aborted=true）→
 *    account_start → execute（异常归 failed）→ account_result → 张间抖动 sleep。
 * 2. 末张后不再 sleep；全部路径保证 emit done。
 * 3. 任何单张异常（含 execute 抛错、onEvent 抛错）都被吞掉，队列继续。
 */
export async function runOmnicodeClaimQueue(
  options: OmnicodeClaimPacerOptions,
): Promise<OmnicodeClaimPacerResult> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const jobs = options.jobs;
  const emit = (event: OmnicodeClaimPacerEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // 进度回调异常不影响执行链
    }
  };
  const entries: OmnicodeClaimHistoryEntry[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let aborted = false;

  emit({ type: "started", total: jobs.length });
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    const abortedHere = options.shouldAbort?.() === true;
    if (abortedHere) {
      aborted = true;
      skipped += 1;
      const entry: OmnicodeClaimHistoryEntry = {
        at: Date.now(),
        profileId: job.profileId,
        planId: job.planId,
        outcome: "skipped",
        reasonKey: "omnicode.claim.failure.aborted",
        mode: options.mode,
      };
      entries.push(entry);
      emit({
        type: "account_result",
        index,
        profileId: job.profileId,
        planId: job.planId,
        outcome: "skipped",
        reasonKey: entry.reasonKey,
      });
      continue;
    }
    emit({ type: "account_start", index, total: jobs.length, profileId: job.profileId });
    let outcome: OmnicodeClaimJobOutcome = "failed";
    let reasonKey: string | undefined;
    let grantedUnits: number | undefined;
    let planName: string | undefined;
    try {
      const result = await options.execute(job);
      outcome = result.outcome;
      reasonKey = result.reasonKey;
      grantedUnits = result.grantedUnits;
      planName = result.planName;
    } catch {
      outcome = "failed";
      reasonKey = "omnicode.claim.failure.unknown";
    }
    if (outcome === "success") succeeded += 1;
    else if (outcome === "skipped") skipped += 1;
    else failed += 1;
    const entry: OmnicodeClaimHistoryEntry = {
      at: Date.now(),
      profileId: job.profileId,
      planId: job.planId,
      outcome,
      ...(planName && outcome === "success" ? { planName } : {}),
      ...(reasonKey && outcome !== "success" ? { reasonKey } : {}),
      ...(grantedUnits !== undefined && outcome === "success" ? { grantedUnits } : {}),
      mode: options.mode,
    };
    entries.push(entry);
    emit({
      type: "account_result",
      index,
      profileId: job.profileId,
      planId: job.planId,
      outcome,
      ...(reasonKey && outcome !== "success" ? { reasonKey } : {}),
      ...(grantedUnits !== undefined && outcome === "success" ? { grantedUnits } : {}),
    });
    // 张间抖动（末张后不 sleep）
    if (index < jobs.length - 1) {
      await sleep(resolveOmnicodeClaimJitterMs(random()));
    }
  }
  emit({ type: "done", succeeded, failed, skipped, aborted });
  return { succeeded, failed, skipped, aborted, entries };
}

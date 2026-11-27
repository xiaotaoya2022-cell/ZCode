// [OmniCode] 批次3：领取执行编排（赛博鸡蛋数据层——目标解析 → 逐张节奏器 → 历史/事件）。
// spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3：
// - 目标解析 = 用各 profile 自己解密的 token 调可领探测（touch 主源 + preview 回落，
//   与检测同口径；实例不必在运行——凭据在盘上）。
// - 每账号一张（touch 首个 claim 动作 / preview priority 首张），逐张节奏见 claimPacer（300-1500ms 抖动）。
// - 各实例各自 token 各自请求、强制复用各数据根已存设备号（风控红线）。
// - mode: manual/auto 仅是执行标注，共用同一节奏器；本模块不做轮询定时器（UI 批次做）。
//
// 事件与历史：进度事件经注入的 broadcast 回调发出（main 侧 = 全窗口 webContents.send）；
// 实际执行结果逐条追加到 console-ui.json claimHistory（FIFO 50，见 consoleUiState）。
// 连发保护：同一时刻仅允许一个 run（in_progress 拒绝，不排队）。
import { randomUUID } from "node:crypto";
import type {
  OmnicodeAccountClaimEventPayload,
  OmnicodeClaimHistoryEntry,
} from "@zcode/shared";
import {
  buildOmnicodeBillingHeaders,
  buildOmnicodeClaimUrl,
  fetchOmnicodeBillingEnvelope,
  mapOmnicodeClaimTransportReasonKey,
  parseOmnicodeClaimEnvelope,
  resolveOmnicodeBillingRequestPolicy,
  type OmnicodeClaimEnvelope,
} from "./billingClient.js";
import {
  readOmnicodeAccountDataFromDataRoot,
  readOmnicodeBillingCredentials,
  type OmnicodeAccountDataSnapshot,
} from "./accountData.js";
import { probeOmnicodeClaimSource } from "./accountDetection.js";
import { logger } from "../logger.js";
import { appendOmnicodeClaimHistory, readOmnicodeConsoleUiState, writeOmnicodeConsoleUiState } from "./consoleUiState.js";
import { runOmnicodeClaimQueue, type OmnicodeClaimJob } from "./claimPacer.js";
import {
  getOmnicodeProfileDir,
  getOmnicodeProfileRecord,
  listOmnicodeProfiles,
} from "./profileRuntime.js";

/** 进行中的 run（管理器进程内存态；同一时刻仅一个）。 */
let activeRun: { runId: string } | null = null;

/** 单测注入点：清空进行中 run（生产路径不使用）。 */
export function resetOmnicodeClaimRunnerForTest(): void {
  activeRun = null;
}

/** 是否有 run 进行中（纯查询）。 */
export function hasOmnicodeClaimRunInFlight(): boolean {
  return activeRun !== null;
}

export interface OmnicodeClaimTargetResolution {
  /** 可执行的领取任务（有具体 planId 才入队）。 */
  jobs: OmnicodeClaimJob[];
  /** 无法执行的账号（缺设备号/缺 JWT/preview 失败）——仅进事件流，不进历史。 */
  skippedAccounts: { profileId: string; reasonKey: string }[];
}

/**
 * 解析领取目标（IO 编排；永不抛穿）：逐 profile 读凭据快照 → policy 门 → 可领探测
 *（probeOmnicodeClaimSource：touch 主源 + preview 回落，与检测同口径）。
 * 探测失败归该账号 skipped（omnicode.claim 原因键），不阻断其余账号。
 */
export async function resolveOmnicodeClaimTargets(options: {
  fetchImpl?: typeof fetch;
}): Promise<OmnicodeClaimTargetResolution> {
  const jobs: OmnicodeClaimJob[] = [];
  const skippedAccounts: { profileId: string; reasonKey: string }[] = [];
  const profiles = await listOmnicodeProfiles().catch(() => [] as never[]);
  for (const profile of profiles) {
    try {
      const record = await getOmnicodeProfileRecord(profile.id).catch(() => undefined);
      const dataRoot = record?.dataBaseDirOverride?.trim() || getOmnicodeProfileDir(profile.id);
      const accountData = await readOmnicodeAccountDataFromDataRoot(dataRoot).catch(
        (): OmnicodeAccountDataSnapshot => ({}),
      );
      const policy = resolveOmnicodeBillingRequestPolicy({
        hasJwtToken: accountData.session?.hasJwtToken === true,
        hasDeviceMid: typeof accountData.deviceMid === "string" && accountData.deviceMid.length > 0,
      });
      if (policy === "skip_no_device_mid") {
        skippedAccounts.push({ profileId: profile.id, reasonKey: "omnicode.claim.failure.no_device_mid" });
        continue;
      }
      if (policy === "skip_no_jwt") {
        skippedAccounts.push({ profileId: profile.id, reasonKey: "omnicode.claim.failure.no_jwt" });
        continue;
      }
      const credentials = await readOmnicodeBillingCredentials(dataRoot).catch(() => undefined);
      if (!credentials || !accountData.deviceMid) {
        skippedAccounts.push({ profileId: profile.id, reasonKey: "omnicode.claim.failure.no_jwt" });
        continue;
      }
      const probe = await probeOmnicodeClaimSource({
        jwtToken: credentials.jwtToken,
        deviceMid: accountData.deviceMid,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (probe.state === "failed") {
        skippedAccounts.push({ profileId: profile.id, reasonKey: probe.reasonKey });
        continue;
      }
      if (probe.state === "no_claim") {
        // 无可领计划：不算失败也不进历史（无事可做）
        continue;
      }
      jobs.push({ profileId: profile.id, planId: probe.planId });
    } catch {
      skippedAccounts.push({ profileId: profile.id, reasonKey: "omnicode.claim.failure.unknown" });
    }
  }
  return { jobs, skippedAccounts };
}

export interface OmnicodeClaimRunOptions {
  mode: OmnicodeClaimHistoryEntry["mode"];
  /** 进度事件广播注入（main 侧全窗口 webContents.send；异常被吞，不影响执行）。 */
  broadcast: (payload: OmnicodeAccountClaimEventPayload) => void;
  /** 中断注入（renderer 后续可接"跳过"控件；缺省不可中断）。 */
  shouldAbort?: () => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * [OmniCode] 2026-11-27 预解析目标注入：自动领取轮询已用同口径探测（touch 主源 +
   * preview 回落）产出检测结果，直接换算为目标跳过二次网络探测——省一半请求，并消除
   * detect→claim 窗口期投放轮换导致的"检测可领、领取时已换 plan"竞态。缺省仍走
   * resolveOmnicodeClaimTargets（手动领取路径语义不变）。
   */
  targets?: OmnicodeClaimTargetResolution;
}

export type OmnicodeClaimRunStart =
  | { ok: true; runId: string; total: number }
  | { ok: false; reason: "in_progress" | "no_targets" };

/**
 * 启动一次领取 run：目标解析（同步段 await）→ 节奏器逐张 → 历史 FIFO 追加 →
 * 事件广播。run 启动即返回 runId（结果经事件 + claimHistory），不阻塞 IPC 调用方。
 * 连发保护：已有 run 时拒绝（in_progress）。
 * [OmniCode] 2026-11-28 挑刺 A-01 修复：此前判空（146）与占位（153）之间隔着
 * resolveOmnicodeClaimTargets 的多次网络 await——并发第二调用在第一调用挂于 148 行时
 * 同样通过判空，随后双方各自覆盖 activeRun 并启动双 run（重复 claim 踩风控红线）。
 * 修法：判空后【同步】占位 activeRun，竞态窗口闭合；目标解析失败/无目标在 finally
 * 回滚占位（run 主体接管后由其自身 finally 清理）。
 */
export async function startOmnicodeAccountClaimRun(
  options: OmnicodeClaimRunOptions,
): Promise<OmnicodeClaimRunStart> {
  if (activeRun) return { ok: false, reason: "in_progress" };
  const runId = randomUUID();
  activeRun = { runId };
  let runBodyStarted = false;
  try {
    const targets = options.targets ?? (await resolveOmnicodeClaimTargets({ fetchImpl: options.fetchImpl }));
    const total = targets.jobs.length + targets.skippedAccounts.length;
    if (total === 0) {
      return { ok: false, reason: "no_targets" };
    }
    void (async () => {
    try {
      runBodyStarted = true;
      options.broadcast({ type: "started", runId, mode: options.mode, total });
      // 无法执行的账号先行作为 skipped 事件发出（保持"逐张"叙事顺序：先不可领后可领）
      for (const skipped of targets.skippedAccounts) {
        options.broadcast({
          type: "account_result",
          runId,
          profileId: skipped.profileId,
          planId: "",
          outcome: "skipped",
          reasonKey: skipped.reasonKey,
        });
      }
      const result = await runOmnicodeClaimQueue({
        jobs: targets.jobs,
        mode: options.mode,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.random ? { random: options.random } : {}),
        ...(options.shouldAbort ? { shouldAbort: options.shouldAbort } : {}),
        execute: async (job) => {
          const claimResult = await executeOmnicodeClaim(job, {
            fetchImpl: options.fetchImpl,
          });
          if (claimResult.outcome === "success") {
            return {
              outcome: "success" as const,
              ...(claimResult.grantedUnits !== undefined
                ? { grantedUnits: claimResult.grantedUnits }
                : {}),
              ...(claimResult.planName ? { planName: claimResult.planName } : {}),
            };
          }
          return {
            outcome: "failed" as const,
            reasonKey: claimResult.reasonKey,
          };
        },
        onEvent: (event) => {
          if (event.type === "account_start") {
            options.broadcast({
              type: "account_start",
              runId,
              index: event.index + targets.skippedAccounts.length,
              total,
              profileId: event.profileId,
            });
            return;
          }
          if (event.type === "account_result") {
            options.broadcast({
              type: "account_result",
              runId,
              profileId: event.profileId,
              planId: event.planId,
              outcome: event.outcome,
              ...(event.reasonKey !== undefined ? { reasonKey: event.reasonKey } : {}),
              ...(event.grantedUnits !== undefined ? { grantedUnits: event.grantedUnits } : {}),
            });
            return;
          }
          if (event.type === "done") {
            options.broadcast({
              type: "done",
              runId,
              succeeded: event.succeeded,
              failed: event.failed,
              skipped: event.skipped + targets.skippedAccounts.length,
              aborted: event.aborted,
            });
          }
        },
      });
      // 历史落盘（best-effort：写失败仅告警不回滚事件；见 consoleUiState.write 注释）
      await persistOmnicodeClaimHistory(result.entries).catch(() => undefined);
    } catch (error) {
      // [OmniCode] 挑刺 A-05 修复：run 主体此前无 catch——中途 broadcast/落盘异常 =
      // 无 done 事件、无历史、UI 永久"进行中"。兜底广播 done（计数不可知如实置 0，
      // aborted=false）解除 UI 卡态；异常只进日志不抛穿（run 是 fire-and-forget）。
      logger.warn("[omnicode-claim-runner] run 主体异常（兜底 done 已广播）:", error);
      try {
        options.broadcast({
          type: "done",
          runId,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          aborted: false,
        });
      } catch {
        /* 广播本身失败已无通道可告知，日志即终态 */
      }
    } finally {
      if (activeRun?.runId === runId) activeRun = null;
    }
  })();
    return { ok: true, runId, total };
  } catch (error) {
    // 占位后的前置段异常（resolveOmnicodeClaimTargets 理论不抛，防御性兜底）
    logger.warn("[omnicode-claim-runner] 目标解析异常:", error);
    return { ok: false, reason: "no_targets" };
  } finally {
    // run 主体未接管（前置段 return/throw）时回滚占位；主体已接管则由其自身 finally 清理
    if (activeRun?.runId === runId && !runBodyStarted) activeRun = null;
  }
}

/** claimHistory 追加写盘（读→追加→写，writeJsonAtomic 原子发布）。 */
export async function persistOmnicodeClaimHistory(
  entries: readonly OmnicodeClaimHistoryEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const current = await readOmnicodeConsoleUiState();
  let next = current.claimHistory ?? [];
  for (const entry of entries) {
    next = appendOmnicodeClaimHistory(next, entry);
  }
  await writeOmnicodeConsoleUiState({ ...current, claimHistory: next });
}

/** 单张 claim 执行（网络段；永不抛穿——execute 注入方的兜底已在 pacer 内再做一层）。 */
async function executeOmnicodeClaim(
  job: OmnicodeClaimJob,
  options: { fetchImpl?: typeof fetch },
): Promise<{ outcome: "success"; grantedUnits?: number; planName?: string } | { outcome: "failed"; reasonKey: string }> {
  try {
    const record = await getOmnicodeProfileRecord(job.profileId).catch(() => undefined);
    const dataRoot = record?.dataBaseDirOverride?.trim() || getOmnicodeProfileDir(job.profileId);
    const accountData = await readOmnicodeAccountDataFromDataRoot(dataRoot).catch(
        (): OmnicodeAccountDataSnapshot => ({}),
      );
    const credentials = await readOmnicodeBillingCredentials(dataRoot).catch(() => undefined);
    if (!credentials || !accountData.deviceMid) {
      // 目标解析后凭据状态变化（登录被清等）——按缺 JWT 降级，不代生成
      return { outcome: "failed", reasonKey: "omnicode.claim.failure.no_jwt" };
    }
    const headers = buildOmnicodeBillingHeaders(
      {
        jwtToken: credentials.jwtToken,
        deviceMid: accountData.deviceMid,
        platform: process.platform,
        arch: process.arch,
      },
      { method: "POST" },
    );
    const result = await fetchOmnicodeBillingEnvelope<OmnicodeClaimEnvelope>(
      options.fetchImpl ?? fetch,
      buildOmnicodeClaimUrl(),
      { method: "POST", headers, body: JSON.stringify({ plan_id: job.planId }) },
    );
    if (!result.ok) {
      return { outcome: "failed", reasonKey: mapOmnicodeClaimTransportReasonKey(result.reason) };
    }
    const parsed = parseOmnicodeClaimEnvelope(result.envelope);
    if (!parsed.success) {
      // 1001-1005 terminal 失败码在 parse 层已映射稳定原因键（不重试）
      return { outcome: "failed", reasonKey: parsed.reasonKey };
    }
    return {
      outcome: "success",
      ...(parsed.grantedUnits !== undefined ? { grantedUnits: parsed.grantedUnits } : {}),
      ...(parsed.planName ? { planName: parsed.planName } : {}),
    };
  } catch {
    return { outcome: "failed", reasonKey: "omnicode.claim.failure.unknown" };
  }
}

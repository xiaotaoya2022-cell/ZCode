// [OmniCode] 模式二 R2：智能调度器（spec: docs/omnicode/multi-account-sessions.md §6/§10-R2）。
//
// 职责（纯逻辑 + 全依赖可注入，无 IO、无轮询、无定时器——事件驱动）：
// - per-账号并发计数：registerStart（sessionId→accountId 登记）/ releaseFinish（会话结束
//   释放）。同一 sessionId 重复登记 = 会话内换账号（旧计数先释放再计入新账号）。
// - pickAccount(candidates, limits)：剩余并发槽最多者优先；平局按 candidates 序稳定
//   （调用方按注册表序传入）；无可用槽 → null（排队/报错由调用方决定，R3/R4 接线）。
// - 429/bizCode 3101/3103 退避降权：recordBackoff(accountId, ttlMs) → TTL 内 pickAccount
//   跳过该账号（过期自然恢复，惰性清理——无后台定时器）。
// - 上限可配：pickAccount 每次传入 limits（键=accountId），未配置账号用 defaultLimit
//   （spec §6 默认 3）。
//
// 本任务只做纯逻辑 + API + 单测；接线到 sendPrompt 缺省选择与开关面属 R3/R4（spec
// §10-R2 范围注记）。登记表有界（FIFO 淘汰最旧会话绑定，淘汰时同步回收其并发计数——
// 防"只登记不释放"的泄漏面）。
// R3.5（终审 P2-2）：CLI/turn 异常崩溃可能不发 turn 终态事件 → 槽位泄漏（running 虚高
// 饿死该账号）。兜底双保险（均事件/调用点驱动，无常驻轮询）：
// - 运行时断连批量释放（zcodeAgentService runtime unavailable / client onClose 调
//   releaseSessions——本模块提供批量 API 与会话集合过滤纯函数）；
// - pickAccount 时点超龄兜底：登记时刻超过 STALE 上限（默认 24h）的条目按超龄释放
//   （registerStart 刷新时间戳，活跃会话每次发送都续期；无 turn 状态事件的僵尸会话
//   在下一次挑选时点被回收）。

/** 会话绑定登记表容量上限（FIFO 淘汰；与 sessionAccountScope 注册表同款有界哲学）。 */
const SESSION_REGISTRY_MAX_ENTRIES = 1024;

/** 超龄兜底上限（终审 P2-2：登记超 24h 的会话槽位在 pickAccount 时点回收）。 */
export const OMNICODE_SESSION_STALE_FALLBACK_MS = 24 * 60 * 60 * 1000;

export const OMNICODE_ACCOUNT_DEFAULT_CONCURRENCY_LIMIT = 3;

export interface OmnicodeAccountSchedulerOptions {
  /** 未配置账号的默认并发上限（spec §6 默认 3）。 */
  defaultLimit?: number;
  /** 超龄兜底上限（ms；缺省 OMNICODE_SESSION_STALE_FALLBACK_MS=24h；单测注入缩短）。 */
  staleSessionMs?: number;
  now?: () => number;
}

export interface OmnicodeAccountPickOptions {
  /** 每账号并发上限（键=accountId；缺省账号用 defaultLimit）。 */
  limits?: Readonly<Record<string, number>>;
  /** 未配置账号的默认上限（覆盖调度器构造时的默认值）。 */
  defaultLimit?: number;
}

export interface OmnicodeAccountScheduler {
  /**
   * 登记一个运行中会话到账号（并发计数 +1）。空 sessionId/accountId no-op；同一
   * sessionId 重复登记 = 换账号（释放旧计数、计入新账号）。
   */
  registerStart(params: { sessionId: string; accountId: string }): void;
  /** 会话结束释放（并发计数 -1）；未登记的 sessionId no-op。 */
  releaseFinish(sessionId: string): void;
  /**
   * 批量释放（R3.5 终审 P2-2：CLI runtime 断连/进程崩溃时按会话集合一次性回收槽位）。
   * 逐条 releaseFinish 语义（未登记 no-op），幂等可重入——zcodeAgentService 的
   * runtime unavailable 与 client onClose 两个断连边界都可调用。
   */
  releaseSessions(sessionIds: readonly string[]): void;
  /** 429/bizCode 3101/3103 退避降权：TTL（ms）内该账号被 pickAccount 跳过。 */
  recordBackoff(accountId: string, ttlMs: number): void;
  /**
   * 挑账号（纯决策）：candidates 序 = 注册表序（平局稳定）。跳过：退避中的账号、
   * 剩余槽 ≤0 的账号。剩余槽最多者优先。无可用 → null。
   */
  pickAccount(candidates: readonly string[], options?: OmnicodeAccountPickOptions): string | null;
  /** 账号当前运行中会话数（槽位可视化数据源；未登记账号返回 0）。 */
  runningCountOf(accountId: string): number;
  /** 账号是否仍在退避降权中（诊断/测试用；过期即 false）。 */
  isBackedOff(accountId: string): boolean;
  /** 当前登记会话数（泄漏诊断）。 */
  boundSessionCount(): number;
}

/** 上限解析（纯函数，单测锁定）：limits 命中优先，其次 defaultLimit，最后调度器默认。 */
export function resolveOmnicodeAccountLimit(
  accountId: string,
  limits: Readonly<Record<string, number>> | undefined,
  defaultLimit: number | undefined,
  fallback: number,
): number {
  const configured = limits?.[accountId];
  if (typeof configured === "number" && Number.isFinite(configured)) return configured;
  if (typeof defaultLimit === "number" && Number.isFinite(defaultLimit)) return defaultLimit;
  return fallback;
}

/**
 * 构造调度器（R3/R4 接线消费；本任务测试直接消费）。
 */
export function createOmnicodeAccountScheduler(
  options: OmnicodeAccountSchedulerOptions = {},
): OmnicodeAccountScheduler {
  const now = options.now ?? (() => Date.now());
  const defaultLimit = options.defaultLimit ?? OMNICODE_ACCOUNT_DEFAULT_CONCURRENCY_LIMIT;
  const staleSessionMs = options.staleSessionMs ?? OMNICODE_SESSION_STALE_FALLBACK_MS;
  // sessionId → { accountId, startedAt }（Map 保插入序：重复登记先删再插刷新为最新，
  // FIFO 淘汰弹最旧；startedAt 供超龄兜底，活跃会话每次 registerStart 续期）。
  const sessions = new Map<string, { accountId: string; startedAt: number }>();
  const runningCounts = new Map<string, number>();
  // accountId → 退避截止时刻（epoch ms）；过期惰性清理，无后台定时器。
  const backoffUntil = new Map<string, number>();

  const decrementCount = (accountId: string): void => {
    const current = runningCounts.get(accountId) ?? 0;
    if (current <= 1) runningCounts.delete(accountId);
    else runningCounts.set(accountId, current - 1);
  };

  const releaseInternal = (sessionId: string): void => {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    sessions.delete(sessionId);
    decrementCount(entry.accountId);
  };

  const evictOldestIfNeeded = (): void => {
    while (sessions.size >= SESSION_REGISTRY_MAX_ENTRIES) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      releaseInternal(oldest);
    }
  };

  /**
   * 超龄兜底（R3.5 终审 P2-2）：登记时刻距今超 staleSessionMs 的条目回收。只在
   * pickAccount 调用时点清扫（事件/调用点驱动，无常驻轮询）；同 sessionId 再登记
   * （新发送）刷新 startedAt——活跃长会话不误伤。
   */
  const releaseStaleSessions = (): void => {
    const current = now();
    for (const [sessionId, entry] of sessions) {
      if (current - entry.startedAt > staleSessionMs) releaseInternal(sessionId);
    }
  };

  return {
    registerStart({ sessionId, accountId }) {
      const sessionKey = sessionId.trim();
      const accountKey = accountId.trim();
      if (!sessionKey || !accountKey) return;
      // 换账号语义：先释放旧绑定计数（同一账号重复登记即净零，不重复计数）。
      const previous = sessions.get(sessionKey);
      if (previous) {
        sessions.delete(sessionKey);
        decrementCount(previous.accountId);
      }
      evictOldestIfNeeded();
      sessions.set(sessionKey, { accountId: accountKey, startedAt: now() });
      runningCounts.set(accountKey, (runningCounts.get(accountKey) ?? 0) + 1);
    },
    releaseFinish(sessionId) {
      const sessionKey = sessionId.trim();
      if (!sessionKey) return;
      releaseInternal(sessionKey);
    },
    releaseSessions(sessionIds) {
      // R3.5 终审 P2-2：批量释放（CLI runtime 断连/崩溃边界一次性回收，未登记 no-op）。
      for (const sessionId of sessionIds) {
        releaseInternal(sessionId.trim());
      }
    },
    recordBackoff(accountId, ttlMs) {
      const accountKey = accountId.trim();
      if (!accountKey) return;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
      backoffUntil.set(accountKey, now() + ttlMs);
    },
    pickAccount(candidates, pickOptions) {
      // 超龄兜底先行（无终态事件的僵尸会话在挑选时点回收槽位——事件驱动非轮询）。
      releaseStaleSessions();
      const current = now();
      const limits = pickOptions?.limits;
      const pickDefault = pickOptions?.defaultLimit;
      let best: { accountId: string; remaining: number } | null = null;
      for (const candidate of candidates) {
        const accountKey = candidate?.trim() ?? "";
        if (!accountKey) continue;
        // 退避降权：TTL 内跳过（过期自然恢复并惰性清理）。
        const until = backoffUntil.get(accountKey);
        if (until !== undefined) {
          if (until > current) continue;
          backoffUntil.delete(accountKey);
        }
        const limit = resolveOmnicodeAccountLimit(accountKey, limits, pickDefault, defaultLimit);
        const running = runningCounts.get(accountKey) ?? 0;
        const remaining = limit - running;
        if (remaining <= 0) continue;
        // 严格大于：平局保持 candidates（注册表）序稳定。
        if (!best || remaining > best.remaining) {
          best = { accountId: accountKey, remaining };
        }
      }
      return best?.accountId ?? null;
    },
    runningCountOf(accountId) {
      return runningCounts.get(accountId.trim()) ?? 0;
    },
    isBackedOff(accountId) {
      const until = backoffUntil.get(accountId.trim());
      if (until === undefined) return false;
      if (until > now()) return true;
      backoffUntil.delete(accountId.trim());
      return false;
    },
    boundSessionCount() {
      return sessions.size;
    },
  };
}

/**
 * 运行时会话集合过滤（R3.5 断连批量释放的选择面，纯函数单测锁定）。输入 =
 * CLI runtime client 的会话归属表（sessionId → workspaceKey，zcodeAgentService
 * clientSessions 同形）；workspaceKey=null = 该 client 全部会话（client onClose），
 * 指定 workspaceKey = 仅该 workspace 的会话（runtime unavailable 按代际回收）。
 * 空白 sessionId 跳过（与登记入口同口径）。
 */
export function filterOmnicodeRuntimeSessionIds(
  sessions: ReadonlyMap<string, string>,
  workspaceKey: string | null,
): string[] {
  const result: string[] = [];
  for (const [sessionId, key] of sessions) {
    const trimmed = sessionId.trim();
    if (!trimmed) continue;
    if (workspaceKey !== null && key !== workspaceKey) continue;
    result.push(trimmed);
  }
  return result;
}

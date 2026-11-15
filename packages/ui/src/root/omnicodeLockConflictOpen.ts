/**
 * [OmniCode] 批次3 锁冲突处置改造——自动观察者（D11，2026-11-15 用户拍板）：
 * 锁冲突不再弹窗拦截（锁冲突对话框退役），acquire 判负后按序决策：
 * ① 同工作区已有观察者 tab → 仅激活该 tab（不重复 toast）；
 * ② 未重试过且路径可安全重试 → 补一次完整打开流（处理「锁主刚退出」竞态：
 *    重试成功 = 按 Normal 打开；仍判负 = 进入观察者）；
 * ③ 其余情况 → 直接以观察者（只读）身份打开 + 非模态 toast。
 *
 * 本模块只放纯判定，不触 React/服务：打开编排（addTab/startDraft/retry/toast）
 * 由 useRootWorkspaceActions 装配，桌面单测可直接覆盖本模块。
 */

/** 观察者 toast 去重窗口：同工作区该窗口内只提示一次（并发重复打开竞态兜底）。 */
export const OMNICODE_OBSERVER_TOAST_DEDUPE_WINDOW_MS = 3000;

/**
 * 锁冲突打开动作（决策纯函数，与 Host 侧 resolveWorkspaceOpenGuardDecision 对应的
 * renderer 侧打开编排决策）：
 * - activate-existing-observer：复用既有观察者 tab（仅激活，无提示）；
 * - retry-acquire：补一次完整打开流（锁主退出竞态自愈；WSL UNC 路径跳过——
 *   重试会二次弹出 WSL 路由确认框）；
 * - open-observer：自动观察者打开 + toast。
 */
export type OmnicodeLockConflictOpenAction =
  | { kind: "activate-existing-observer" }
  | { kind: "retry-acquire" }
  | { kind: "open-observer" };

export function resolveOmnicodeLockConflictOpenAction(input: {
  /** findWorkspaceObserverHolder 的结果：非 null = 同工作区已有观察者 tab。 */
  existingObserverHolder: { holderProfileId: string; holderDisplayName?: string } | null;
  /** 本次进入冲突分支是否已是一次竞态重试（重试只补一次，不递归）。 */
  isRaceRetry: boolean;
  /** 路径为 WSL UNC：重试会二次弹 WSL 确认框，跳过重试直接进观察者。 */
  suppressRaceRetry?: boolean;
}): OmnicodeLockConflictOpenAction {
  if (input.existingObserverHolder) return { kind: "activate-existing-observer" };
  if (!input.isRaceRetry && !input.suppressRaceRetry) return { kind: "retry-acquire" };
  return { kind: "open-observer" };
}

/**
 * 观察者 toast 去重判定（纯函数）：同工作区在去重窗口内已有提示则跳过。
 * 状态判定（findWorkspaceObserverHolder）覆盖"tab 已存在"的主路径；本判定兜底
 * 并发重复打开（两次调用几乎同时判负、各自进入 open-observer）的微任务交错。
 */
export function shouldSuppressRepeatedObserverToast(
  previousShownAt: number | undefined,
  now: number,
  windowMs: number = OMNICODE_OBSERVER_TOAST_DEDUPE_WINDOW_MS,
): boolean {
  if (previousShownAt === undefined) return false;
  return now - previousShownAt < windowMs;
}

/** 观察者 toast 去重键：与锁装饰/错误 data 的路径归一口径一致（去尾分隔符 + 小写）。 */
export function observerToastDedupeKey(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, "").toLowerCase();
}

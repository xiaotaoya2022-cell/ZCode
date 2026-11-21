// 项目行「刷新会话列表」按钮的点击编排（批次3 会话同步 Phase 1 + Phase 2 真修，
// spec: F:\OmniCode\docs\batch3\research\session-sync-mechanism.md §四/§六/§七）。
// 根因回顾：Host 同步器的首帧快照是"静默基线"——把其他实例的旧会话原子补进 tasks-index
// 但不广播 workspace_task_list_changed，侧栏树要等下一次事件才重拉。而首帧快照的前提是
// 该 workspace 有 CLI runtime（被动 UI 订阅在 runtime 缺失时进 dormant：
// sessionsIndexStore.ts handleRuntimeUnavailable，等 lifecycle 不设 timer）。
// 用户实证：点「+添加会话」（不真建会话）会让 dormant 订阅苏醒——草稿目录水合
// （useDraftConfigControl → prepareWorkspaceWithZCodeSessionService → readWorkspacePresentation）
// 以默认 start-if-needed 拉起 CLI runtime，publishAvailable 触发 lifecycle available，
// Host 同步器据此 ensureWorkspaceSubscription → 首帧 snapshot → 静默补库。
// Phase 2 真修 = 刷新按钮复用同一唤醒原语 zcodeSessionService.initializeWorkspace
// （Host warmup 同款：getClient(start-if-needed) + taskIndexSyncer.ensureWorkspaceSubscription），
// 然后轮询 tasks-index 变化（有界窗口）直至补库到达或超时，最后必定重读一次。
// 编排抽成纯函数便于无 DOM 单测：ui 包没有组件渲染测试先例（无 testing-library），
// 写法对齐 packages/desktop/test/omnicode* 的纯逻辑用例。

import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { resolveWorkspaceServices } from "@/lib/workspaceServiceResolver.js";
import type { WorkspaceServiceResolverState } from "@/lib/workspaceServiceResolver.js";

// 类型经既有 re-export / 结构化投影取得，不在本文件直连 @zcode/services
// （architecture ui-implementation-import：UI 层不直接依赖 services 实现路径）。
/** 唤醒所需的 session 服务面（initializeWorkspace 的结构化投影，Proxy 返回值天然满足）。 */
export type SessionWakeSessionService = {
  initializeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ available: boolean; reason?: string; reasonCode?: string }>;
};

// resolveWorkspaceServices 的远端分支从不读取 baseServices（只看 sessionsById）；
// 本地分支读到该占位时查不到任何服务 → wake 解析返回 null（不误用错误 Host）。
const wakeBaseServicesPlaceholder = new Proxy(Object.create(null), {
  get: () => undefined,
}) as WorkspaceServiceResolverState["sessionsById"][string]["services"];

export type SessionRefreshState = { inFlight: boolean };

export function createSessionRefreshState(): SessionRefreshState {
  return { inFlight: false };
}

/**
 * 触发一次会话列表重拉。in-flight 期间重复点击直接忽略（防连点重入；树级单飞合并
 * 由 useProjectTree.refresh 的 reads.flight 兜底），返回是否真正发起这次重拉。
 * onRefreshingChange 驱动按钮转圈态：refresh 抛错也必须清态，不让按钮永久卡在转圈。
 */
export function triggerSessionRefresh(
  state: SessionRefreshState,
  refresh: () => Promise<unknown>,
  onRefreshingChange: (refreshing: boolean) => void,
): boolean {
  if (state.inFlight) return false;
  state.inFlight = true;
  onRefreshingChange(true);
  // 点击即同步发起重拉；refresh 是 async 回调不会同步抛错，仍兜底转成拒绝，清态路径唯一。
  let flight: Promise<unknown>;
  try {
    flight = refresh();
  } catch (cause) {
    flight = Promise.reject(cause);
  }
  void flight.catch(() => {}).finally(() => {
    state.inFlight = false;
    onRefreshingChange(false);
  });
  return true;
}

// ── Phase 2：唤醒 → 等待静默补库 → 重读 ──────────────────────────────────────

/** 项目行的会话归属 workspace：会话 cwd 一律是主根目录（prepareSession 同一选择）。 */
export type SessionRefreshWakeTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
};

/** 会话行签名：id + updatedAt 拼接；静默补库写入新行时签名必然变化。 */
export function projectTaskListSignature(tasks: ReadonlyArray<{
  taskId: string;
  updatedAt: number;
}>): string {
  return tasks.map((task) => `${task.taskId}:${task.updatedAt}`).join("|");
}

/**
 * 从项目行构造唤醒目标：主根 workspace + 远端 Host 身份（与 useProjectTree scopes 的
 * 身份构造同一规则 buildRemoteHostWorkspaceIdentity）。无 root 的项目（数据残缺）返回
 * null，只保留重读语义。
 */
export function buildSessionRefreshWakeTarget(project: Pick<VirtualProject, "hostId" | "roots">): SessionRefreshWakeTarget | null {
  const primaryRoot =
    project.roots.find((root) => root.isPrimary) ?? (project.roots[0] || null);
  if (!primaryRoot) return null;
  if (project.hostId === "local") return { workspacePath: primaryRoot.rootPath };
  return {
    workspacePath: primaryRoot.rootPath,
    workspaceIdentity: buildRemoteHostWorkspaceIdentity(project.hostId, primaryRoot.rootPath),
  };
}

/**
 * 解析唤醒用的 zcodeSessionService：
 * - 本地目标（无 identity）→ renderer 根 services（本机 Host）；
 * - 远端目标（identity）→ 必须解析到已连接的远端 workspace session（sessionIdByWorkspaceIdentity），
 *   解析不到返回 null（不能拿本机 Host 去初始化远端路径，也不能为刷新强开远端连接）。
 * 纯函数：store 状态由调用方快照传入，便于单测。
 */
export function resolveSessionWakeService(params: {
  target: SessionRefreshWakeTarget | null;
  baseServices: WorkspaceServiceResolverState["sessionsById"][string]["services"] | null;
  remoteSessions: WorkspaceServiceResolverState;
}): SessionWakeSessionService | null {
  const { target, baseServices, remoteSessions } = params;
  if (!target) return null;
  const resolved = resolveWorkspaceServices(
    { workspacePath: target.workspacePath, workspaceIdentity: target.workspaceIdentity },
    // 远端分支从不读取 baseServices（只看 sessionsById）；本地分支占位 → 下方查不到服务返回 null。
    baseServices ?? wakeBaseServicesPlaceholder,
    remoteSessions,
  );
  if (!resolved) return null;
  const sessionService: unknown = resolved.services.zcodeSessionService;
  return typeof sessionService === "object" && sessionService !== null
    ? (sessionService as SessionWakeSessionService)
    : null;
}

/**
 * 刷新按钮的唤醒步骤（组件接线抽为可注入纯函数，便于门控分支单测）：
 * - wakeAllowed=false（官方 flavor / SSR，由组件用 F4-11 原语 resolveOmnicodeBrandFromLocation
 *   判定后传入——终审 P1-1：官方窗口点刷新保持 Phase 1 幂等只读树重拉，不进唤醒链）：
 *   直接 null，绝不触碰 session 服务；
 * - 其余按 resolveSessionWakeService 的规则解析（远端解析不到不回落本机），解析到
 *   服务才调 initializeWorkspace（start-if-needed），available=true 视为唤醒成功。
 */
export async function wakeSessionForRefresh(params: {
  target: SessionRefreshWakeTarget | null;
  baseServices: WorkspaceServiceResolverState["sessionsById"][string]["services"] | null;
  remoteSessions: WorkspaceServiceResolverState;
  wakeAllowed: boolean;
}): Promise<boolean | null> {
  // P1-1：官方 flavor 不进入唤醒链（保持 Phase 1 幂等只读），也不解析服务。
  if (!params.wakeAllowed) return null;
  if (!params.target) return null;
  const sessionService = resolveSessionWakeService({
    target: params.target,
    baseServices: params.baseServices,
    remoteSessions: params.remoteSessions,
  });
  if (!sessionService) return null;
  const result = await sessionService.initializeWorkspace({
    workspacePath: params.target.workspacePath,
    ...(params.target.workspaceIdentity ? { workspaceIdentity: params.target.workspaceIdentity } : {}),
  });
  return result.available === true;
}

/** 唤醒编排注入面（纯函数可测）：wake/reread 由组件用真实服务接线。 */
export interface SessionWakeRuntime {
  /**
   * 唤醒该 workspace 的 CLI runtime（initializeWorkspace = getClient(start-if-needed)
   * + taskIndexSyncer.ensureWorkspaceSubscription）。返回 true = runtime 可用（补库链路
   * 已被拉起）；false = 明确不可用（provider 未就绪等，等不出补库）；null = 无法安全唤醒
   * （远端未连接/服务缺失），保留 Phase 1 的纯重读语义。
   */
  wake(): Promise<boolean | null>;
  /** 树重拉（直读 tasks-index），与行 refresh prop 同一单飞管道。 */
  reread(): Promise<unknown>;
  /** 当前行任务签名（taskListSignature(tasks)），由组件读 ref 保证拿到最新提交。 */
  signature(): string;
  /**
   * 终审 P2 取消探测（可选）：组件卸载/列表切换后为 true。轮询（与 wake 后的重读收尾）
   * 见到取消立即停止——已卸载的行不再烧满 5s 的整树重读；wake 本身在途的服务调用
   * 无法中止（start-if-needed 幂等，无副作用放大量）。
   */
  isCancelled?(): boolean;
}

export const SESSION_REFRESH_WAKE_TIMEOUT_MS = 5_000;
export const SESSION_REFRESH_POLL_INTERVAL_MS = 400;
/** 终审 P2（已同步空转）：签名未变轮次按 400→800→1600 退避，减少无补库可来时的整树重读浪费。 */
export const SESSION_REFRESH_POLL_INTERVAL_MAX_MS = 1_600;

export interface SessionWakeTiming {
  now(): number;
  delay(ms: number): Promise<void>;
}

const realTiming: SessionWakeTiming = {
  now: () => Date.now(),
  delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * 刷新按钮的完整链：唤醒 runtime → 轮询重读直至补库写入（签名变化）或有界超时 → 兜底重读。
 * - wake 明确失败/不可用（false/null/抛错）：没有补库可等，立即重读一次返回（Phase 1 语义），
 *   不把 provider 未就绪拖成 5s 空转。
 * - wake 成功：初始化 resolved 后 Host 同步器经 lifecycle available 建立 workspace 订阅，
 *   首帧静默补库落 tasks-index；轮询窗口（SESSION_REFRESH_WAKE_TIMEOUT_MS）内任何一轮
 *   签名变化即提前结束，超时也保证最后完成一次重读，绝不吞掉 Phase 1 的可见性。
 * - reread 抛错（树暂不可读）：向上传播（与 Phase 1 同语义），由 triggerSessionRefresh
 *   统一清转圈态，错误展示交给 useProjectTree 的既有 error 投影。
 * - isCancelled（组件卸载/列表切换）：轮询各拍与 wake 后的收尾重读见到取消立即停止，
 *   不再为已卸载的行烧整树重读（终审 P2 修复）。
 */
export async function runSessionWakeAndReread(
  runtime: SessionWakeRuntime,
  timing: SessionWakeTiming = realTiming,
): Promise<{ woke: boolean; changed: boolean }> {
  const baseline = runtime.signature();
  const woke =
    (await runtime
      .wake()
      .then((result) => result === true)
      .catch(() => false)) === true;
  if (!woke) {
    if (runtime.isCancelled?.()) return { woke: false, changed: false };
    await runtime.reread();
    return { woke: false, changed: false };
  }
  const deadline = timing.now() + SESSION_REFRESH_WAKE_TIMEOUT_MS;
  let interval = SESSION_REFRESH_POLL_INTERVAL_MS;
  for (;;) {
    if (runtime.isCancelled?.()) return { woke: true, changed: false };
    await runtime.reread();
    if (runtime.signature() !== baseline) return { woke: true, changed: true };
    if (timing.now() >= deadline) return { woke: true, changed: false };
    // 已同步场景签名不会变化（订阅已建、无补库可来）：间隔退避，整树重读次数从
    // ~13 次降到 ~6 次，窗口总量仍是 5s（终审 P2；真正的"提前收口"需要 seed 完成
    // 信号，renderer 侧无此投影，记录为已知项——转圈仍会跑满 5s）。
    const remaining = deadline - timing.now();
    await timing.delay(Math.min(interval, Math.max(remaining, 0)));
    interval = Math.min(interval * 2, SESSION_REFRESH_POLL_INTERVAL_MAX_MS);
  }
}

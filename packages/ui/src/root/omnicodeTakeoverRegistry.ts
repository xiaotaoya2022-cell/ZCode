/**
 * [OmniCode] D12 请求接管流——观察者在途请求登记表（renderer 内存态，模块级单例）。
 * SessionPane 琥珀横幅的「请求接管」按钮按此渲染 pending 态（useSyncExternalStore）；
 * 请求/回执/取消都在此收口，防止重复点击向管理器发第二请求（管理器侧也会以 busy
 * 兜底，此表只是把反馈提前到 UI）。与 observerToastShownAtByWorkspace 同款约定：
 * 模块级 Map，仅本次 app 运行语义，无需清理。
 */
import type { OmnicodeTakeoverRequestInput } from "@zcode/shared";

interface TakeoverPendingEntry {
  requestId: string;
}

/** 归一化路径（去尾分隔符 + 小写，与锁 hash/observer dedupe 同口径）。 */
function normalizeTakeoverWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, "").toLowerCase();
}

const pendingByPath = new Map<string, TakeoverPendingEntry>();
const listeners = new Set<() => void>();
/** Root 装配的发起处理器（useOmnicodeWorkspaceTakeover 注入；null = 实例桥不可用）。 */
let requestHandler: ((input: OmnicodeTakeoverRequestInput) => void) | null = null;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** 外部存储快照（useSyncExternalStore 数据源：不可变数组，每次变更重建）。 */
export function getOmnicodeTakeoverPendingSnapshot(): string[] {
  return [...pendingByPath.keys()];
}

export function subscribeOmnicodeTakeoverPending(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isOmnicodeTakeoverPending(workspacePath: string): boolean {
  return pendingByPath.has(normalizeTakeoverWorkspacePath(workspacePath));
}

/** 登记在途请求（requestId 由实例 main 生成后回填）。 */
export function markOmnicodeTakeoverPending(workspacePath: string, requestId: string): void {
  pendingByPath.set(normalizeTakeoverWorkspacePath(workspacePath), { requestId });
  emitChange();
}

/** 结算（回执到达 / 发送失败 / 取消上报后清槽）。 */
export function settleOmnicodeTakeoverPending(workspacePath: string): void {
  if (pendingByPath.delete(normalizeTakeoverWorkspacePath(workspacePath))) {
    emitChange();
  }
}

/** 在途请求 id（取消上报用；无在途请求返回 null）。 */
export function getOmnicodeTakeoverPendingRequestId(workspacePath: string): string | null {
  return pendingByPath.get(normalizeTakeoverWorkspacePath(workspacePath))?.requestId ?? null;
}

/** Root 装配发起处理器（幂等覆盖）；SessionPane 按钮经 requestOmnicodeWorkspaceTakeover 调用。 */
export function setOmnicodeTakeoverRequestHandler(
  handler: ((input: OmnicodeTakeoverRequestInput) => void) | null,
): void {
  requestHandler = handler;
}

/** 横幅按钮可用性（官方 flavor / 管理器 / 旧 preload 桥面缺席 → 隐藏按钮零死点击）。 */
export function hasOmnicodeTakeoverRequestHandler(): boolean {
  return requestHandler !== null;
}

/**
 * 横幅按钮入口：无处理器（官方 flavor / 管理器 / 桥缺席）或在途重复点击 → no-op，
 * 返回 false 供调用方区分；成功受理返回 true。
 */
export function requestOmnicodeWorkspaceTakeover(workspacePath: string): boolean {
  if (!requestHandler || isOmnicodeTakeoverPending(workspacePath)) return false;
  requestHandler({ workspacePath });
  return true;
}

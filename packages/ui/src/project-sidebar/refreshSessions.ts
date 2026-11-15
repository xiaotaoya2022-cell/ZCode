// 项目行「刷新会话列表」按钮的点击编排（批次3 会话同步 Phase 1，
// spec: F:\OmniCode\docs\batch3\research\session-sync-mechanism.md §四）。
// 根因回顾：Host 同步器的首帧快照是"静默基线"——把其他实例的旧会话原子补进 tasks-index
// 但不广播 workspace_task_list_changed，侧栏树要等下一次事件才重拉。按钮=用户手动触发
// 同一条重拉管道（useProjectTree.refreshDirectory → projectService.readTree 直读 tasks-index），
// 静默补过的旧行点击后立即可见；Phase 1 不含 CLI sessions-index/rescan 跨实例实时重扫。
// 编排抽成纯函数便于无 DOM 单测：ui 包没有组件渲染测试先例（无 testing-library），
// 写法对齐 packages/desktop/test/omnicode* 的纯逻辑用例。

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

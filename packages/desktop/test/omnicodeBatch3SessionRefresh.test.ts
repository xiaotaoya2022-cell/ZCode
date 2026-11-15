// [OmniCode] 批次3 会话同步 Phase 1：项目行「刷新会话列表」按钮纯逻辑单测。
// 根因：Host 同步器首帧快照静默补 tasks-index 行但不广播，侧栏要等下一次
// workspace_task_list_changed 才重拉；按钮=手动触发 useProjectTree.refreshDirectory。
// ui 包没有组件渲染测试先例（无 testing-library），按仓库现状退而测 refresh 管道
// 纯逻辑（点击编排/重入合并/转圈清态）；按钮渲染与 tooltip 走手动验证项
// （spec: F:\OmniCode\docs\batch3\research\session-sync-mechanism.md §刷新按钮）。
// 写法参照 omnicodeBatch3DashboardUi.test.ts。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionRefreshState,
  triggerSessionRefresh,
} from "@/project-sidebar/refreshSessions.js";

/** 手动 resolve 的延迟 promise：精确控制一次刷新的在途窗口。 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 排空编排链的全部微任务（then→catch→finally 需两跳以上）；setImmediate 在宏任务边界确定性清空。 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("triggerSessionRefresh 项目行刷新编排", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("首次点击发起重拉：refresh 调用一次，转圈态 true→false", async () => {
    const state = createSessionRefreshState();
    const flight = createDeferred<void>();
    const refresh = vi.fn(() => flight.promise);
    const onRefreshingChange = vi.fn();

    const started = triggerSessionRefresh(state, refresh, onRefreshingChange);

    expect(started).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onRefreshingChange).toHaveBeenNthCalledWith(1, true);
    expect(state.inFlight).toBe(true);

    flight.resolve();
    await flight.promise;
    // finally 在微任务边界清态；多等一个 tick 保证断言确定性。
    await flushAsync();
    expect(onRefreshingChange).toHaveBeenNthCalledWith(2, false);
    expect(state.inFlight).toBe(false);
  });

  it("in-flight 期间连点被忽略（防重入）：第二次点击返回 false，refresh 仍只调用一次", async () => {
    const state = createSessionRefreshState();
    const flight = createDeferred<void>();
    const refresh = vi.fn(() => flight.promise);
    const onRefreshingChange = vi.fn();

    expect(triggerSessionRefresh(state, refresh, onRefreshingChange)).toBe(true);
    expect(triggerSessionRefresh(state, refresh, onRefreshingChange)).toBe(false);
    expect(triggerSessionRefresh(state, refresh, onRefreshingChange)).toBe(false);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onRefreshingChange).toHaveBeenCalledTimes(1);
    expect(onRefreshingChange).toHaveBeenCalledWith(true);

    flight.resolve();
    await flight.promise;
    await flushAsync();
    // 结束后也只补一次清态，不因连点叠加。
    expect(onRefreshingChange).toHaveBeenCalledTimes(2);
    expect(onRefreshingChange).toHaveBeenLastCalledWith(false);
  });

  it("刷新完成后可再次点击：两次点击各发起一次重拉", async () => {
    const state = createSessionRefreshState();
    const flights = [createDeferred<void>(), createDeferred<void>()];
    let index = 0;
    const refresh = vi.fn(() => flights[index++]!.promise);
    const onRefreshingChange = vi.fn();

    expect(triggerSessionRefresh(state, refresh, onRefreshingChange)).toBe(true);
    flights[0]!.resolve();
    await flights[0]!.promise;
    await flushAsync();
    expect(state.inFlight).toBe(false);

    expect(triggerSessionRefresh(state, refresh, onRefreshingChange)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    flights[1]!.resolve();
    await flights[1]!.promise;
    await flushAsync();
    expect(onRefreshingChange.mock.calls.map((call) => call[0])).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("refresh 抛错也必须清转圈态且不卡死，下一次点击可重新发起", async () => {
    const state = createSessionRefreshState();
    const flight = createDeferred<void>();
    const refresh = vi.fn(() => flight.promise);
    const onRefreshingChange = vi.fn();

    expect(triggerSessionRefresh(state, refresh, onRefreshingChange)).toBe(true);
    flight.reject(new Error("project.tree-unavailable"));
    await expect(flight.promise).rejects.toThrow("project.tree-unavailable");
    await flushAsync();
    expect(state.inFlight).toBe(false);
    expect(onRefreshingChange).toHaveBeenLastCalledWith(false);

    // 失败后状态可复用：下一次点击照常发起（读失败由 useProjectTree 记入 error 展示）。
    const second = createDeferred<void>();
    const refreshAgain = vi.fn(() => second.promise);
    expect(triggerSessionRefresh(state, refreshAgain, onRefreshingChange)).toBe(true);
    expect(refreshAgain).toHaveBeenCalledTimes(1);
    second.resolve();
    await second.promise;
    await flushAsync();
    expect(onRefreshingChange).toHaveBeenLastCalledWith(false);
  });

  it("每个项目行持有独立状态：两个 state 互不共享 in-flight", async () => {
    const rowA = createSessionRefreshState();
    const rowB = createSessionRefreshState();
    const flightA = createDeferred<void>();
    const onRefreshingChange = vi.fn();

    expect(
      triggerSessionRefresh(rowA, () => flightA.promise, onRefreshingChange),
    ).toBe(true);
    // 行 B 未发起：状态独立，可立即触发自己的重拉。
    expect(
      triggerSessionRefresh(rowB, () => Promise.resolve(), vi.fn()),
    ).toBe(true);
    flightA.resolve();
    await flightA.promise;
    await flushAsync();
    expect(rowA.inFlight).toBe(false);
    expect(rowB.inFlight).toBe(false);
  });
});

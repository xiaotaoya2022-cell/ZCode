// [OmniCode] 批次3 会话同步 Phase 1 + Phase 2：项目行「刷新会话列表」按钮纯逻辑单测。
// 根因：Host 同步器首帧快照静默补 tasks-index 行但不广播，且首帧快照的前提是该 workspace
// 有 CLI runtime（被动 UI 订阅 runtime 缺失时进 dormant）。Phase 2 真修 = 按钮复用
// 「+添加会话」的唤醒原语（initializeWorkspace 拉起 CLI runtime + 确保同步器订阅），
// 再轮询重读 tasks-index 直到静默补库写入（行签名变化）或有界超时。
// ui 包没有组件渲染测试先例（无 testing-library），按仓库现状退而测 refresh 管道
// 纯逻辑（点击编排/重入合并/转圈清态/唤醒-轮询-重读序列/唤醒目标与服务解析）；
// 按钮渲染与 tooltip 走手动验证项
// （spec: F:\OmniCode\docs\batch3\research\session-sync-mechanism.md §刷新按钮/§七）。
// 写法参照 omnicodeBatch3DashboardUi.test.ts。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionRefreshWakeTarget,
  createSessionRefreshState,
  projectTaskListSignature,
  resolveSessionWakeService,
  runSessionWakeAndReread,
  SESSION_REFRESH_POLL_INTERVAL_MS,
  SESSION_REFRESH_WAKE_TIMEOUT_MS,
  triggerSessionRefresh,
  type SessionWakeTiming,
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

// ── Phase 2：唤醒 → 轮询补库 → 重读（runSessionWakeAndReread）─────────────────

/** 注入式时钟：delay 推进时钟，轮询窗口用例完全确定，无真实定时器。 */
function createFakeTiming(): SessionWakeTiming & { clock: number } {
  const timing = {
    clock: 0,
    now() {
      return timing.clock;
    },
    async delay(ms: number) {
      timing.clock += ms;
    },
  };
  return timing;
}

describe("runSessionWakeAndReread 唤醒→轮询补库→重读编排", () => {
  it("唤醒成功且补库到达：轮询到行签名变化即提前收口（不再继续轮询）", async () => {
    let rereadCount = 0;
    let delayCount = 0;
    const signature = vi.fn(() => (rereadCount >= 2 ? "old-a:1|old-b:2" : ""));
    const result = await runSessionWakeAndReread(
      {
        wake: vi.fn(async () => true),
        reread: vi.fn(async () => {
          rereadCount += 1;
          return undefined;
        }),
        signature,
      },
      {
        now: () => 0,
        async delay() {
          delayCount += 1;
        },
      },
    );

    expect(result).toEqual({ woke: true, changed: true });
    expect(rereadCount).toBe(2); // 第 1 轮签名未变，第 2 轮补库写入
    expect(delayCount).toBe(1);
    // baseline 1 次 + 每轮重读后各 1 次。
    expect(signature).toHaveBeenCalledTimes(3);
  });

  it("唤醒成功但补库超时未到：窗口内继续轮询，到 deadline 停止且不空转", async () => {
    const timing = createFakeTiming();
    let rereadCount = 0;
    const result = await runSessionWakeAndReread(
      {
        wake: async () => true,
        reread: async () => {
          rereadCount += 1;
          return undefined;
        },
        signature: () => "same:0",
      },
      timing,
    );

    expect(result).toEqual({ woke: true, changed: false });
    // 每轮 delay 推进 400ms；deadline=5000 → 首轮重读后再轮 ceil(5000/400)=13 次。
    const expectedPolls = Math.ceil(SESSION_REFRESH_WAKE_TIMEOUT_MS / SESSION_REFRESH_POLL_INTERVAL_MS) + 1;
    expect(rereadCount).toBe(expectedPolls);
    expect(timing.clock).toBeGreaterThanOrEqual(SESSION_REFRESH_WAKE_TIMEOUT_MS);
  });

  it("唤醒明确不可用（provider 未就绪 available=false）：不进轮询，只重读一次（Phase 1 语义）", async () => {
    let delayCount = 0;
    const reread = vi.fn(async () => undefined);
    const result = await runSessionWakeAndReread(
      {
        wake: vi.fn(async () => false),
        reread,
        signature: () => "whatever:0",
      },
      {
        now: () => 0,
        async delay() {
          delayCount += 1;
        },
      },
    );

    expect(result).toEqual({ woke: false, changed: false });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(delayCount).toBe(0);
  });

  it("无法安全唤醒（远端未连接 wake=null）与唤醒抛错：同样只重读一次，不吞重读", async () => {
    const rereadNull = vi.fn(async () => undefined);
    expect(
      await runSessionWakeAndReread(
        { wake: async () => null, reread: rereadNull, signature: () => "" },
        { now: () => 0, async delay() {} },
      ),
    ).toEqual({ woke: false, changed: false });
    expect(rereadNull).toHaveBeenCalledTimes(1);

    const rereadThrow = vi.fn(async () => undefined);
    expect(
      await runSessionWakeAndReread(
        {
          wake: vi.fn(async () => {
            throw new Error("host unreachable");
          }),
          reread: rereadThrow,
          signature: () => "",
        },
        { now: () => 0, async delay() {} },
      ),
    ).toEqual({ woke: false, changed: false });
    expect(rereadThrow).toHaveBeenCalledTimes(1);
  });

  it("唤醒首轮重读就发现补库：changed=true 且只重读一次", async () => {
    let rereadCount = 0;
    const result = await runSessionWakeAndReread(
      {
        wake: async () => true,
        reread: vi.fn(async () => {
          rereadCount += 1;
          return undefined;
        }),
        signature: () => (rereadCount > 0 ? "seeded:9" : ""),
      },
      { now: () => 0, async delay() {} },
    );
    expect(result).toEqual({ woke: true, changed: true });
    expect(rereadCount).toBe(1);
  });
});

// ── Phase 2：唤醒目标 / 服务解析 / 行签名 ─────────────────────────────────────

describe("buildSessionRefreshWakeTarget / resolveSessionWakeService / projectTaskListSignature", () => {
  it("本地项目取主根 workspace，不带 identity；无 root 返回 null", () => {
    expect(
      buildSessionRefreshWakeTarget({
        hostId: "local",
        roots: [
          { rootPath: "/w/secondary", position: 1, isPrimary: false },
          { rootPath: "/w/primary", position: 0, isPrimary: true },
        ],
      }),
    ).toEqual({ workspacePath: "/w/primary" });
    expect(buildSessionRefreshWakeTarget({ hostId: "local", roots: [] })).toBeNull();
  });

  it("远端项目带 host 前缀 identity（与 useProjectTree scopes 同一构造规则）", () => {
    // 远端 hostId 本身是远端 host 根的 workspace identity（remote:* 前缀），可被统一解析。
    const target = buildSessionRefreshWakeTarget({
      hostId: "remote:ssh:myhost:22:me",
      roots: [{ rootPath: "/remote/work", position: 0, isPrimary: true }],
    });
    expect(target?.workspacePath).toBe("/remote/work");
    expect(target?.workspaceIdentity).toBe("remote:ssh:myhost:22:me:/remote/work");
  });

  it("本地目标解析到根 services 的 zcodeSessionService；缺根 services 时返回 null 不误判", () => {
    const sessionService = { initializeWorkspace: async () => ({ available: true }) };
    expect(
      resolveSessionWakeService({
        target: { workspacePath: "/w/primary" },
        baseServices: { zcodeSessionService: sessionService },
        remoteSessions: {
          baseServices: null,
          sessionsById: {},
          sessionIdByWorkspacePath: {},
          sessionIdByWorkspaceIdentity: {},
        },
      }),
    ).toBe(sessionService);
    expect(
      resolveSessionWakeService({
        target: { workspacePath: "/w/primary" },
        baseServices: null,
        remoteSessions: {
          baseServices: null,
          sessionsById: {},
          sessionIdByWorkspacePath: {},
          sessionIdByWorkspaceIdentity: {},
        },
      }),
    ).toBeNull();
  });

  it("远端目标必须解析到已连接 session；解析不到返回 null（绝不回落本机 Host）", () => {
    const remoteSessionService = { initializeWorkspace: async () => ({ available: true }) };
    const remoteSessions = {
      baseServices: { zcodeSessionService: { initializeWorkspace: async () => ({ available: true }) } },
      sessionsById: { "session-1": { services: { zcodeSessionService: remoteSessionService } } },
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: { "remote:ssh:myhost:22:me:/remote/work": "session-1" },
    };
    expect(
      resolveSessionWakeService({
        target: {
          workspacePath: "/remote/work",
          workspaceIdentity: "remote:ssh:myhost:22:me:/remote/work",
        },
        baseServices: null,
        remoteSessions,
      }),
    ).toBe(remoteSessionService);

    // identity 无对应 session：resolved 为 null / 本机占位 → null。
    expect(
      resolveSessionWakeService({
        target: {
          workspacePath: "/remote/other",
          workspaceIdentity: "remote:ssh:myhost:22:me:/remote/other",
        },
        baseServices: null,
        remoteSessions,
      }),
    ).toBeNull();
    // 目标缺失（数据残缺项目行）：null。
    expect(
      resolveSessionWakeService({
        target: null,
        baseServices: null,
        remoteSessions,
      }),
    ).toBeNull();
  });

  it("行签名由 taskId+updatedAt 组成；补库写入新行必然改变签名", () => {
    const before = projectTaskListSignature([{ taskId: "a", updatedAt: 1 }]);
    const after = projectTaskListSignature([
      { taskId: "a", updatedAt: 1 },
      { taskId: "b", updatedAt: 42 },
    ]);
    expect(before).toBe("a:1");
    expect(after).toBe("a:1|b:42");
    expect(before).not.toBe(after);
    // 同一行的 updatedAt 变化（标题/状态镜像）同样算变化，避免只数条数漏报。
    expect(projectTaskListSignature([{ taskId: "a", updatedAt: 2 }])).not.toBe(before);
  });
});

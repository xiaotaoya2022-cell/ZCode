// [OmniCode] D12 请求接管流单测（spec: docs/omnicode/profile-runtime.md §批次3 D12）：
// - 七态机 transitionOmnicodeTakeover 全迁移矩阵（受理/并发 busy/回执四码/断连/死线/
//   取消槽保留/迟到回执丢弃/reset 清槽）；
// - 桥命令 schema（上行 request/reply/cancel + 下行 forward/result：strict 拒绝多余键、
//   requestId 形态白名单、result 必带 workspacePath——观察者按路径结算槽）；
// - 管理器协调器（takeoverCoordinator，fake deps）：转投持有者、并发后来者 busy、
//   持有者离线即时回、无主锁直接 accepted、观察者取消后迟到回执静默丢弃（观察者收不到
//   任何下行）、持有者回执 accepted 通知观察者并带 workspacePath/holderName。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OMNICODE_TAKEOVER_MANAGER_REPLY_DEADLINE_MS,
  omnicodeTakeoverCancelMessageSchema,
  omnicodeTakeoverForwardCommandSchema,
  omnicodeTakeoverReplyMessageSchema,
  omnicodeTakeoverRequestMessageSchema,
  omnicodeTakeoverResultCommandSchema,
  transitionOmnicodeTakeover,
  type OmnicodeTakeoverMachineState,
  type OmnicodeTakeoverPendingRequest,
} from "@zcode/shared";
import {
  handleOmnicodeTakeoverCancelFromInstance,
  handleOmnicodeTakeoverInstanceDisconnected,
  handleOmnicodeTakeoverReplyFromInstance,
  handleOmnicodeTakeoverRequestFromInstance,
  resetOmnicodeTakeoverCoordinatorForTest,
  setupOmnicodeTakeoverCoordinator,
  type OmnicodeTakeoverManagerDeps,
} from "../src/main/omnicode/takeoverCoordinator.js";

const REQUESTER = "paaaaaaaa";
const HOLDER = "pbbbbbbbb";
const OTHER_REQUESTER = "pcccccccc";

function pendingRequest(overrides: Partial<OmnicodeTakeoverPendingRequest> = {}): OmnicodeTakeoverPendingRequest {
  return {
    requestId: "tk-00000000-0000-0000-0000-000000000001",
    workspacePath: "F:\\work\\demo",
    requesterProfileId: REQUESTER,
    requesterName: "观察者实例",
    holderProfileId: HOLDER,
    holderName: "持有者实例",
    ...overrides,
  };
}

describe("D12 七态机 transitionOmnicodeTakeover", () => {
  const IDLE: OmnicodeTakeoverMachineState = { status: "idle" };

  it("idle 收 request → requested，无立即回执", () => {
    const transition = transitionOmnicodeTakeover(IDLE, { type: "request", request: pendingRequest() });
    expect(transition.state.status).toBe("requested");
    expect(transition.state.request?.requesterProfileId).toBe(REQUESTER);
    expect(transition.replyOutcome).toBeNull();
  });

  it("requested 收第二 request → busy 且不占槽（后来者不改变在途状态）", () => {
    const requested = transitionOmnicodeTakeover(IDLE, { type: "request", request: pendingRequest() }).state;
    const transition = transitionOmnicodeTakeover(requested, {
      type: "request",
      request: pendingRequest({ requestId: "tk-second-req", requesterProfileId: OTHER_REQUESTER }),
    });
    expect(transition.state).toBe(requested);
    expect(transition.replyOutcome).toBe("busy");
  });

  it("holder-reply 四码：accepted / timeout 直达终态；denied 透传；close-failed 归 denied 带原因与回执码", () => {
    const requested = transitionOmnicodeTakeover(IDLE, { type: "request", request: pendingRequest() }).state;
    expect(
      transitionOmnicodeTakeover(requested, { type: "holder-reply", outcome: "accepted" }),
    ).toMatchObject({ state: { status: "accepted" }, replyOutcome: "accepted" });
    expect(
      transitionOmnicodeTakeover(requested, { type: "holder-reply", outcome: "timeout" }),
    ).toMatchObject({ state: { status: "timeout" }, replyOutcome: "timeout" });
    expect(
      transitionOmnicodeTakeover(requested, { type: "holder-reply", outcome: "denied" }),
    ).toMatchObject({ state: { status: "denied" }, replyOutcome: "denied" });
    const failed = transitionOmnicodeTakeover(requested, {
      type: "holder-reply",
      outcome: "close-failed",
      reason: "保存冲突",
    });
    expect(failed.state.status).toBe("denied");
    expect(failed.state.reason).toBe("保存冲突");
    expect(failed.replyOutcome).toBe("close-failed");
    expect(failed.replyReason).toBe("保存冲突");
  });

  it("holder-disconnected：requested → holder-offline 回观察者；cancelled → idle 清槽；idle/终态不变", () => {
    const requested = transitionOmnicodeTakeover(IDLE, { type: "request", request: pendingRequest() }).state;
    expect(
      transitionOmnicodeTakeover(requested, { type: "holder-disconnected" }),
    ).toMatchObject({ state: { status: "holder-offline" }, replyOutcome: "holder-offline" });

    const cancelled = transitionOmnicodeTakeover(requested, { type: "cancel" }).state;
    expect(transitionOmnicodeTakeover(cancelled, { type: "holder-disconnected" }).state).toEqual({ status: "idle" });
    expect(transitionOmnicodeTakeover(IDLE, { type: "holder-disconnected" })).toEqual({
      state: IDLE,
      replyOutcome: null,
    });
  });

  it("deadline：requested → timeout；cancelled → idle；其余不变", () => {
    const requested = transitionOmnicodeTakeover(IDLE, { type: "request", request: pendingRequest() }).state;
    expect(transitionOmnicodeTakeover(requested, { type: "deadline" })).toMatchObject({
      state: { status: "timeout" },
      replyOutcome: "timeout",
    });
    const cancelled = transitionOmnicodeTakeover(requested, { type: "cancel" }).state;
    expect(transitionOmnicodeTakeover(cancelled, { type: "deadline" }).state).toEqual({ status: "idle" });
  });

  it("cancel：requested → cancelled（槽保留、无回执）；迟到 holder-reply 静默丢弃；reset 归 idle", () => {
    const requested = transitionOmnicodeTakeover(IDLE, { type: "request", request: pendingRequest() }).state;
    const cancelled = transitionOmnicodeTakeover(requested, { type: "cancel" });
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.state.request?.requestId).toBe(requested.request?.requestId);
    expect(cancelled.replyOutcome).toBeNull();

    const late = transitionOmnicodeTakeover(cancelled.state, { type: "holder-reply", outcome: "accepted" });
    expect(late.state.status).toBe("cancelled");
    expect(late.replyOutcome).toBeNull();

    const reset = transitionOmnicodeTakeover(cancelled.state, { type: "reset" });
    expect(reset.state).toEqual({ status: "idle" });
    expect(reset.replyOutcome).toBeNull();
  });

  it("终态槽收到新 request → busy（防御分支：协调器回执后即刻清槽，此路径不可达但状态机兜底）", () => {
    const accepted = transitionOmnicodeTakeover(
      transitionOmnicodeTakeover(IDLE, { type: "request", request: pendingRequest() }).state,
      { type: "holder-reply", outcome: "accepted" },
    ).state;
    const transition = transitionOmnicodeTakeover(accepted, { type: "request", request: pendingRequest() });
    expect(transition.replyOutcome).toBe("busy");
  });
});

describe("D12 桥命令 schema", () => {
  it("上行 takeoverRequest：合法载荷通过；多余键 strict 拒绝；requestId 形态白名单", () => {
    expect(
      omnicodeTakeoverRequestMessageSchema.safeParse({
        type: "takeoverRequest",
        requestId: "tk-abc.123_xyz:y",
        workspacePath: "F:\\work\\demo",
        requesterName: "观察者",
      }).success,
    ).toBe(true);
    expect(
      omnicodeTakeoverRequestMessageSchema.safeParse({
        type: "takeoverRequest",
        requestId: "tk-abc",
        workspacePath: "F:\\work\\demo",
        // requesterProfileId 是管理器注入字段——上行自报必须被 strict 拒绝（防伪造）
        requesterProfileId: REQUESTER,
      }).success,
    ).toBe(false);
    expect(
      omnicodeTakeoverRequestMessageSchema.safeParse({
        type: "takeoverRequest",
        requestId: "短",
        workspacePath: "F:\\work\\demo",
      }).success,
    ).toBe(false);
  });

  it("上行 takeoverReply：四码合法；cancelled 不是持有者可报码（拒绝）", () => {
    for (const outcome of ["accepted", "denied", "timeout", "close-failed"] as const) {
      expect(
        omnicodeTakeoverReplyMessageSchema.safeParse({ type: "takeoverReply", requestId: "tk-abc.123_xyz:y", outcome })
          .success,
      ).toBe(true);
    }
    expect(
      omnicodeTakeoverReplyMessageSchema.safeParse({
        type: "takeoverReply",
        requestId: "tk-abc.123_xyz:y",
        outcome: "cancelled",
      }).success,
    ).toBe(false);
  });

  it("上行 takeoverCancel：requestId 必填", () => {
    expect(omnicodeTakeoverCancelMessageSchema.safeParse({ type: "takeoverCancel", requestId: "tk-abc.123_xyz:y" }).success).toBe(true);
    expect(omnicodeTakeoverCancelMessageSchema.safeParse({ type: "takeoverCancel" }).success).toBe(false);
  });

  it("下行 forward：requesterProfileId 形态白名单（p 前缀 8-20 位小写十六进制风格）", () => {
    expect(
      omnicodeTakeoverForwardCommandSchema.safeParse({
        type: "takeoverRequest",
        requestId: "tk-abc.123_xyz:y",
        workspacePath: "F:\\work\\demo",
        requesterProfileId: REQUESTER,
        requesterName: "观察者",
      }).success,
    ).toBe(true);
    expect(
      omnicodeTakeoverForwardCommandSchema.safeParse({
        type: "takeoverRequest",
        requestId: "tk-abc.123_xyz:y",
        workspacePath: "F:\\work\\demo",
        requesterProfileId: "../evil",
        requesterName: "观察者",
      }).success,
    ).toBe(false);
  });

  it("下行 result：workspacePath 必带（观察者按路径结算 pending 槽）+ holderName 可选", () => {
    expect(
      omnicodeTakeoverResultCommandSchema.safeParse({
        type: "takeoverResult",
        requestId: "tk-abc.123_xyz:y",
        workspacePath: "F:\\work\\demo",
        outcome: "denied",
        reason: "user",
        holderName: "持有者实例",
      }).success,
    ).toBe(true);
    const withoutPath = omnicodeTakeoverResultCommandSchema.safeParse({
      type: "takeoverResult",
      requestId: "tk-abc.123_xyz:y",
      outcome: "denied",
    });
    expect(withoutPath.success).toBe(false);
  });
});

describe("D12 管理器协调器（fake deps 装配语义）", () => {
  interface SentCommand {
    profileId: string;
    command: Record<string, unknown>;
  }
  let connected: string[];
  let sent: SentCommand[];
  let lockOwner: { profileId: string; displayName?: string } | undefined;
  let deps: OmnicodeTakeoverManagerDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    connected = [REQUESTER, HOLDER];
    sent = [];
    lockOwner = { profileId: HOLDER, displayName: "持有者实例" };
    deps = {
      readLockOwner: () => lockOwner,
      getConnectedProfileIds: () => connected,
      sendCommand: (profileId, command) => {
        sent.push({ profileId, command: command as Record<string, unknown> });
        return connected.includes(profileId);
      },
      resolveProfileDisplayName: async (profileId) =>
        profileId === REQUESTER ? "注册表名-观察者" : null,
    };
    setupOmnicodeTakeoverCoordinator(deps);
  });

  afterEach(() => {
    resetOmnicodeTakeoverCoordinatorForTest();
    vi.useRealTimers();
  });

  function sentTo(profileId: string): Record<string, unknown>[] {
    return sent.filter((entry) => entry.profileId === profileId).map((entry) => entry.command);
  }

  it("完整闭环：请求转投持有者（名字取注册表）→ 同意回执 → 观察者收 accepted（带 workspacePath）", async () => {
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000001",
      workspacePath: "F:\\work\\demo",
    });
    const toHolder = sentTo(HOLDER);
    expect(toHolder).toHaveLength(1);
    expect(toHolder[0]).toMatchObject({
      type: "takeoverRequest",
      requesterProfileId: REQUESTER,
      requesterName: "注册表名-观察者",
      workspacePath: "F:\\work\\demo",
    });

    handleOmnicodeTakeoverReplyFromInstance(HOLDER, {
      type: "takeoverReply",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000001",
      outcome: "accepted",
    });
    const toObserver = sentTo(REQUESTER);
    expect(toObserver).toHaveLength(1);
    expect(toObserver[0]).toMatchObject({
      type: "takeoverResult",
      outcome: "accepted",
      workspacePath: "F:\\work\\demo",
    });
  });

  it("拒绝回执通知观察者并携带 holderName（toast 插值）", async () => {
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000002",
      workspacePath: "F:\\work\\demo",
    });
    handleOmnicodeTakeoverReplyFromInstance(HOLDER, {
      type: "takeoverReply",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000002",
      outcome: "denied",
    });
    expect(sentTo(REQUESTER)[0]).toMatchObject({
      outcome: "denied",
      holderName: "持有者实例",
      workspacePath: "F:\\work\\demo",
    });
  });

  it("并发后来者：busy 即时回，持有者只收到第一份转发", async () => {
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000003",
      workspacePath: "F:\\work\\demo",
    });
    await handleOmnicodeTakeoverRequestFromInstance(OTHER_REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-bbbbbbbb-0000-0000-0000-000000000003",
      workspacePath: "F:\\work\\demo",
    });
    expect(sentTo(HOLDER)).toHaveLength(1);
    expect(sentTo(OTHER_REQUESTER)[0]).toMatchObject({ outcome: "busy" });
  });

  it("持有者未连桥：holder-offline 即时回观察者，不转发", async () => {
    connected = [REQUESTER];
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000004",
      workspacePath: "F:\\work\\demo",
    });
    expect(sentTo(HOLDER)).toHaveLength(0);
    expect(sentTo(REQUESTER)[0]).toMatchObject({ outcome: "holder-offline" });
  });

  it("无主锁（持有者已释放）：直接 accepted（重开即拿锁，等价闭环）", async () => {
    lockOwner = undefined;
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000005",
      workspacePath: "F:\\work\\demo",
    });
    expect(sentTo(REQUESTER)[0]).toMatchObject({ outcome: "accepted", workspacePath: "F:\\work\\demo" });
    expect(sentTo(HOLDER)).toHaveLength(0);
  });

  it("观察者取消后：持有者迟到回执被静默丢弃（观察者收不到任何下行）", async () => {
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000006",
      workspacePath: "F:\\work\\demo",
    });
    handleOmnicodeTakeoverCancelFromInstance(REQUESTER, {
      type: "takeoverCancel",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000006",
    });
    handleOmnicodeTakeoverReplyFromInstance(HOLDER, {
      type: "takeoverReply",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000006",
      outcome: "accepted",
    });
    expect(sentTo(REQUESTER)).toHaveLength(0);
  });

  it("持有者断连对账：holder-offline 即时回观察者", async () => {
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000007",
      workspacePath: "F:\\work\\demo",
    });
    handleOmnicodeTakeoverInstanceDisconnected(HOLDER);
    expect(sentTo(REQUESTER)[0]).toMatchObject({ outcome: "holder-offline" });
  });

  it("审计 R1 P2-2 双角色：断连实例既是持有者又是另一槽请求者——两角色各自收敛不早退", async () => {
    // 槽 1：OTHER_REQUESTER 请求、HOLDER 持有（工作区 A）
    lockOwner = { profileId: HOLDER, displayName: "持有者实例" };
    await handleOmnicodeTakeoverRequestFromInstance(OTHER_REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-cccccccc-0000-0000-0000-000000000010",
      workspacePath: "F:\\work\\a",
    });
    // 槽 2：HOLDER 请求、REQUESTER 持有（工作区 B）——HOLDER 同人双角色
    lockOwner = { profileId: REQUESTER, displayName: "请求者也持有" };
    const sentBefore = sent.length;
    await handleOmnicodeTakeoverRequestFromInstance(HOLDER, {
      type: "takeoverRequest",
      requestId: "tk-cccccccc-0000-0000-0000-000000000011",
      workspacePath: "F:\\work\\b",
    });
    // 转投 REQUESTER（槽 2 持有者）
    expect(sent.slice(sentBefore).some((e) => e.profileId === REQUESTER)).toBe(true);

    // HOLDER 断连：作为槽 1 持有者 → OTHER_REQUESTER 收 holder-offline；
    // 作为槽 2 请求者 → REQUESTER 的槽被标记 cancelled（其迟到回执将被静默丢弃）。
    handleOmnicodeTakeoverInstanceDisconnected(HOLDER);
    expect(sentTo(OTHER_REQUESTER).some((c) => c.outcome === "holder-offline")).toBe(true);
    handleOmnicodeTakeoverReplyFromInstance(REQUESTER, {
      type: "takeoverReply",
      requestId: "tk-cccccccc-0000-0000-0000-000000000011",
      outcome: "accepted",
    });
    // cancelled 槽迟到回执：HOLDER 已不等待 → 静默丢弃（无任何下行给 HOLDER）
    expect(sentTo(HOLDER).every((c) => c.type !== "takeoverResult")).toBe(true);
  });

  it("回执死线 45s：无人回执 → timeout 收口（vi 假时钟推进）", async () => {
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000008",
      workspacePath: "F:\\work\\demo",
    });
    vi.advanceTimersByTime(OMNICODE_TAKEOVER_MANAGER_REPLY_DEADLINE_MS + 1);
    expect(sentTo(REQUESTER)[0]).toMatchObject({ outcome: "timeout" });
  });

  it("requestId 不匹配的回执（串扰/迟到）：静默丢弃", async () => {
    await handleOmnicodeTakeoverRequestFromInstance(REQUESTER, {
      type: "takeoverRequest",
      requestId: "tk-aaaaaaaa-0000-0000-0000-000000000009",
      workspacePath: "F:\\work\\demo",
    });
    handleOmnicodeTakeoverReplyFromInstance(HOLDER, {
      type: "takeoverReply",
      requestId: "tk-zzzzzzzz-0000-0000-0000-000000000009",
      outcome: "accepted",
    });
    expect(sentTo(REQUESTER)).toHaveLength(0);
  });
});

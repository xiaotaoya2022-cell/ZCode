// [OmniCode] B2 评审修复单测（桥/内嵌域）：
// - P1-2 预览开关关闭时实例连接不产生订阅（连接即时对账，spec §批次2 D9 修订）
// - P2-10 桥后连踢前连：被顶替连接的 close 不触发 disconnected 通知
// - P1-3 owned 登记决策纯函数：成功登记 / 失败不登记（重试）+ 候选过滤
// 模块级状态（桥 server / consoleEmbedding previewState）为单例——本文件按序执行，
// 共享同一桥服务实例。
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// electron 仅在桥广播路径使用（BrowserWindow.getAllWindows）——mock 掉使 main 侧
// 模块可在 node 测试进程导入执行。
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
// 本文件验证 omnicode 管理器行为：把编译期 flavor 覆写为 omnicode（其余导出保持原样）
vi.mock("@zcode/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/shared")>();
  return { ...original, ZCODE_PRODUCT_FLAVOR: "omnicode" as const };
});

import {
  ensureOmnicodeInstanceBridgeServerStarted,
  setOmnicodeInstanceBridgeManagerHooks,
  shouldAutoSubscribeThumbnailsOnConnect,
} from "../src/main/omnicode/instanceBridgeServer.js";
import {
  applyOmnicodePreviewState,
  notifyOmnicodeInstanceConnected,
  notifyOmnicodeInstanceDisconnected,
  resolveOmnicodeOwnCandidates,
  resolveOmnicodeOwnedRegistrationOutcome,
} from "../src/main/omnicode/consoleEmbedding.js";

const PROFILE_ID = "previewview1";

interface ReceivedMessage {
  type?: string;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBridgeSocket(
  port: number,
  token: string,
  profileId: string,
  onMessage?: (message: ReceivedMessage) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&profileId=${profileId}`);
    // message 监听必须在 open 之前挂接：服务端在连接握手期即可能下发命令帧，
    // open 之后才挂会丢帧（EventEmitter 无监听即丢弃）
    if (onMessage) ws.on("message", (data) => {
      try {
        onMessage(JSON.parse(String(data)) as ReceivedMessage);
      } catch {
        /* 忽略坏帧 */
      }
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}


describe("omnicode review fix P1-3: owned registration decision (pure)", () => {
  it("resolveOmnicodeOwnCandidates：非 win32 / 无管理器 HWND → 空；已登记与无 HWND 跳过", () => {
    const hwnds = new Map([
      ["pa123456789", "0x1a2b"],
      ["pb123456789", "0x3c4d"],
    ]);
    const owned = new Set(["pa123456789"]);
    const base = {
      managerHwndHex: "0xdeadbeef",
      ownedProfileIds: owned,
      hwndHexByProfileId: hwnds,
    };
    expect(resolveOmnicodeOwnCandidates({ ...base, platform: "linux", profileIds: ["pa123456789"] })).toEqual([]);
    expect(resolveOmnicodeOwnCandidates({ ...base, platform: "win32", managerHwndHex: null, profileIds: ["pa123456789"] })).toEqual([]);
    expect(
      resolveOmnicodeOwnCandidates({
        ...base,
        platform: "win32",
        profileIds: ["pa123456789", "pb123456789", "pc123456789"],
      }),
    ).toEqual([{ profileId: "pb123456789", child: "0x3c4d", owner: "0xdeadbeef" }]);
  });

  it("登记决策：PowerShell 成功 → registered；失败 → retry（不登记，下轮重试）", () => {
    expect(resolveOmnicodeOwnedRegistrationOutcome(["pa123456789"], true)).toEqual({
      kind: "registered",
      profileIds: ["pa123456789"],
    });
    expect(resolveOmnicodeOwnedRegistrationOutcome(["pa123456789", "pb123456789"], false)).toEqual({
      kind: "retry",
      profileIds: ["pa123456789", "pb123456789"],
    });
  });
});

describe("omnicode review fix P1-2 + P2-10: bridge connect reconciliation & replaced connection", () => {
  it("shouldAutoSubscribeThumbnailsOnConnect：仅官方 flavor 保留连上即订阅", () => {
    expect(shouldAutoSubscribeThumbnailsOnConnect("omnicode")).toBe(false);
    expect(shouldAutoSubscribeThumbnailsOnConnect("production")).toBe(true);
    expect(shouldAutoSubscribeThumbnailsOnConnect("preview")).toBe(true);
  });

  it("预览开关关闭时实例连接不产生订阅（连接即时对账补发退订）", async () => {
    // 管理器侧先声明预览总开关关闭（可见集合为空）
    applyOmnicodePreviewState({ previewEnabled: false, visibleProfileIds: [] });
    setOmnicodeInstanceBridgeManagerHooks({
      onInstanceConnected: (profileId) => notifyOmnicodeInstanceConnected(profileId),
      onInstanceDisconnected: (profileId) => notifyOmnicodeInstanceDisconnected(profileId),
    });
    const bridge = await ensureOmnicodeInstanceBridgeServerStarted();
    const types: string[] = [];
    const ws = await openBridgeSocket(bridge.port, bridge.token, PROFILE_ID, (message) => {
      if (typeof message.type === "string") types.push(message.type);
    });
    try {
      await waitMs(300);
      // 连接不隐含订阅：不得出现 subscribeThumbnails（v0 自动订阅已收窄为官方 flavor）
      expect(types).not.toContain("subscribeThumbnails");
      // 连接即时对账：预览关 → 补发 unsubscribeThumbnails 纠正任何残余订阅态
      expect(types).toContain("unsubscribeThumbnails");
    } finally {
      ws.close();
      await waitMs(100);
    }
  });

  it("后连踢前连：被顶替连接的 close 不触发 disconnected（仅当前登记连接断开才通知）", async () => {
    const disconnected: string[] = [];
    setOmnicodeInstanceBridgeManagerHooks({
      onInstanceConnected: () => undefined,
      onInstanceDisconnected: (profileId) => {
        disconnected.push(profileId);
        notifyOmnicodeInstanceDisconnected(profileId);
      },
    });
    const bridge = await ensureOmnicodeInstanceBridgeServerStarted();
    const first = await openBridgeSocket(bridge.port, bridge.token, PROFILE_ID);
    const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    await waitMs(100);
    expect(disconnected).toEqual([]);

    // 同 profileId 二次回连 → 服务端关闭第一条（后连踢前连）
    const second = await openBridgeSocket(bridge.port, bridge.token, PROFILE_ID);
    await firstClosed; // 被顶替连接确实关闭
    await waitMs(150);
    // 旧连接的 close 不代表实例断开（当前登记连接是 second）
    expect(disconnected).toEqual([]);

    // 当前登记连接断开 → 恰一次 disconnected 通知
    second.close();
    await waitMs(200);
    expect(disconnected).toEqual([PROFILE_ID]);
  });
});

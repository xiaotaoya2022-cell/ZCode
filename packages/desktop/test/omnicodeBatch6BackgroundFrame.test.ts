// [OmniCode] 后台降载单测：实例预览帧生产三档决策（停帧 paused / 降帧 inactive / 正常
// active）与停帧态翻转广播决策（instanceBridgeClient 纯函数）。spec:
// docs/omnicode/profile-runtime.md §后台降载。
// 写法参照 omnicodeBatch25Extras.test.ts（纯函数 + electron/本地模块 mock 边界）。
import { describe, expect, it, vi } from "vitest";

// ─── mocks：instanceBridgeClient 顶层导入 electron(ws/globalPrefs)；纯函数测试不触窗口 ───

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("ws", () => ({ default: class FakeWebSocket {} }));
vi.mock("../src/main/omnicode/globalPrefs.js", () => ({
  handleOmnicodeGlobalPrefsApplyCommand: async () => undefined,
}));

import {
  CAPTURE_INTERVAL_MS,
  CAPTURE_INTERVAL_INACTIVE_MS,
  resolveOmnicodeCaptureFramePolicy,
  resolveOmnicodeCaptureIntervalMs,
  resolveOmnicodeFramePausedBroadcast,
  type OmnicodeCaptureFramePolicy,
} from "../src/main/omnicode/instanceBridgeClient.js";

describe("omnicode background load: capture frame policy (tier2 pause + tier1 throttle)", () => {
  it("停帧档：窗口不可见（停靠 hide）→ paused", () => {
    expect(
      resolveOmnicodeCaptureFramePolicy({ visible: false, minimized: false, focused: false }),
    ).toBe("paused");
  });

  it("停帧档：最小化 → paused（可见性掩蔽下的窗口仍不产帧）", () => {
    expect(
      resolveOmnicodeCaptureFramePolicy({ visible: true, minimized: true, focused: false }),
    ).toBe("paused");
    expect(
      resolveOmnicodeCaptureFramePolicy({ visible: true, minimized: true, focused: true }),
    ).toBe("paused");
  });

  it("降帧档：可见但失焦（非活动）→ inactive", () => {
    expect(
      resolveOmnicodeCaptureFramePolicy({ visible: true, minimized: false, focused: false }),
    ).toBe("inactive");
  });

  it("正常档：可见且聚焦 → active", () => {
    expect(
      resolveOmnicodeCaptureFramePolicy({ visible: true, minimized: false, focused: true }),
    ).toBe("active");
  });

  it("分支优先序：paused 先于 inactive/active（不可见或最小化时失焦态不参与判定）", () => {
    const results = new Set<OmnicodeCaptureFramePolicy>([
      resolveOmnicodeCaptureFramePolicy({ visible: false, minimized: true, focused: false }),
      resolveOmnicodeCaptureFramePolicy({ visible: false, minimized: false, focused: true }),
      resolveOmnicodeCaptureFramePolicy({ visible: true, minimized: true, focused: true }),
    ]);
    expect(results).toEqual(new Set<OmnicodeCaptureFramePolicy>(["paused"]));
  });

  it("capture 间隔：inactive 降帧档 2000ms，active 正常档 700ms；降帧档严格慢于正常档", () => {
    expect(CAPTURE_INTERVAL_MS).toBe(700);
    expect(CAPTURE_INTERVAL_INACTIVE_MS).toBe(2000);
    expect(resolveOmnicodeCaptureIntervalMs("active")).toBe(CAPTURE_INTERVAL_MS);
    expect(resolveOmnicodeCaptureIntervalMs("inactive")).toBe(CAPTURE_INTERVAL_INACTIVE_MS);
    // paused 档调用方根本不产帧，间隔无意义（返回正常档常量占位，不参与调用路径）
    expect(resolveOmnicodeCaptureIntervalMs("paused")).toBe(CAPTURE_INTERVAL_MS);
    expect(resolveOmnicodeCaptureIntervalMs("inactive")).toBeGreaterThan(
      resolveOmnicodeCaptureIntervalMs("active"),
    );
  });
});

describe("omnicode background load: framePaused transition broadcast (pure)", () => {
  it("进入停帧：未通知态 + paused 档 → 广播 true", () => {
    expect(
      resolveOmnicodeFramePausedBroadcast({ policy: "paused", lastNotifiedPaused: false }),
    ).toBe(true);
  });

  it("稳态停帧：已通知态 + paused 档 → null（不重复广播）", () => {
    expect(
      resolveOmnicodeFramePausedBroadcast({ policy: "paused", lastNotifiedPaused: true }),
    ).toBeNull();
  });

  it("恢复：已通知停帧 + active/inactive 档 → 广播 false（离开 paused 即翻转）", () => {
    expect(
      resolveOmnicodeFramePausedBroadcast({ policy: "active", lastNotifiedPaused: true }),
    ).toBe(false);
    expect(
      resolveOmnicodeFramePausedBroadcast({ policy: "inactive", lastNotifiedPaused: true }),
    ).toBe(false);
  });

  it("稳态未停帧：未通知 + active/inactive 档 → null", () => {
    expect(
      resolveOmnicodeFramePausedBroadcast({ policy: "active", lastNotifiedPaused: false }),
    ).toBeNull();
    expect(
      resolveOmnicodeFramePausedBroadcast({ policy: "inactive", lastNotifiedPaused: false }),
    ).toBeNull();
  });
});

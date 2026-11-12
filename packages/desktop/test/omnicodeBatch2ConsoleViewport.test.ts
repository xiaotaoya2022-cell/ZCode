// [OmniCode] 批次2 B2-3 单测：内嵌布局纯函数 + 控制台 UI 状态决策（纯函数）。
// spec: docs/omnicode/profile-runtime.md §批次2 D9。
import { describe, expect, it } from "vitest";
import {
  convertOmnicodeClientRectToScreen,
  findOmnicodeEmbedRectForProfile,
  formatOmnicodeNativeHandleHex,
  isOmnicodeEmbedRectUsable,
  isValidOmnicodeHwndHex,
  OMNICODE_EMBED_MIN_WIDTH,
  OMNICODE_EMBED_MIN_HEIGHT,
} from "../src/main/omnicode/embedLayoutMath.js";
import {
  DEFAULT_OMNICODE_CONSOLE_UI_STATE,
  mergeOmnicodeConsoleUiState,
  resolveOmnicodeConsoleModeTransition,
  resolveOmnicodePreviewSubscriptions,
} from "../src/main/omnicode/consoleUiState.js";

describe("omnicode batch2 embedLayoutMath (D9)", () => {
  it("isOmnicodeEmbedRectUsable：有限非负整数且不低于内嵌最低规格", () => {
    expect(
      isOmnicodeEmbedRectUsable({
        profileId: "p1111111111",
        x: 100,
        y: 200,
        width: OMNICODE_EMBED_MIN_WIDTH,
        height: OMNICODE_EMBED_MIN_HEIGHT,
      }),
    ).toBe(true);
    expect(
      isOmnicodeEmbedRectUsable({
        profileId: "p1111111111",
        x: 100,
        y: 200,
        width: OMNICODE_EMBED_MIN_WIDTH - 1,
        height: OMNICODE_EMBED_MIN_HEIGHT,
      }),
    ).toBe(false);
    expect(
      isOmnicodeEmbedRectUsable({
        profileId: "p1111111111",
        x: 100,
        y: 200,
        width: OMNICODE_EMBED_MIN_WIDTH,
        height: OMNICODE_EMBED_MIN_HEIGHT - 1,
      }),
    ).toBe(false);
    // 非整数 / 负坐标 / 缺省全部拒绝
    expect(
      isOmnicodeEmbedRectUsable({ profileId: "p", x: 1.5, y: 0, width: 400, height: 300 }),
    ).toBe(false);
    expect(
      isOmnicodeEmbedRectUsable({ profileId: "p", x: -1, y: 0, width: 400, height: 300 }),
    ).toBe(false);
    expect(isOmnicodeEmbedRectUsable(undefined)).toBe(false);
  });

  it("findOmnicodeEmbedRectForProfile：按 profileId 滤出且不可用矩形视为无", () => {
    const own = { profileId: "p1111111111", x: 0, y: 0, width: 640, height: 400 };
    const other = { profileId: "p2222222222", x: 0, y: 0, width: 640, height: 400 };
    expect(findOmnicodeEmbedRectForProfile([other, own], "p1111111111")).toEqual(own);
    expect(findOmnicodeEmbedRectForProfile([other], "p1111111111")).toBeUndefined();
    expect(findOmnicodeEmbedRectForProfile(undefined, "p1111111111")).toBeUndefined();
    // 滤出了自己但尺寸退化（低于最低规格）→ 视为无（实例侧防御畸形值）
    expect(
      findOmnicodeEmbedRectForProfile(
        [{ profileId: "p1111111111", x: 0, y: 0, width: 10, height: 10 }],
        "p1111111111",
      ),
    ).toBeUndefined();
  });

  it("formatOmnicodeNativeHandleHex：little-endian 指针读取 + 零值/空缓冲拒绝", () => {
    // 0x000001a2b3c4d5e6（8 字节 LE 缓冲）
    const handle8 = Buffer.from([0xe6, 0xd5, 0xc4, 0xb3, 0xa2, 0x01, 0x00, 0x00]);
    expect(formatOmnicodeNativeHandleHex(handle8)).toBe("0x1a2b3c4d5e6");
    // 4 字节短缓冲按低位读取
    const handle4 = Buffer.from([0x34, 0x12, 0x00, 0x00]);
    expect(formatOmnicodeNativeHandleHex(handle4)).toBe("0x1234");
    expect(formatOmnicodeNativeHandleHex(Buffer.alloc(8))).toBeNull();
    expect(formatOmnicodeNativeHandleHex(Buffer.alloc(0))).toBeNull();
  });

  it("isValidOmnicodeHwndHex：0x 前缀 1..16 位 hex 白名单（trim 容忍）", () => {
    expect(isValidOmnicodeHwndHex("0x1a2b3c")).toBe(true);
    expect(isValidOmnicodeHwndHex("0x" + "f".repeat(16))).toBe(true);
    expect(isValidOmnicodeHwndHex(" 0x1a2b3c ")).toBe(true);
    expect(isValidOmnicodeHwndHex("1a2b3c")).toBe(false);
    expect(isValidOmnicodeHwndHex("0x" + "f".repeat(17))).toBe(false);
    expect(isValidOmnicodeHwndHex("0xGG11")).toBe(false);
    expect(isValidOmnicodeHwndHex("0x")).toBe(false);
    expect(isValidOmnicodeHwndHex(12345)).toBe(false);
  });

  it("convertOmnicodeClientRectToScreen：CSS px → 屏幕 DIP（zoom=1 恒等 / zoom≠1 按比例）", () => {
    const basisZoomOne = {
      contentX: 100,
      contentY: 50,
      contentWidth: 1200,
      contentHeight: 800,
      viewportWidth: 1200,
      viewportHeight: 800,
    };
    expect(
      convertOmnicodeClientRectToScreen(basisZoomOne, { x: 10, y: 20, width: 300, height: 200 }),
    ).toEqual({ x: 110, y: 70, width: 300, height: 200 });
    // zoom=2：content DIP = viewport CSS 的一半
    const basisZoomTwo = {
      contentX: 40,
      contentY: 30,
      contentWidth: 600,
      contentHeight: 400,
      viewportWidth: 1200,
      viewportHeight: 800,
    };
    expect(
      convertOmnicodeClientRectToScreen(basisZoomTwo, { x: 100, y: 100, width: 300, height: 200 }),
    ).toEqual({ x: 90, y: 80, width: 150, height: 100 });
    // 视口尺寸非法（0/NaN）拒绝换算
    expect(
      convertOmnicodeClientRectToScreen(
        { ...basisZoomOne, viewportWidth: 0 },
        { x: 0, y: 0, width: 10, height: 10 },
      ),
    ).toBeNull();
    expect(
      convertOmnicodeClientRectToScreen(
        { ...basisZoomOne, viewportHeight: Number.NaN },
        { x: 0, y: 0, width: 10, height: 10 },
      ),
    ).toBeNull();
  });
});

describe("omnicode batch2 consoleUiState (D9)", () => {
  it("mergeOmnicodeConsoleUiState：合法字段合并 / 非法与未知字段丢弃", () => {
    expect(mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, { mode: "desktop" })).toEqual(
      { mode: "desktop", previewEnabled: true },
    );
    expect(
      mergeOmnicodeConsoleUiState(
        { mode: "desktop", previewEnabled: true },
        { previewEnabled: false },
      ),
    ).toEqual({ mode: "desktop", previewEnabled: false });
    // 非法 mode / 非布尔 previewEnabled / 未知字段全部忽略
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        mode: "windowed",
        previewEnabled: 1,
        unknownField: true,
      } as unknown as Parameters<typeof mergeOmnicodeConsoleUiState>[1]),
    ).toEqual(DEFAULT_OMNICODE_CONSOLE_UI_STATE);
    expect(mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, undefined)).toEqual(
      DEFAULT_OMNICODE_CONSOLE_UI_STATE,
    );
  });

  it("resolveOmnicodeConsoleModeTransition：只有跨模式才触发 owned 编排", () => {
    expect(resolveOmnicodeConsoleModeTransition("embedded", "embedded")).toBe("none");
    expect(resolveOmnicodeConsoleModeTransition("desktop", "desktop")).toBe("none");
    expect(resolveOmnicodeConsoleModeTransition("desktop", "embedded")).toBe("enterEmbed");
    expect(resolveOmnicodeConsoleModeTransition("embedded", "desktop")).toBe("exitEmbed");
  });

  it("resolveOmnicodePreviewSubscriptions：订阅 = 总开关 ∧ 视口可见 ∧ 已连接", () => {
    const visible = ["p1111111111", "p3333333333"];
    const connected = ["p1111111111", "p2222222222", "p3333333333"];
    expect(
      resolveOmnicodePreviewSubscriptions({
        previewEnabled: true,
        visibleProfileIds: visible,
        connectedProfileIds: connected,
      }),
    ).toEqual(
      new Map([
        ["p1111111111", true],
        ["p2222222222", false],
        ["p3333333333", true],
      ]),
    );
    // 总开关关 = 全部退订（卡片停留最后一帧灰暗化）
    expect(
      resolveOmnicodePreviewSubscriptions({
        previewEnabled: false,
        visibleProfileIds: visible,
        connectedProfileIds: connected,
      }),
    ).toEqual(
      new Map([
        ["p1111111111", false],
        ["p2222222222", false],
        ["p3333333333", false],
      ]),
    );
  });
});

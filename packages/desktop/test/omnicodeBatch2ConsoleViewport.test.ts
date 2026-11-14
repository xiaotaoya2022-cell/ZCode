// [OmniCode] 批次2 B2-3 单测：内嵌布局纯函数 + 控制台 UI 状态决策（纯函数）。
// spec: docs/omnicode/profile-runtime.md §批次2 D9。
// [OmniCode] 批次3 停靠重构：旧全局 mode 语义退役——本文件 mode 相关断言重写为每实例
// 停靠语义（迁移/dock 决策/手柄数学/矩形钳制），embedLayoutMath 与预览订阅断言原样保留。
import { describe, expect, it } from "vitest";
import {
  clampOmnicodeScreenRectToEmbedMinimum,
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
  diffOmnicodeDockState,
  mergeOmnicodeConsoleUiState,
  migrateOmnicodeConsoleUiState,
  resolveOmnicodePreviewSubscriptions,
} from "../src/main/omnicode/consoleUiState.js";
import {
  resolveOmnicodeEmbedResizeHeightCss,
  resolveOmnicodeInstanceDocked,
} from "@zcode/shared";

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
  // [OmniCode] 批次3 停靠重构：旧 mode 合并断言重写为 dock 字段语义
  it("mergeOmnicodeConsoleUiState：dock 字段合并 / 非法与未知字段丢弃", () => {
    expect(mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, { dockDefault: false })).toEqual(
      { dockDefault: false, dockedByProfileId: {}, previewEnabled: true },
    );
    expect(
      mergeOmnicodeConsoleUiState(
        { dockDefault: false, dockedByProfileId: {}, previewEnabled: true },
        { previewEnabled: false },
      ),
    ).toEqual({ dockDefault: false, dockedByProfileId: {}, previewEnabled: false });
    // dockInstance 合法形态写覆盖键；profileId 非法 / docked 非布尔整体丢弃
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        dockInstance: { profileId: "p1111111111", docked: false },
      }),
    ).toEqual({ dockDefault: true, dockedByProfileId: { p1111111111: false }, previewEnabled: true });
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        dockInstance: { profileId: "", docked: false },
      }),
    ).toEqual(DEFAULT_OMNICODE_CONSOLE_UI_STATE);
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        dockInstance: { profileId: "p1111111111", docked: 1 as never },
      }),
    ).toEqual(DEFAULT_OMNICODE_CONSOLE_UI_STATE);
    // dockAll = dockDefault 直改 + 清空覆盖表
    expect(
      mergeOmnicodeConsoleUiState(
        { dockDefault: true, dockedByProfileId: { p1111111111: false }, previewEnabled: true },
        { dockAll: false },
      ),
    ).toEqual({ dockDefault: false, dockedByProfileId: {}, previewEnabled: true });
    expect(
      mergeOmnicodeConsoleUiState(
        { dockDefault: false, dockedByProfileId: { p1111111111: true }, previewEnabled: true },
        { dockAll: true },
      ),
    ).toEqual({ dockDefault: true, dockedByProfileId: {}, previewEnabled: true });
    // 非布尔 dockDefault / 非布尔 previewEnabled / 未知字段全部忽略；旧 mode 字段不再接受
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        dockDefault: 1,
        mode: "desktop",
        previewEnabled: 1,
        unknownField: true,
      } as unknown as Parameters<typeof mergeOmnicodeConsoleUiState>[1]),
    ).toEqual(DEFAULT_OMNICODE_CONSOLE_UI_STATE);
    expect(mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, undefined)).toEqual(
      DEFAULT_OMNICODE_CONSOLE_UI_STATE,
    );
  });

  it("migrateOmnicodeConsoleUiState：旧 mode 档一次性迁移（desktop→全拖出 / embedded→全停靠 / 无 mode 透传）", () => {
    // mode=desktop → dockDefault=false，mode 字段被剥离
    const desktopArchive = migrateOmnicodeConsoleUiState({ mode: "desktop", previewEnabled: false });
    expect(desktopArchive.migrated).toBe(true);
    expect(desktopArchive.state).toEqual({ previewEnabled: false, dockDefault: false, dockedByProfileId: {} });
    // mode=embedded → dockDefault=true
    const embeddedArchive = migrateOmnicodeConsoleUiState({ mode: "embedded", previewEnabled: true });
    expect(embeddedArchive.migrated).toBe(true);
    expect(embeddedArchive.state).toEqual({ previewEnabled: true, dockDefault: true, dockedByProfileId: {} });
    // 损坏 mode 值按缺省语义回停靠
    const corrupt = migrateOmnicodeConsoleUiState({ mode: "windowed" });
    expect(corrupt.migrated).toBe(true);
    expect(corrupt.state.dockDefault).toBe(true);
    // 无 mode 字段（新档案）原样透传，不置迁移标志
    const fresh = migrateOmnicodeConsoleUiState({ dockDefault: false, dockedByProfileId: { p1111111111: true } });
    expect(fresh.migrated).toBe(false);
    expect(fresh.state).toEqual({ dockDefault: false, dockedByProfileId: { p1111111111: true } });
    // 非 object（损坏档）→ 空 state 不迁移
    expect(migrateOmnicodeConsoleUiState(null)).toEqual({ state: {}, migrated: false });
    expect(migrateOmnicodeConsoleUiState([1, 2])).toEqual({ state: {}, migrated: false });
  });

  it("resolveOmnicodeInstanceDocked：覆盖表命中优先，缺省键回退 dockDefault，双缺省回停靠", () => {
    // 覆盖表显式键优先于全局默认
    expect(
      resolveOmnicodeInstanceDocked(
        { dockDefault: false, dockedByProfileId: { p1111111111: true } },
        "p1111111111",
      ),
    ).toBe(true);
    expect(
      resolveOmnicodeInstanceDocked(
        { dockDefault: true, dockedByProfileId: { p1111111111: false } },
        "p1111111111",
      ),
    ).toBe(false);
    // 缺省键跟随全局默认
    expect(resolveOmnicodeInstanceDocked({ dockDefault: false, dockedByProfileId: {} }, "p2222222222")).toBe(false);
    expect(resolveOmnicodeInstanceDocked({ dockDefault: true, dockedByProfileId: {} }, "p2222222222")).toBe(true);
    // 双缺省（旧档字段缺失/损坏）回退停靠
    expect(
      resolveOmnicodeInstanceDocked(
        { dockDefault: undefined as never, dockedByProfileId: undefined as never },
        "p2222222222",
      ),
    ).toBe(true);
  });

  it("diffOmnicodeDockState：前后停靠态逐实例差分（toDock/toUndock，无变化为空）", () => {
    const previous = { dockDefault: false, dockedByProfileId: { p3333333333: true } };
    const next = { dockDefault: true, dockedByProfileId: { p2222222222: false } };
    const diff = diffOmnicodeDockState(previous, next, ["p1111111111", "p2222222222", "p3333333333"]);
    // p1：false→true（跟随新默认，收回）；p2：覆盖 false 前后一致；p3：覆盖 true 前后一致
    expect(diff).toEqual({ toDock: ["p1111111111"], toUndock: [] });
    // 同态反向（停靠↔拖出往返）→ 只拖出
    const reversed = diffOmnicodeDockState(next, previous, ["p1111111111", "p2222222222", "p3333333333"]);
    expect(reversed).toEqual({ toDock: [], toUndock: ["p1111111111"] });
    // 同态 → 双空
    expect(diffOmnicodeDockState(next, next, ["p1111111111", "p2222222222", "p3333333333"])).toEqual({
      toDock: [],
      toUndock: [],
    });
  });

  it("resolveOmnicodeEmbedResizeHeightCss：手柄数学（上下映射 dy / 左右映射 dx 1:1，下限钳制 96/scale）", () => {
    const start = 300;
    // bottom 向下拖 = 增高；top 向下拖 = 减高
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "bottom", startHeightCss: start, dxCss: 0, dyCss: 40, scaleY: 1 })).toBe(340);
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "top", startHeightCss: start, dxCss: 0, dyCss: 40, scaleY: 1 })).toBe(260);
    // right 向右拖 = 增高（1:1 手感）；left 向左拖 = 增高
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "right", startHeightCss: start, dxCss: 30, dyCss: 0, scaleY: 1 })).toBe(330);
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "left", startHeightCss: start, dxCss: -30, dyCss: 0, scaleY: 1 })).toBe(330);
    // 下限钳制：96 DIP / scale 换算回 CSS（scale=1 → 96px；scale=2 → 48px）
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "bottom", startHeightCss: start, dxCss: 0, dyCss: -500, scaleY: 1 })).toBe(96);
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "bottom", startHeightCss: start, dxCss: 0, dyCss: -500, scaleY: 2 })).toBe(48);
    // scale 非法（0/NaN/负数）按 1 兜底
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "bottom", startHeightCss: start, dxCss: 0, dyCss: -500, scaleY: 0 })).toBe(96);
    expect(resolveOmnicodeEmbedResizeHeightCss({ edge: "bottom", startHeightCss: start, dxCss: 0, dyCss: -500, scaleY: Number.NaN })).toBe(96);
  });

  it("clampOmnicodeScreenRectToEmbedMinimum：低于内嵌最低规格的屏幕矩形钳到 160×96（x/y 不动）", () => {
    expect(
      clampOmnicodeScreenRectToEmbedMinimum({ x: 100, y: 200, width: 120, height: 60 }),
    ).toEqual({ x: 100, y: 200, width: OMNICODE_EMBED_MIN_WIDTH, height: OMNICODE_EMBED_MIN_HEIGHT });
    // 高于下限原样透传
    expect(clampOmnicodeScreenRectToEmbedMinimum({ x: 0, y: 0, width: 640, height: 400 })).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 400,
    });
    // 非有限值原样透传（由 isOmnicodeEmbedRectUsable 复核丢弃）
    const nonFinite = { x: Number.NaN, y: 0, width: 10, height: 10 };
    expect(clampOmnicodeScreenRectToEmbedMinimum(nonFinite)).toBe(nonFinite);
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

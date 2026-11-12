// [OmniCode] 批次2 B2-3：内嵌布局纯函数（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 双端共用：实例侧 embedLayout 矩形校验 + 管理器侧客户区→屏幕 DIP 换算。
// 全部为无副作用纯函数，单测登记 scripts/engineering-test-files.json。

/**
 * 内嵌窗口最低规格。低于 arrange 的 200×150（spec §4.2 "参考"语义）：内嵌卡片格子由
 * minmax(~280px) 网格 + 真实宽高比 letterbox 决定，21:9 等宽比例卡片画面区高度会低于
 * 150px，沿用 arrange 下限会拒绝合法格子；160×96 覆盖常规网格下限并仍拦截退化矩形。
 */
export const OMNICODE_EMBED_MIN_WIDTH = 160;
export const OMNICODE_EMBED_MIN_HEIGHT = 96;

/** 管理器/实例窗口句柄（HWND）十六进制形态："0x" + 1..16 位 hex（64 位指针上限）。 */
const OMNICODE_HWND_HEX_PATTERN = /^0x[0-9a-f]{1,16}$/iu;

export interface OmnicodeEmbedRectInput {
  profileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OmnicodeScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isFiniteNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 实例侧 embedLayout 校验：矩形有限非负整数且不低于内嵌最低规格（与 arrange 的
 * 独立把关同思路——来源是父进程，但实例侧仍防御畸形值，spec 安全边界）。
 */
export function isOmnicodeEmbedRectUsable(rect: OmnicodeEmbedRectInput | undefined): boolean {
  if (!rect) return false;
  return (
    isFiniteNonNegativeInt(rect.x) &&
    isFiniteNonNegativeInt(rect.y) &&
    isFiniteNonNegativeInt(rect.width) &&
    isFiniteNonNegativeInt(rect.height) &&
    rect.width >= OMNICODE_EMBED_MIN_WIDTH &&
    rect.height >= OMNICODE_EMBED_MIN_HEIGHT
  );
}

/** embedLayout 命令按 profileId 滤出本实例自己的矩形（命令携带全量 rects，广播同形）。 */
export function findOmnicodeEmbedRectForProfile(
  rects: readonly OmnicodeEmbedRectInput[] | undefined,
  profileId: string,
): OmnicodeEmbedRectInput | undefined {
  if (!Array.isArray(rects)) return undefined;
  const own = rects.find((rect) => rect && typeof rect === "object" && rect.profileId === profileId);
  return isOmnicodeEmbedRectUsable(own) ? own : undefined;
}

/**
 * getNativeWindowHandle() 的 Buffer → "0x…" 十六进制。Windows HWND 按 little-endian
 * 指针读（8 字节缓冲读 BigUInt64LE；实测缓冲可能只含低位 4 字节，BigInt 读取两种
 * 长度都正确）。仅用于 PowerShell 字面量参数与日志展示。
 */
export function formatOmnicodeNativeHandleHex(handle: Buffer): string | null {
  if (!Buffer.isBuffer(handle) || handle.length === 0) return null;
  // readUIntLE 最多支持 6 字节；Windows 64 位实测返回 8 字节缓冲（BigUInt64LE 覆盖），
  // 其余长度按低位截断读取（HWND 实际值落在低位）。
  const value =
    handle.length >= 8
      ? handle.readBigUInt64LE(0)
      : handle.readUIntLE(0, Math.min(handle.length, 6));
  const hex = value.toString(16);
  if (hex === "" || hex === "0") return null;
  return `0x${hex}`;
}

/** HWND 十六进制白名单（PowerShell 参数面全字面量校验，spec §批次2 纪律）。 */
export function isValidOmnicodeHwndHex(value: unknown): value is string {
  return typeof value === "string" && OMNICODE_HWND_HEX_PATTERN.test(value.trim());
}

export interface OmnicodeClientToScreenInput {
  /** 管理器窗口内容区（screen DIP，getContentBounds）。 */
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
  /** renderer 上报时刻的视口尺寸（CSS px）。 */
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * 客户区 CSS 像素矩形 → 屏幕 DIP 矩形。
 * CSS px = DIP × zoomFactor，因此 scale = contentDIP / viewportCss 即 zoom，对任意
 * 缩放级别成立（换算收口在 main，renderer 不感知 zoom）。视口尺寸非法时拒绝换算。
 */
export function convertOmnicodeClientRectToScreen(
  basis: OmnicodeClientToScreenInput,
  rect: { x: number; y: number; width: number; height: number },
): OmnicodeScreenRect | null {
  const { contentX, contentY, contentWidth, contentHeight, viewportWidth, viewportHeight } = basis;
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    !Number.isFinite(contentWidth) ||
    !Number.isFinite(contentHeight)
  ) {
    return null;
  }
  const scaleX = contentWidth / viewportWidth;
  const scaleY = contentHeight / viewportHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return null;
  return {
    x: Math.round(contentX + rect.x * scaleX),
    y: Math.round(contentY + rect.y * scaleY),
    width: Math.max(0, Math.round(rect.width * scaleX)),
    height: Math.max(0, Math.round(rect.height * scaleY)),
  };
}

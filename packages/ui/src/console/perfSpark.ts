// [OmniCode] 批次2.5 X1：性能面板纯函数（renderer 侧环形缓冲 + SVG spark 路径，
// spec: docs/omnicode/console-extras.md §X1）。零依赖纯函数，单测登记
// engineering-test-files.json（packages/desktop/test/omnicodeBatch25Extras.test.ts）。

/** 环形缓冲容量：60 点 × 5s 采样间隔 ≈ 近 5 分钟走势。 */
export const OMNICODE_PERF_SERIES_CAPACITY = 60;

export interface OmnicodePerfSamplePoint {
  /** 采样时刻（epoch ms，main 广播的 at）。 */
  at: number;
  memoryMB: number;
}

/**
 * 追加一个采样点（不可变；超出容量丢最旧点）。非法值（NaN/负数内存）直接丢弃返回原数组。
 */
export function pushOmnicodePerfSample(
  series: readonly OmnicodePerfSamplePoint[],
  at: number,
  memoryMB: number,
  capacity: number = OMNICODE_PERF_SERIES_CAPACITY,
): OmnicodePerfSamplePoint[] {
  if (!Number.isFinite(at) || !Number.isFinite(memoryMB) || memoryMB < 0 || capacity <= 0) {
    return [...series];
  }
  const next = [...series, { at, memoryMB }];
  if (next.length <= capacity) return next;
  return next.slice(next.length - capacity);
}

/**
 * spark 折线的 SVG points 字符串（viewBox 坐标系，如 "0,12 5,10 ..."）。
 * - 空或单点序列无折线可画，返回 ""；
 * - 归一化到 [padding, height-padding]：全部相等时画中线（无趋势不画平顶贴边）；
 * - x 均分（环形缓冲丢最旧点后序列始终是等间隔时间窗，位置近似即可）。
 */
export function buildOmnicodeSparklinePoints(
  values: readonly number[],
  width: number,
  height: number,
  padding = 2,
): string {
  if (values.length < 2 || !Number.isFinite(width) || !Number.isFinite(height)) return "";
  if (width <= padding * 2 || height <= padding * 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const usableHeight = height - padding * 2;
  const usableWidth = width - padding * 2;
  return values
    .map((value, index) => {
      const x = padding + (usableWidth * index) / (values.length - 1);
      const ratio = span > 0 ? (value - min) / span : 0.5;
      const y = padding + usableHeight * (1 - ratio);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}

/** 当前值显示（MB；>=1024 显示 GB 一位小数）。 */
export function formatOmnicodeMemoryMB(memoryMB: number): string {
  if (!Number.isFinite(memoryMB) || memoryMB < 0) return "—";
  if (memoryMB >= 1024) return `${(memoryMB / 1024).toFixed(1)} GB`;
  return `${Math.round(memoryMB)} MB`;
}

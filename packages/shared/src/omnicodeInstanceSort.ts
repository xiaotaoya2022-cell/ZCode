// [OmniCode] 实例元数据批次：实例列表排序纯函数（网格/设置分区列表/托盘菜单共用同一
// 排序事实源）。spec: docs/omnicode/profile-runtime.md §实例元数据（批次5）。
//
// 三种模式：
// - seq（默认）：按 profileRegistry 的 seq 整数字段升序（新建实例 = 当前 max+1；读档
//   缺失由注册表回填）。seq 仅是排序依据，不影响昵称显示。
// - name：名称 localeCompare("zh")（中文按拼音排序，与系统 collation 一致）。
// - custom：拖拽产生的 customOrder（profileId 数组）决定顺序；未登记的实例按 seq
//   补在尾部（新增实例开箱可见，不丢排序）。
//
// 官方 flavor 零改动：本模块是纯函数库，官方代码路径不导入它（同 omnicodeGlobalPrefs）。

/** profileId 形态白名单（与 profileRuntime 生成器/assertValidProfileId 同源：p + base36）。 */
const OMNICODE_PROFILE_ID_PATTERN = /^p[0-9a-z]{8,20}$/u;

/** customOrder 硬上限（防畸形落盘撑爆档案；实例数量级远小于此值，正常路径无感）。 */
export const OMNICODE_INSTANCE_CUSTOM_ORDER_MAX = 1000;

export const OMNICODE_INSTANCE_SORT_MODES = ["seq", "name", "custom"] as const;

export type OmnicodeInstanceSortMode = (typeof OMNICODE_INSTANCE_SORT_MODES)[number];

export function isOmnicodeInstanceSortMode(value: unknown): value is OmnicodeInstanceSortMode {
  return (OMNICODE_INSTANCE_SORT_MODES as readonly unknown[]).includes(value);
}

/** 排序输入项（Profile 摘要的最小形状；托盘条目/Profile 列表/卡片均满足）。 */
export interface OmnicodeInstanceSortItem {
  id: string;
  name: string;
  /** 序号（profileRegistry 持久化；缺失按 +∞ 排尾并以 createdAt 兜底）。 */
  seq?: number;
  createdAt?: string;
}

export type OmnicodeDropPosition = "before" | "after";

/** seq 值域校验（正整数；负数/小数/非有限一律视为缺失，走回填）。 */
export function isOmnicodeInstanceSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * sortMode 归一（纯函数）：仅接受三个合法值；非法/缺省返回 undefined（调用方回退默认
 * "seq"，存储层 merge 用它把落盘值收敛到合法形态）。
 */
export function normalizeOmnicodeInstanceSortMode(raw: unknown): OmnicodeInstanceSortMode | undefined {
  return isOmnicodeInstanceSortMode(raw) ? raw : undefined;
}

/**
 * customOrder 归一（纯函数）：仅接受字符串数组；逐项过 profileId 形态白名单、去重
 * （保留首个）、截断到硬上限。非法/缺省返回 undefined（= 不变，merge 语义）；
 * 空数组 = 清空（回到纯 seq 兜底序）。
 */
export function normalizeOmnicodeInstanceCustomOrder(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !OMNICODE_PROFILE_ID_PATTERN.test(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
  }
  const normalized = [...seen];
  if (normalized.length > OMNICODE_INSTANCE_CUSTOM_ORDER_MAX) {
    normalized.length = OMNICODE_INSTANCE_CUSTOM_ORDER_MAX;
  }
  return normalized;
}

function seqOf(item: OmnicodeInstanceSortItem): number {
  return isOmnicodeInstanceSeq(item.seq) ? item.seq : Number.POSITIVE_INFINITY;
}

function compareBySeqThenCreated(a: OmnicodeInstanceSortItem, b: OmnicodeInstanceSortItem): number {
  const seqA = seqOf(a);
  const seqB = seqOf(b);
  // ∞-∞ = NaN 陷阱：同为缺失（+∞）时必须落到 createdAt 兜底，不能用差值判等
  if (seqA !== seqB) return seqA - seqB;
  const createdDiff = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  if (createdDiff !== 0) return createdDiff;
  return a.id.localeCompare(b.id);
}

/**
 * 实例列表排序（纯函数）：三种模式共用；未知/缺省模式回退 seq（落盘值已由 merge 收敛，
 * 这里兜底防御）。返回新数组，不改变输入。
 */
export function sortOmnicodeInstances<T extends OmnicodeInstanceSortItem>(
  items: readonly T[],
  options: { mode?: OmnicodeInstanceSortMode; customOrder?: readonly string[] } = {},
): T[] {
  const mode = options.mode ?? "seq";
  const sorted = [...items];
  if (mode === "name") {
    // localeCompare("zh")：中文按拼音、拉丁按字母（任务口径"按名称首字母"）。
    sorted.sort((a, b) => {
      const nameDiff = a.name.localeCompare(b.name, "zh");
      if (nameDiff !== 0) return nameDiff;
      return compareBySeqThenCreated(a, b);
    });
    return sorted;
  }
  if (mode === "custom") {
    const rankOf = (id: string): number => {
      const index = options.customOrder?.indexOf(id) ?? -1;
      return index >= 0 ? index : Number.POSITIVE_INFINITY;
    };
    sorted.sort((a, b) => {
      const rankDiff = rankOf(a.id) - rankOf(b.id);
      if (rankDiff !== 0) return rankDiff;
      return compareBySeqThenCreated(a, b);
    });
    return sorted;
  }
  sorted.sort(compareBySeqThenCreated);
  return sorted;
}

/**
 * 拖拽落点语义（纯函数）：把 dragId 从 customOrder 中移除后，按 position 插入到
 * targetId 之前/之后。
 * - order 先与 allIds 求交集保序，再把 allIds 中未登记的 id（按传入顺序）补到尾部
 *   ——写入的 customOrder 收敛为"覆盖全部现存实例"的规范形态。
 * - dragId === targetId、或二者不在 allIds 中 → 返回归一后的基线（no-op 语义）。
 * 返回新数组，不改变输入。
 */
export function moveOmnicodeInstanceInCustomOrder(
  order: readonly string[],
  allIds: readonly string[],
  dragId: string,
  targetId: string,
  position: OmnicodeDropPosition,
): string[] {
  const known = new Set(allIds);
  const kept = order.filter((id) => known.has(id));
  for (const id of allIds) {
    if (!kept.includes(id)) kept.push(id);
  }
  if (!known.has(dragId) || !known.has(targetId) || dragId === targetId) {
    return kept;
  }
  const withoutDrag = kept.filter((id) => id !== dragId);
  const targetIndex = withoutDrag.indexOf(targetId);
  if (targetIndex < 0) return kept; // 理论不可达（targetId ∈ allIds），防御性返回基线
  const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
  withoutDrag.splice(insertIndex, 0, dragId);
  return withoutDrag;
}

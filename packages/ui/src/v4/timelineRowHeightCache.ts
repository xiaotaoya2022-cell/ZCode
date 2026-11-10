// 虚拟滚动核心：v4 timeline 行高缓存（纯数据结构，无 DOM/React 依赖）。
//
// 为什么需要它：@tanstack/react-virtual 自身的 measurementsCache 按 itemKey 缓存，
// 行在窗口内卸载/重挂不丢测量；但流式行高度持续增长时，virtualizer 重置
// （rows 数组重建、组件 StrictMode 重挂、error 态 ↔ timeline 切换）会把缓存清回
// estimateSize 的固定值，导致滚动条跳动与底部锚定抖动。这里以 render unit 的稳定
// key（turnId）为键做一层组件实例内持久缓存，保证「行卸载重挂保测高缓存」。
//
// 会话维度再补一层模块级 LRU 桶（见文末 acquireTimelineRowHeightCacheForSession）：
// 切换会话不再整体 clear，而是换到该会话的保留桶，首屏 estimate 直接命中历史行高。
//

/** 未测量行的兜底估计高度（与旧 ConversationTimeline 的 ROW_ESTIMATE_PX 一致）。 */
export const DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72;

/** 缓存上限：超长会话防内存膨胀；淘汰最久未写入的行（写入序 ≈ 行序，旧行先淘汰）。 */
export const MAX_ROW_HEIGHT_CACHE_ENTRIES = 4000;

export type TimelineRowHeightCacheKey = string | number;

export class TimelineRowHeightCache {
  private readonly sizes = new Map<TimelineRowHeightCacheKey, number>();

  constructor(private readonly maxEntries: number = MAX_ROW_HEIGHT_CACHE_ENTRIES) {}

  get size(): number {
    return this.sizes.size;
  }

  /** 记录一次真实测量。重复写入会刷新淘汰顺序（活跃行不被淘汰）。 */
  set(key: TimelineRowHeightCacheKey, heightPx: number): void {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      return;
    }
    // Map 迭代序 = 插入序；先删再插把该行移到「最新」端。
    this.sizes.delete(key);
    this.sizes.set(key, heightPx);
    while (this.sizes.size > this.maxEntries) {
      const oldest = this.sizes.keys().next();
      if (oldest.done) break;
      this.sizes.delete(oldest.value);
    }
  }

  get(key: TimelineRowHeightCacheKey): number | undefined {
    return this.sizes.get(key);
  }

  /** estimateSize 入口：有测量用测量，无测量回落估计值。 */
  estimate(
    key: TimelineRowHeightCacheKey | undefined,
    fallbackPx: number = DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  ): number {
    if (key === undefined) return fallbackPx;
    return this.sizes.get(key) ?? fallbackPx;
  }

  /** 整体重置（接口语义保留：仍按单桶全部清空；会话切换走下方换桶而不是调用这里）。 */
  clear(): void {
    this.sizes.clear();
  }
}

/** 会话桶上限：LRU 保留最近 8 个会话的测高缓存；8 × 4000 条数字键值 ≈ MB 级，内存有界。 */
export const MAX_SESSION_ROW_HEIGHT_CACHES = 8;

// [OmniCode] 模块级会话桶注册表：key 为 sessionKey（sessionId ?? "draft"）。
// 会话切换从「整体 clear」改为「换桶」：turnId 跨会话可能重复，串号风险由按会话分桶隔离；
// 同会话跨组件挂载/虚拟器重建复用历史测高，estimateSize 不再回落 72px 固定估计造成首屏抖动。
const sessionRowHeightCaches = new Map<string, TimelineRowHeightCache>();

/**
 * 取会话专属测高缓存桶（不存在则创建），并把该桶移到 LRU 最新端；
 * 超过 {@link MAX_SESSION_ROW_HEIGHT_CACHES} 时淘汰最久未访问会话的桶。
 * 返回值仍是普通 TimelineRowHeightCache，estimate/measure 接口语义不变，
 * ConversationTimeline 只需在 sessionKey effect 里把 clear() 换成本函数。
 */
export function acquireTimelineRowHeightCacheForSession(
  sessionKey: string,
): TimelineRowHeightCache {
  const existing = sessionRowHeightCaches.get(sessionKey);
  if (existing) {
    // Map 迭代序 = 插入序；先删再插把该会话移到「最新」端（LRU touch），与桶内条目同款策略。
    sessionRowHeightCaches.delete(sessionKey);
    sessionRowHeightCaches.set(sessionKey, existing);
    return existing;
  }
  const created = new TimelineRowHeightCache();
  sessionRowHeightCaches.set(sessionKey, created);
  while (sessionRowHeightCaches.size > MAX_SESSION_ROW_HEIGHT_CACHES) {
    const oldest = sessionRowHeightCaches.keys().next();
    if (oldest.done) break;
    sessionRowHeightCaches.delete(oldest.value);
  }
  return created;
}

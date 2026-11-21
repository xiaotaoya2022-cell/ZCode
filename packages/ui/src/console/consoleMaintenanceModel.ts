/**
 * [OmniCode] 新功能批次（2026-11-21 审计会话）：管理器维护面纯函数——
 * 会话库体积人类可读格式化 + 锁占用总览按持有者分组。无 React/服务依赖，desktop
 * 工程测试直接覆盖（呈现细节留在组件，这里只放可复用的判定/推导）。
 */
import type { OmnicodeWorkspaceLockSummaryEntry } from "@zcode/shared";

/** 字节数 → 人类可读（B/KB/MB/GB，1 位小数；<1024 直出整数 B）。 */
export function formatOmnicodeByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unitIndex]}`;
}

export interface OmnicodeLockHolderGroup {
  /** 持有者显示名（displayName 缺省回退 profileId）。 */
  holderLabel: string;
  profileId: string;
  entries: OmnicodeWorkspaceLockSummaryEntry[];
}

/**
 * 锁占用总览分组：按持有者聚合（保持入参顺序——main 侧已按显示名+路径稳定排序），
 * 组内保持原序。同持有多工作区是常态（一个实例开多个项目）。
 */
export function groupOmnicodeWorkspaceLocksByHolder(
  entries: readonly OmnicodeWorkspaceLockSummaryEntry[],
): OmnicodeLockHolderGroup[] {
  const groups: OmnicodeLockHolderGroup[] = [];
  const byProfileId = new Map<string, OmnicodeLockHolderGroup>();
  for (const entry of entries) {
    let group = byProfileId.get(entry.profileId);
    if (!group) {
      group = {
        holderLabel: entry.displayName?.trim() || entry.profileId,
        profileId: entry.profileId,
        entries: [],
      };
      byProfileId.set(entry.profileId, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

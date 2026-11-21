/**
 * [OmniCode] 新功能批次（2026-11-21 审计会话）：实例网格过滤纯函数。
 * 匹配口径：名称子串（大小写不敏感）或 seq 序号整串（"3" 只匹配 #3，不匹配 #13/#31）。
 * 空查询=恒过（全量）。纯函数无 React 依赖，desktop 工程测试直接覆盖。
 */
import type { OmnicodeProfileSummaryInfo } from "@zcode/shared";

export function filterOmnicodeInstancesForQuery(
  profiles: readonly OmnicodeProfileSummaryInfo[],
  query: string,
): OmnicodeProfileSummaryInfo[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...profiles];
  }
  const seqQuery = Number.parseInt(normalized, 10);
  const seqExactQuery = Number.isInteger(seqQuery) && String(seqQuery) === normalized ? seqQuery : null;
  return profiles.filter((profile) => {
    if (profile.name.toLowerCase().includes(normalized)) {
      return true;
    }
    // 序号整串匹配（"3" 命中 #3 不连带 #13/#31）；仅当输入是纯整数形态。
    const seq = profile.seq;
    return seq !== undefined && seqExactQuery !== null && seq === seqExactQuery;
  });
}

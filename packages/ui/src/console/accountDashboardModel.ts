// [OmniCode] 批次3 UI 批次：账号看板汇总模型（纯函数）。汇总条的健康分档与 X2
// 徽标四态同口径（Profile 列表 loginHealth：healthy/expiring/expired/unknown），
// 不重新实现分级——只按档计数（分级逻辑唯一口径在 main readOmnicodeLoginHealths）。
import type { OmnicodeProfileSummaryInfo } from "@zcode/shared";

/** 健康分档计数（演示稿汇总条五项：总数 + 四态）。 */
export interface OmnicodeLoginHealthCounts {
  healthy: number;
  expiring: number;
  expired: number;
  unknown: number;
}

/** 按登录健康度分档计数（纯函数，单测锁定）：loginHealth 缺失/损坏值一律归 unknown。 */
export function resolveOmnicodeLoginHealthCounts(
  profiles: readonly Pick<OmnicodeProfileSummaryInfo, "loginHealth">[],
): OmnicodeLoginHealthCounts {
  const counts: OmnicodeLoginHealthCounts = { healthy: 0, expiring: 0, expired: 0, unknown: 0 };
  for (const profile of profiles) {
    switch (profile.loginHealth?.status) {
      case "healthy":
        counts.healthy += 1;
        break;
      case "expiring":
        counts.expiring += 1;
        break;
      case "expired":
        counts.expired += 1;
        break;
      default:
        counts.unknown += 1;
        break;
    }
  }
  return counts;
}

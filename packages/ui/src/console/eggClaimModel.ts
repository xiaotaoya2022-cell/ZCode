// [OmniCode] 批次3 UI 批次：赛博鸡蛋浮层纯模型（门票叠布局/逐张结算汇总/自动领取徽章）。
// spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3；观感对标演示稿
// console-dashboard-demo.html 02 节（左下门票叠：错落叠放 + ×N 角标 + 逐张动效）。
// 纯函数无 React 依赖，供浮层组件与单测共用（单测在 packages/desktop/test 经 @/ 别名导入）。
import type { OmnicodeClaimHistoryEntry } from "@zcode/shared";

/**
 * 门票叠可见错落位上限（演示稿 data-i 0..3：4 个错落位，超出钳到最后一位——
 * 10+ 账号时不再新开角度，只靠 ×N 角标表达总数）。
 */
export const OMNICODE_TICKET_STACK_VISIBLE_SLOTS = 4;

/** 单张门票的布局槽位（纯函数）：i 钳到 [0, 3]，渲染层按槽位取错落 transform。 */
export function resolveOmnicodeTicketSlotIndex(ticketIndex: number): number {
  if (!Number.isInteger(ticketIndex) || ticketIndex < 0) return 0;
  return Math.min(ticketIndex, OMNICODE_TICKET_STACK_VISIBLE_SLOTS - 1);
}

/**
 * 门票叠布局模型（纯函数，单测锁定）：给定可领账号数，输出每张的槽位序号与
 * ×N 角标值（N = 总张数；0 张不渲染浮层，无需布局）。
 */
export interface OmnicodeTicketStackLayout {
  /** 每张门票的槽位序号（0..3，供 CSS 错落 transform 取值）。 */
  slotIndexes: number[];
  /** 角标显示数（=张数）。 */
  badgeCount: number;
}

export function buildOmnicodeTicketStackLayout(ticketCount: number): OmnicodeTicketStackLayout {
  const count = Number.isInteger(ticketCount) && ticketCount > 0 ? ticketCount : 0;
  return {
    slotIndexes: Array.from({ length: count }, (_, index) => resolveOmnicodeTicketSlotIndex(index)),
    badgeCount: count,
  };
}

/** 逐张领取结果（renderer 从 OmnicodeAccountClaimEvent account_result 事件积累）。 */
export interface OmnicodeClaimTicketOutcome {
  profileId: string;
  outcome: "success" | "failed" | "skipped";
  grantedUnits?: number;
  reasonKey?: string;
}

/**
 * 逐张结算汇总（纯函数，单测锁定）：成功数 / 失败数 / 跳过数 / 到账额度合计
 *（只有出现过数值才给合计，全缺省不编造 0）。供结算态「今日已领取 N 份额度·合计 +X」。
 */
export interface OmnicodeClaimSettlement {
  succeeded: number;
  failed: number;
  skipped: number;
  /** 到账额度合计（任一成功条目缺省 grantedUnits 时合计仍可给部分和？不——缺省条目
   * 不参与求和；全部缺省时合计缺省）。 */
  grantedTotal?: number;
  aborted: boolean;
}

export function summarizeOmnicodeClaimSettlement(
  outcomes: readonly OmnicodeClaimTicketOutcome[],
  options: { aborted?: boolean } = {},
): OmnicodeClaimSettlement {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let grantedTotal: number | undefined;
  for (const outcome of outcomes) {
    if (outcome.outcome === "success") {
      succeeded += 1;
      if (typeof outcome.grantedUnits === "number" && Number.isFinite(outcome.grantedUnits)) {
        grantedTotal = (grantedTotal ?? 0) + outcome.grantedUnits;
      }
    } else if (outcome.outcome === "failed") {
      failed += 1;
    } else {
      skipped += 1;
    }
  }
  return {
    succeeded,
    failed,
    skipped,
    ...(grantedTotal !== undefined ? { grantedTotal } : {}),
    aborted: options.aborted === true,
  };
}

/**
 * 今日自动领取结算（纯函数，单测锁定）：从 claimHistory（FIFO 50）筛「今天 + mode=auto +
 * outcome=success」的条目——自动领取可能发生在管理器窗口关闭期间（main 30min 轮询），
 * 挂载时据历史补结算徽章（点开明细=同一列表）。
 */
export interface OmnicodeAutoSettlementSummary {
  succeededCount: number;
  grantedTotal?: number;
}

export function summarizeOmnicodeAutoSettlementFromHistory(
  history: readonly OmnicodeClaimHistoryEntry[] | undefined,
  now: number,
): OmnicodeAutoSettlementSummary | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  let succeededCount = 0;
  let grantedTotal: number | undefined;
  for (const entry of history) {
    if (entry.mode !== "auto" || entry.outcome !== "success") continue;
    if (typeof entry.at !== "number" || entry.at < dayStartMs) continue;
    succeededCount += 1;
    if (typeof entry.grantedUnits === "number" && Number.isFinite(entry.grantedUnits)) {
      grantedTotal = (grantedTotal ?? 0) + entry.grantedUnits;
    }
  }
  if (succeededCount === 0) return null;
  return { succeededCount, ...(grantedTotal !== undefined ? { grantedTotal } : {}) };
}

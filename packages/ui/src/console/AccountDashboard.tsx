// [OmniCode] 批次3 UI 批次：账号看板视图（ConsoleHome 第二视图，对标演示稿 01 节）。
// - 数据源 = OmnicodeAccountSnapshotGet（main 侧 30min TTL 缓存；挂载拉一次，「全部刷新」
//   走 force 绕过缓存强刷——刷新节奏红线由 main 串行编排 + TTL 兜住）。
// - 汇总条：总数/健康/临期/异常/未知 + 全部刷新 + 最后刷新时间；账号卡网格复用
//   AccountDashboardCard；实例归属/运行态/登录健康度来自既有 Profile 列表（X2 同链）。
// - 视图切换（网格↔看板）状态存内存不落盘：管理器主语义是实例网格（ConsoleHome 方案 A
//   ——首屏永远是实例管理中枢），看板是瞬时检视面；重启回落网格，无需存储迁移。
// - 平台方法缺席（官方 flavor / 旧 preload）时整个视图降级为「不可用」提示而非报错。
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { OmnicodeAccountDashboardSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { AccountDashboardCard } from "@/console/AccountDashboardCard.js";
import { useOmnicodeConsoleInstances } from "@/console/useOmnicodeConsoleInstances.js";
import {
  resolveOmnicodeLoginHealthCounts,
  type OmnicodeLoginHealthCounts,
} from "@/console/accountDashboardModel.js";

/** 汇总统计条（健康分档与 X2 徽标四态同口径：healthy/expiring/expired/unknown）。 */
function DashboardSummaryBar(props: {
  counts: OmnicodeLoginHealthCounts;
  total: number;
  refreshing: boolean;
  lastRefreshedAt: number | null;
  onRefreshAll: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { counts, total, refreshing, lastRefreshedAt, onRefreshAll } = props;
  const stats = [
    { key: "console.dashboard.statTotal", value: total, dot: "bg-slate-400", text: "text-foreground" },
    { key: "console.dashboard.statHealthy", value: counts.healthy, dot: "bg-emerald-500", text: "text-emerald-500" },
    { key: "console.dashboard.statExpiring", value: counts.expiring, dot: "bg-amber-500", text: "text-amber-500" },
    { key: "console.dashboard.statExpired", value: counts.expired, dot: "bg-red-500", text: "text-red-500" },
    { key: "console.dashboard.statUnknown", value: counts.unknown, dot: "bg-slate-400", text: "text-foreground-subtle" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-5 rounded-lg border border-border bg-popover px-4 py-3">
      <div className="flex flex-wrap gap-5">
        {stats.map((stat) => (
          <div key={stat.key} className="flex items-baseline gap-1.5">
            <span className={cn("size-2 self-center rounded-full", stat.dot)} />
            <span className={cn("text-lg font-bold leading-none", stat.text)}>{stat.value}</span>
            <span className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: stat.key })}
            </span>
          </div>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-ui-xs text-foreground-subtlest">
          {lastRefreshedAt !== null
            ? intl.formatMessage(
                { id: "console.dashboard.lastRefreshedAt" },
                { time: new Date(lastRefreshedAt).toLocaleTimeString() },
              )
            : intl.formatMessage({ id: "console.dashboard.neverRefreshed" })}
        </span>
        <Button size="sm" disabled={refreshing} onClick={onRefreshAll}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing
            ? intl.formatMessage({ id: "console.dashboard.refreshingAll" })
            : intl.formatMessage({ id: "console.dashboard.refreshAll" })}
        </Button>
      </div>
    </div>
  );
}

/**
 * 账号看板视图（ConsoleHome 头部切换钮进入）。挂载即拉快照（TTL 缓存命中即秒回）；
 * 刷新全部 = force 强刷（本视图全部卡片转刷新态）。打开实例 = 既有实例操作链
 *（运行中聚焦 / 停止时启动，useOmnicodeConsoleInstances 同一数据面）。
 */
export function AccountDashboardView() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { profiles, handleLaunch, handleFocus } = useOmnicodeConsoleInstances();
  const [snapshot, setSnapshot] = useState<OmnicodeAccountDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [cardBusyIds, setCardBusyIds] = useState<ReadonlySet<string>>(new Set());

  const loadSnapshot = useCallback(
    async (force: boolean) => {
      if (force) setRefreshingAll(true);
      else setLoading(true);
      try {
        const result = await platform.getOmnicodeAccountSnapshot?.({ force });
        if (!result) {
          setUnavailable(true);
          return;
        }
        setSnapshot(result);
      } catch {
        setUnavailable(true);
      } finally {
        setLoading(false);
        setRefreshingAll(false);
      }
    },
    [platform],
  );

  useEffect(() => {
    void loadSnapshot(false);
  }, [loadSnapshot]);

  /** 全部刷新 / 单卡刷新（数据层只有整表快照一个杠杆，见文件头取舍注）。 */
  const handleRefreshAll = useCallback(() => {
    if (refreshingAll) return;
    void loadSnapshot(true);
  }, [loadSnapshot, refreshingAll]);

  const handleRefreshCard = useCallback(
    (profileId: string) => {
      if (refreshingAll) return;
      setCardBusyIds((previous) => new Set(previous).add(profileId));
      void platform
        .getOmnicodeAccountSnapshot?.({ force: true })
        .then((result) => {
          if (result) setSnapshot(result);
        })
        .catch(() => undefined)
        .finally(() => {
          setCardBusyIds((previous) => {
            const next = new Set(previous);
            next.delete(profileId);
            return next;
          });
        });
    },
    [platform, refreshingAll],
  );

  const profileById = useMemo(() => {
    const map = new Map<string, (typeof profiles)[number]>();
    for (const profile of profiles) map.set(profile.id, profile);
    return map;
  }, [profiles]);

  const counts = useMemo(
    () => resolveOmnicodeLoginHealthCounts(profiles),
    [profiles],
  );

  /** 打开实例（复用网格同一链路：运行中=聚焦真窗口，停止=启动）。 */
  const handleOpenInstance = useCallback(
    (profileId: string) => {
      const profile = profileById.get(profileId);
      if (!profile) return;
      if (profile.running) handleFocus(profile);
      else handleLaunch(profile);
    },
    [handleFocus, handleLaunch, profileById],
  );

  if (unavailable) {
    return (
      <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-border text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "console.dashboard.unavailable" })}
      </div>
    );
  }

  if (loading && snapshot === null) {
    return (
      <div className="flex min-h-[120px] items-center justify-center text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "console.dashboard.loading" })}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-2">
      <DashboardSummaryBar
        counts={counts}
        total={profiles.length}
        refreshing={refreshingAll}
        lastRefreshedAt={snapshot?.fetchedAt ?? null}
        onRefreshAll={handleRefreshAll}
      />
      {snapshot !== null && snapshot.accounts.length > 0 ? (
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
          {snapshot.accounts.map((entry) => (
            <AccountDashboardCard
              key={entry.profileId}
              entry={entry}
              profile={profileById.get(entry.profileId)}
              refreshing={refreshingAll || cardBusyIds.has(entry.profileId)}
              onRefresh={handleRefreshCard}
              onOpenInstance={handleOpenInstance}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-border text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "console.dashboard.empty" })}
        </div>
      )}
    </div>
  );
}

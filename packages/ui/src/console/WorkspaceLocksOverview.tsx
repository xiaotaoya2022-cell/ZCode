/**
 * [OmniCode] 新功能批次（2026-11-21 审计会话）：工作区锁占用总览（管理器网格视图分区）。
 * 价值：接管流（D12）决策前提——"谁占着哪个工作区"一眼可见；数据源=listWorkspaceLocks
 * 只读快照（过期锁读取时自愈删除，条目恒为活跃持有）。
 * 呈现：按持有者分组（组头=实例名+占用数，组内=工作区路径列表）；挂载时加载一次 +
 * 手动刷新钮（无轮询——锁事件不广播到管理器，静默轮询违背零空转原则）。
 * 桥方法缺席（旧 preload / 实例窗口误入）→ 整区不渲染。
 */
import { useCallback, useEffect, useState } from "react";
import { Lock, RefreshCw } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import type { OmnicodeWorkspaceLockSummaryEntry } from "@zcode/shared";
import { groupOmnicodeWorkspaceLocksByHolder } from "@/console/consoleMaintenanceModel.js";

export function WorkspaceLocksOverview(): React.ReactNode {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [entries, setEntries] = useState<OmnicodeWorkspaceLockSummaryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!platform.listOmnicodeWorkspaceLocks) return;
    setLoading(true);
    try {
      const result = await platform.listOmnicodeWorkspaceLocks();
      setEntries(result);
    } catch {
      // 读失败保持上次快照（只读面板，失败不打断网格主流程）
      toast(intl.formatMessage({ id: "console.locksOverview.loadFailed" }), { variant: "default" });
    } finally {
      setLoading(false);
    }
  }, [intl, platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 桥方法缺席（旧 preload）→ 不渲染（实例窗口本组件也不会被 ConsoleHome 挂载）
  if (!platform.listOmnicodeWorkspaceLocks) {
    return null;
  }
  const groups = groupOmnicodeWorkspaceLocksByHolder(entries ?? []);
  return (
    <section
      data-testid="omnicode-locks-overview"
      className="shrink-0 rounded-lg border border-border px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Lock aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "console.locksOverview.title" })}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "console.locksOverview.summary" },
            { holders: groups.length, locks: entries?.length ?? 0 },
          )}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={intl.formatMessage({ id: "console.locksOverview.refresh" })}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {entries !== null && entries.length === 0 ? (
        <p className="mt-1.5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "console.locksOverview.empty" })}
        </p>
      ) : null}
      {groups.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {groups.map((group) => (
            <li key={group.profileId} className="text-ui-xs">
              <span className="font-medium text-foreground">{group.holderLabel}</span>
              <span className="text-foreground-subtle">
                {" · "}
                {intl.formatMessage(
                  { id: "console.locksOverview.holderCount" },
                  { count: group.entries.length },
                )}
              </span>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {group.entries.map((entry) => (
                  <li
                    key={`${entry.profileId}:${entry.workspacePath}`}
                    className="truncate text-foreground-subtle"
                    title={entry.workspacePath}
                  >
                    {entry.workspacePath}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

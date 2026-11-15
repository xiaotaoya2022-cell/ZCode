// [OmniCode] 批次3 UI 批次：设置「自动化」分区（仿 omnicodeProfiles desktop-only 同构）。
// 内容 = 自动领取总开关（读写 console-ui.json autoClaimEnabled）+ 说明文案 + 领取历史
// 列表（FIFO 50，含时间/账号/plan/结果/额度）+「手动检测一次」（走 OmnicodeAccountDetectGet，
// 检测节奏红线与浮层一致）。官方 flavor：分区 desktop-only + 平台方法缺席时整卡降级提示。
import { useCallback, useEffect, useState } from "react";
import { Radar } from "lucide-react";
import type {
  OmnicodeAccountDetectResult,
  OmnicodeClaimHistoryEntry,
  OmnicodeConsoleUiState,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { logger } from "@/logger.js";

/** 单条领取历史的展示行（时间/账号/plan/结果/额度）。 */
function ClaimHistoryRow(props: { entry: OmnicodeClaimHistoryEntry }) {
  const { intl } = useZCodeIntl();
  const { entry } = props;
  return (
    <li className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-ui-xs">
      <span className={cn("shrink-0 font-semibold", entry.outcome === "success" ? "text-emerald-500" : "text-amber-500")}>
        {entry.outcome === "success" ? "✓" : entry.outcome === "failed" ? "×" : "–"}
      </span>
      <span className="shrink-0 text-foreground-subtlest">
        {new Date(entry.at).toLocaleTimeString()}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground">{entry.profileId}</span>
      <span className="max-w-32 shrink-0 truncate text-foreground-subtlest">
        {entry.planName ?? entry.planId}
      </span>
      <span className="shrink-0 rounded-full border border-border px-1.5 text-foreground-subtlest">
        {intl.formatMessage({
          id:
            entry.mode === "auto"
              ? "settings.omnicodeAutomation.modeAuto"
              : "settings.omnicodeAutomation.modeManual",
        })}
      </span>
      {entry.outcome === "success" && entry.grantedUnits !== undefined ? (
        <span className="shrink-0 font-mono text-amber-500">+{entry.grantedUnits}</span>
      ) : null}
    </li>
  );
}

/**
 * 自动化分区（自动领取 / 领取历史 / 手动检测）。开关即时写 console-ui（main 侧 30min
 * 轮询每 tick 重读该文件，翻转即时生效）；领取历史随返回的最新状态刷新。
 */
export function OmnicodeAutomationSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [uiState, setUiState] = useState<OmnicodeConsoleUiState | null>(null);
  const [toggling, setToggling] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    void platform
      .getOmnicodeConsoleUiState?.()
      .then((state) => setUiState(state))
      .catch(() => setUnavailable(true));
  }, [platform]);

  const handleToggleAutoClaim = useCallback(
    (checked: boolean) => {
      setToggling(true);
      void (async () => {
        try {
          const next = await platform.setOmnicodeConsoleUiState?.({ autoClaimEnabled: checked });
          if (next) setUiState(next);
          toast(
            intl.formatMessage({
              id: checked
                ? "settings.omnicodeAutomation.toastEnabled"
                : "settings.omnicodeAutomation.toastDisabled",
            }),
            { variant: "success" },
          );
        } catch (error) {
          logger.warn("[omnicode] 自动领取开关写入失败", {
            error: error instanceof Error ? error.message : String(error),
          });
          toast(intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" }), {
            variant: "warning",
          });
        } finally {
          setToggling(false);
        }
      })();
    },
    [intl, platform],
  );

  /** 手动检测一次（与管理器启动检测同链：逐账号 preview，main 汇聚；低频不循环）。 */
  const handleDetectNow = useCallback(() => {
    setDetecting(true);
    void (async () => {
      let result: OmnicodeAccountDetectResult | null = null;
      try {
        result = (await platform.getOmnicodeAccountDetect?.({ reason: "manual" })) ?? null;
      } catch (error) {
        logger.warn("[omnicode] 手动检测失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setDetecting(false);
      }
      if (!result) {
        toast(intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" }), {
          variant: "warning",
        });
        return;
      }
      if (result.summary.claimable > 0) {
        toast(
          intl.formatMessage(
            { id: "settings.omnicodeAutomation.detectClaimable" },
            {
              claimable: String(result.summary.claimable),
              total: String(result.summary.total),
            },
          ),
          { variant: "success" },
        );
        return;
      }
      toast(
        intl.formatMessage(
          { id: "settings.omnicodeAutomation.detectNone" },
          { total: String(result.summary.total) },
        ),
        { variant: "default" },
      );
    })();
  }, [intl, platform]);

  if (unavailable) {
    return (
      <SettingsGroupCard>
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "console.dashboard.unavailable" })}
        </p>
      </SettingsGroupCard>
    );
  }

  const autoClaimEnabled = uiState?.autoClaimEnabled === true;
  const history = uiState?.claimHistory ?? [];

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.omnicodeAutomation.autoClaimToggle" })}
          description={intl.formatMessage({
            id: "settings.omnicodeAutomation.autoClaimDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.omnicodeAutomation.autoClaimToggle" })}
              checked={autoClaimEnabled}
              disabled={toggling || uiState === null}
              onCheckedChange={handleToggleAutoClaim}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.omnicodeAutomation.detectNow" })}
          description={intl.formatMessage({
            id: "settings.omnicodeAutomation.detectNowDescription",
          })}
          control={
            <Button size="sm" variant="outline" disabled={detecting} onClick={handleDetectNow}>
              <Radar className={cn("size-3.5", detecting && "animate-pulse")} />
              {detecting
                ? intl.formatMessage({ id: "settings.omnicodeAutomation.detecting" })
                : intl.formatMessage({ id: "settings.omnicodeAutomation.detectNow" })}
            </Button>
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.omnicodeAutomation.historyTitle" })}
          description={intl.formatMessage({
            id: "settings.omnicodeAutomation.historyDescription",
          })}
          control={
            <span className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage(
                { id: "settings.omnicodeAutomation.historyCount" },
                { count: String(history.length) },
              )}
            </span>
          }
        />
        {history.length === 0 ? (
          <p className="px-1 pb-1 text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.omnicodeAutomation.historyEmpty" })}
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto px-1 pb-1">
            {[...history].reverse().map((entry, index) => (
              <ClaimHistoryRow key={`${entry.at}-${entry.profileId}-${index}`} entry={entry} />
            ))}
          </ul>
        )}
      </SettingsGroupCard>
    </div>
  );
}

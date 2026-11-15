// [OmniCode] 批次3 UI 批次：账号看板单卡（对标演示稿 01 节账号卡 + ConsoleInstanceCard
// 同套设计 token）。字段口径与 Cockpit 对齐：套餐/额度（balances 聚合）/到期/重置时间/
// 最后刷新；OmniCode 增强：登录健康度四态徽标（复用 X2 LoginHealthBadge）+ 实例归属
// 与运行态。异常卡（无凭据/JWT 缺失/拉取失败）显示状态 + 引导文案，不静默。
// 刷新语义取舍：数据层只有整表快照（force 绕 TTL）一个杠杆——「刷新」钮触发的也是
// 整表强刷（本卡转刷新态，其余卡静默更新），频率红线由 30min TTL + 串行编排兜住。
import { Play, RefreshCw } from "lucide-react";
import type { OmnicodeAccountDashboardEntry, OmnicodeProfileSummaryInfo } from "@zcode/shared";
import { maskOmnicodeAccountEmail } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { LoginHealthBadge } from "@/console/ConsoleInstanceCard.js";

/** 头像底色轮换（纯展示；对齐演示稿 AVC 色板）。 */
const AVATAR_COLORS = [
  "bg-blue-500/80",
  "bg-violet-500/80",
  "bg-teal-500/80",
  "bg-orange-500/80",
  "bg-pink-500/80",
];

/** 额度余量分档（对齐演示稿/Cockpit 口径：<10% 红、<30% 黄、<60% 中性、其余蓝）。 */
export function resolveOmnicodeQuotaTier(remainingPct: number): "ok" | "mid" | "warn" | "bad" {
  if (remainingPct < 10) return "bad";
  if (remainingPct < 30) return "warn";
  if (remainingPct < 60) return "mid";
  return "ok";
}

const QUOTA_TIER_CLASSES: Record<string, string> = {
  ok: "bg-blue-500",
  mid: "bg-slate-400",
  warn: "bg-amber-500",
  bad: "bg-red-500",
};

const QUOTA_TIER_LABEL_KEYS: Record<string, string> = {
  ok: "console.dashboard.quotaOk",
  mid: "console.dashboard.quotaMid",
  warn: "console.dashboard.quotaWarn",
  bad: "console.dashboard.quotaBad",
};

/** 相对时间（纯函数）：刚刚 / N 分钟前 / N 小时前 / 昨天 / 具体日期。 */
export function formatOmnicodeRelativeTime(timestamp: number | undefined, now: number): string | null {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return "justNow";
  if (minutes < 60) return `minutes:${minutes}`;
  if (minutes < 60 * 24) return `hours:${Math.floor(minutes / 60)}`;
  if (minutes < 60 * 24 * 2) return "yesterday";
  return `date:${new Date(timestamp).toISOString().slice(0, 10)}`;
}

function formatQuotaEpoch(seconds: number | undefined, intl: ReturnType<typeof useZCodeIntl>["intl"]): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return intl.formatMessage({ id: "console.dashboard.valueEmpty" });
  }
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return intl.formatMessage(
    { id: "console.dashboard.datetime" },
    {
      month: pad(date.getMonth() + 1),
      day: pad(date.getDate()),
      hour: pad(date.getHours()),
      minute: pad(date.getMinutes()),
    },
  );
}

/** 单账号看板卡（异常态引导优先于数字——对齐演示稿「token 失效卡引导优先」旁注）。 */
export function AccountDashboardCard(props: {
  entry: OmnicodeAccountDashboardEntry;
  profile?: OmnicodeProfileSummaryInfo;
  refreshing: boolean;
  onRefresh: (profileId: string) => void;
  onOpenInstance: (profileId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { entry, profile, refreshing, onRefresh, onOpenInstance } = props;
  const identity = entry.identity;
  const displayName = identity?.displayName?.trim() || entry.profileName;
  const maskedEmail = maskOmnicodeAccountEmail(identity?.email);
  const balance = entry.balance;
  // 额度块收窄：quotaTotal 必须是正数（服务端可能给 0/负值——除零防护）
  const quota =
    typeof balance?.quotaTotal === "number" && Number.isFinite(balance.quotaTotal) && balance.quotaTotal > 0
      ? { ...balance, quotaTotal: balance.quotaTotal }
      : undefined;
  const remainingPct =
    quota && quota.quotaRemaining !== undefined
      ? Math.max(0, Math.min(100, Math.round((quota.quotaRemaining / quota.quotaTotal) * 100)))
      : null;
  const tier = remainingPct !== null ? resolveOmnicodeQuotaTier(remainingPct) : null;
  const usedPct = quota
    ? Math.min(100, Math.round(((quota.quotaUsed ?? 0) / quota.quotaTotal) * 100))
    : 0;
  const activePlan = balance?.plans.find((plan) => plan.status === "active") ?? balance?.plans[0];
  const now = Date.now();
  const avatarColor = AVATAR_COLORS[entry.profileName.length % AVATAR_COLORS.length];

  return (
    <section
      className={cn(
        "relative flex flex-col gap-3 rounded-lg border border-border bg-popover p-3.5 transition-[border-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground-subtle/60 hover:shadow-md",
        refreshing && "border-primary/50 shadow-[0_0_0_3px_rgba(59,130,246,0.10)]",
      )}
      data-omnicode-account-card={entry.profileId}
    >
      {/* 头部：头像 / 显示名 / 脱敏邮箱 / 登录健康度（复用 X2 徽标） */}
      <header className="flex items-center gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full text-ui-base font-bold text-white",
            avatarColor,
          )}
          aria-hidden="true"
        >
          {displayName.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-ui-sm font-bold text-foreground">{displayName}</b>
          <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
            {maskedEmail ?? entry.profileId}
          </span>
        </span>
        <LoginHealthBadge running={profile?.running === true} loginHealth={profile?.loginHealth} />
      </header>

      {/* 徽标行：provider / 套餐 / 实例归属 + 运行态 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.session?.activeProvider ? (
          <span className="rounded-full border border-primary/35 bg-primary/10 px-2 py-0.5 text-ui-xs text-blue-400">
            {entry.session.activeProvider}
          </span>
        ) : null}
        {balance?.planType ? (
          <span className="rounded-full border border-border bg-foreground/5 px-2 py-0.5 text-ui-xs text-foreground">
            {balance.planType}
          </span>
        ) : null}
        {profile ? (
          <span className="flex items-center gap-1.5 rounded-lg border border-border bg-foreground/5 px-2 py-0.5 text-ui-xs text-foreground-subtle">
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                profile.running ? "animate-pulse bg-emerald-500" : "bg-foreground-subtlest",
              )}
            />
            {profile.name} ·{" "}
            {intl.formatMessage({
              id: profile.running
                ? "console.dashboard.instanceRunning"
                : "console.dashboard.instanceStopped",
            })}
          </span>
        ) : null}
      </div>

      {/* 中段：额度块（ok）/ 异常引导（非 ok） */}
      {quota && tier ? (
        <div className="rounded-lg border border-border bg-background px-3 py-2.5">
          <div className="flex items-baseline justify-between text-ui-xs text-foreground-subtlest">
            <span>{intl.formatMessage({ id: "console.dashboard.quotaLabel" })}</span>
            <b className="text-ui-sm font-bold text-foreground">
              {intl.formatMessage(
                { id: "console.dashboard.quotaUsedOf" },
                {
                  used: String(quota.quotaUsed ?? 0),
                  total: String(quota.quotaTotal),
                },
              )}
            </b>
          </div>
          <div className="my-2 h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <span
              className={cn("block h-full rounded-full transition-[width] duration-500", QUOTA_TIER_CLASSES[tier])}
              style={{ width: `${Math.min(100, Math.max(2, usedPct))}%` }}
            />
          </div>
          <div className="flex justify-between text-ui-xs text-foreground-subtlest">
            <span>
              {intl.formatMessage(
                { id: "console.dashboard.quotaRemaining" },
                {
                  remaining: String(quota.quotaRemaining ?? 0),
                  percent: String(remainingPct),
                },
              )}
            </span>
            <span>{intl.formatMessage({ id: QUOTA_TIER_LABEL_KEYS[tier] ?? "console.dashboard.quotaMid" })}</span>
          </div>
        </div>
      ) : (
        <DashboardEntryAlert entry={entry} onOpenInstance={() => onOpenInstance(entry.profileId)} />
      )}

      {/* 元信息行：套餐到期 / 额度重置 / 最后刷新 */}
      <dl className="flex flex-col gap-1 text-ui-xs">
        <div className="flex justify-between">
          <dt className="text-foreground-subtlest">
            {intl.formatMessage({ id: "console.dashboard.planEnds" })}
          </dt>
          <dd className="text-foreground-subtle">{formatQuotaEpoch(activePlan?.endsAt, intl)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-foreground-subtlest">
            {intl.formatMessage({ id: "console.dashboard.quotaReset" })}
          </dt>
          <dd className="text-foreground-subtle">{formatQuotaEpoch(balance?.quotaResetAt, intl)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-foreground-subtlest">
            {intl.formatMessage({ id: "console.dashboard.lastRefresh" })}
          </dt>
          <dd className="text-foreground-subtle">
            {formatRelativeLabel(entry.balanceFetchedAt, now, intl)}
          </dd>
        </div>
      </dl>

      {/* 操作钮 */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onOpenInstance(entry.profileId)}>
          <Play className="size-3.5" />
          {intl.formatMessage({ id: "console.dashboard.openInstance" })}
        </Button>
        <Button variant="outline" size="sm" disabled={refreshing} onClick={() => onRefresh(entry.profileId)}>
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {intl.formatMessage({ id: "console.dashboard.refreshCard" })}
        </Button>
      </div>
    </section>
  );
}

/** 相对时间文案（与 formatOmnicodeRelativeTime 的标记配对；缺失回退「从未」）。 */
function formatRelativeLabel(
  timestamp: number | undefined,
  now: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  const marker = formatOmnicodeRelativeTime(timestamp, now);
  if (marker === null) return intl.formatMessage({ id: "console.dashboard.rel.never" });
  if (marker === "justNow") return intl.formatMessage({ id: "console.dashboard.rel.justNow" });
  if (marker === "yesterday") return intl.formatMessage({ id: "console.dashboard.rel.yesterday" });
  if (marker.startsWith("minutes:")) {
    return intl.formatMessage(
      { id: "console.dashboard.rel.minutesAgo" },
      { count: marker.slice("minutes:".length) },
    );
  }
  if (marker.startsWith("hours:")) {
    return intl.formatMessage(
      { id: "console.dashboard.rel.hoursAgo" },
      { count: marker.slice("hours:".length) },
    );
  }
  if (marker.startsWith("date:")) {
    return intl.formatMessage(
      { id: "console.dashboard.rel.date" },
      { date: marker.slice("date:".length) },
    );
  }
  return intl.formatMessage({ id: "console.dashboard.rel.never" });
}

/**
 * 异常卡引导（balanceState ≠ ok）：missing_jwt=未登录、skipped_no_device_mid=缺设备号
 * （风控红线：不代生成）、failed=拉取失败（401 引导重登 / 其余显示原因）、
 * unknown=旧密文等读不到。全部给出明确下一步而非空洞 "——"。
 */
function DashboardEntryAlert(props: { entry: OmnicodeAccountDashboardEntry; onOpenInstance: () => void }) {
  const { intl } = useZCodeIntl();
  const { entry, onOpenInstance } = props;
  if (entry.balanceState === "ok") return null;
  if (entry.balanceState === "missing_jwt") {
    return (
      <AlertBox tone="info" titleId="console.dashboard.alertNoJwtTitle" bodyId="console.dashboard.alertNoJwtBody">
        <Button variant="outline" size="sm" onClick={onOpenInstance}>
          {intl.formatMessage({ id: "console.dashboard.alertOpenInstance" })}
        </Button>
      </AlertBox>
    );
  }
  if (entry.balanceState === "skipped_no_device_mid") {
    return (
      <AlertBox tone="info" titleId="console.dashboard.alertNoDeviceTitle" bodyId="console.dashboard.alertNoDeviceBody" />
    );
  }
  if (entry.balanceState === "failed") {
    // 失败原因显示不静默（401/网络/服务异常都归 failed——原因键文案区分说明，
    // 不从 reasonKey 推断 401 具体态）；一律给「打开实例」引导（需重登时它就是入口）。
    return (
      <AlertBox
        tone="bad"
        titleId="console.dashboard.alertFailedTitle"
        bodyId="console.dashboard.alertFailedBody"
      >
        <div className="flex items-center gap-2">
          {entry.balanceErrorReasonKey ? (
            <span className="text-ui-xs opacity-80">
              {intl.formatMessage({ id: entry.balanceErrorReasonKey })}
            </span>
          ) : null}
          <Button variant="outline" size="sm" onClick={onOpenInstance}>
            {intl.formatMessage({ id: "console.dashboard.alertOpenInstance" })}
          </Button>
        </div>
      </AlertBox>
    );
  }
  return (
    <AlertBox tone="info" titleId="console.dashboard.alertUnknownTitle" bodyId="console.dashboard.alertUnknownBody" />
  );
}

function AlertBox(props: {
  tone: "info" | "bad";
  titleId: string;
  bodyId: string;
  children?: React.ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const { tone, titleId, bodyId, children } = props;
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border px-3 py-2.5",
        tone === "bad"
          ? "border-red-500/30 bg-red-500/10 text-red-300"
          : "border-primary/30 bg-primary/10 text-blue-300",
      )}
    >
      <b className="text-ui-sm font-bold">{intl.formatMessage({ id: titleId })}</b>
      <span className="text-ui-xs opacity-90">{intl.formatMessage({ id: bodyId })}</span>
      {children ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

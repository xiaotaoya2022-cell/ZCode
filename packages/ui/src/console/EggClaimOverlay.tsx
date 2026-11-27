// [OmniCode] 批次3 UI 批次：赛博鸡蛋左下浮层（spec:
// F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3；观感对标演示稿
// console-dashboard-demo.html 02 节）。
// - 检测数据源 = OmnicodeAccountDetectGet（管理器启动一次 + 手动「重新检测」；main 侧
//   自动领取轮询的领取事件也会同步清票）。[OmniCode] omni.5 真机修复（F3-7）：无票
//   空闲态不再整层静默——左下角常驻零态引导（检测中/暂无可领/需登录三态）+ 首屏可见
//   的手动检测按钮（设置分区入口保留）。
// - 手动领取（点击门票叠）= OmnicodeAccountClaimRun(mode manual)，进度经
//   OmnicodeAccountClaimEvent 逐张动效（高亮→打勾→「账号 +到账额度」+ 顶部进度），
//   随时可「跳过动画」；右键 = 静默全部领取（同 mode manual，不播动效直接结算态）。
// - 自动领取（main 30min 轮询，mode auto）：领取中不打扰（无动效，逐张清票）；
//   完成后左下角结算徽章「今日已自动领取 N 份」，点开明细读 console-ui claimHistory。
// - 风控红线：领取频率/节奏/凭据全部在 main 数据层（claimPacer/billingClient），本组件
//   仅消费事件，无任何直接网络请求。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Egg, RefreshCw, X } from "lucide-react";
import type {
  OmnicodeAccountClaimEventPayload,
  OmnicodeClaimHistoryEntry,
  OmnicodeAccountDetectionEntry,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  buildOmnicodeTicketStackLayout,
  summarizeOmnicodeAutoSettlementFromHistory,
  summarizeOmnicodeClaimSettlement,
  type OmnicodeClaimSettlement,
  type OmnicodeClaimTicketOutcome,
} from "@/console/eggClaimModel.js";

/** 手动领取浮层阶段：idle=待领取 / claiming=动效中 / silent=静默等待 / settled=结算态。 */
type EggClaimPhase = "idle" | "claiming" | "silent" | "settled";

/** 错落槽位 transform（对齐演示稿 data-i 0..3；hover 由组内 hover 态展开）。 */
const TICKET_SLOT_TRANSFORMS = [
  "rotate(-7deg) translate(-8px, 6px) scale(0.96)",
  "rotate(-3deg) translate(-4px, 3px)",
  "rotate(2deg) translate(3px, 1px)",
  "rotate(6deg) translate(7px, -2px)",
];
const TICKET_SLOT_HOVER_TRANSFORMS = [
  "rotate(-5deg) translate(-10px, -34px)",
  "rotate(-2deg) translate(-4px, -24px)",
  "rotate(1deg) translate(3px, -14px)",
  "rotate(4deg) translate(7px, 0)",
];
const TICKET_SLOT_Z = [10, 20, 30, 40];

/** 门票数据（检测条目的展示子集）。 */
interface EggTicket {
  profileId: string;
  displayName: string;
  maskedEmail?: string;
  planName?: string;
  grantedUnits?: number;
}

/**
 * 赛博鸡蛋左下浮层（ConsoleHome 常驻；无蛋日整个不渲染）。挂载即检测一次
 *（reason=startup）+ 订阅领取事件；「重新检测」由设置分区手动触发同一检测链。
 */
export function EggClaimOverlay() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();

  // ─── 检测态（门票叠数据源） ───
  const [tickets, setTickets] = useState<EggTicket[]>([]);
  const [detectionDone, setDetectionDone] = useState(false);
  // ─── 手动领取态 ───
  const [phase, setPhase] = useState<EggClaimPhase>("idle");
  const [outcomes, setOutcomes] = useState<OmnicodeClaimTicketOutcome[]>([]);
  const outcomesRef = useRef<OmnicodeClaimTicketOutcome[]>([]);
  const [settlement, setSettlement] = useState<OmnicodeClaimSettlement | null>(null);
  const [runTotal, setRunTotal] = useState(0);
  const manualRunIdRef = useRef<string | null>(null);
  const phaseRef = useRef<EggClaimPhase>("idle");
  const [flownIds, setFlownIds] = useState<Set<string>>(new Set());
  // ─── 右键菜单 ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // ─── 自动领取结算徽章（明细 = console-ui claimHistory 今日 auto 条目） ───
  const [autoSettlement, setAutoSettlement] = useState<{ count: number; granted?: number } | null>(
    null,
  );
  const [autoDetails, setAutoDetails] = useState<OmnicodeClaimHistoryEntry[]>([]);
  const [autoBadgeOpen, setAutoBadgeOpen] = useState(false);
  const [autoBadgeDismissed, setAutoBadgeDismissed] = useState(false);
  // 检测结果的全量展示名映射（自动领取明细/到账 chips 里的账号名数据源；tickets 只留可领）
  const [displayNameById, setDisplayNameById] = useState<Record<string, string>>({});
  // [OmniCode] omni.5 真机修复（F3-7/F3-8）：零态引导数据源——全量检测条目（含
  // missing_jwt/no_claim/skipped），无 claimable 时给「检测中/暂无可领/需登录」三态
  // 引导 + 常驻手动检测入口，替代此前 tickets=0 整层静默不渲染。
  const [detectEntries, setDetectEntries] = useState<OmnicodeAccountDetectionEntry[]>([]);
  const [detecting, setDetecting] = useState(false);

  const refreshAutoBadgeFromHistory = useCallback((history: OmnicodeClaimHistoryEntry[]) => {
    const summary = summarizeOmnicodeAutoSettlementFromHistory(history, Date.now());
    if (summary) {
      setAutoSettlement({ count: summary.succeededCount, granted: summary.grantedTotal });
    }
    // 明细列表 = 今日 auto 条目（点击徽章时读内存快照即可，无需再走 IPC）
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    setAutoDetails(history.filter((entry) => entry.mode === "auto" && entry.at >= dayStart.getTime()));
  }, []);

  const runDetect = useCallback(
    async (reason: "startup" | "manual") => {
      setDetecting(true);
      try {
        const result = await platform.getOmnicodeAccountDetect?.({ reason });
        if (result) {
          setDisplayNameById(
            Object.fromEntries(result.accounts.map((account) => [account.profileId, account.displayName])),
          );
          setDetectEntries(result.accounts);
          setTickets(
            result.accounts
              .filter((account) => account.state === "claimable")
              .map((account) => ({
                profileId: account.profileId,
                displayName: account.displayName,
                ...(account.maskedEmail !== undefined ? { maskedEmail: account.maskedEmail } : {}),
                ...(account.planName !== undefined ? { planName: account.planName } : {}),
                ...(account.grantedUnits !== undefined ? { grantedUnits: account.grantedUnits } : {}),
              })),
          );
        } else {
          setDetectEntries([]);
        }
      } catch {
        // 桥缺席：零态按"暂无可领"降级（不再整层静默）。
        setDetectEntries([]);
      } finally {
        setDetecting(false);
        setDetectionDone(true);
      }
    },
    [platform],
  );

  // ─── 检测（挂载一次；检测状态更新另有三路：手动 run no_targets 清票 / 自动领取
  // 事件逐张清票 / 设置分区「手动检测一次」走 toast 不改浮层，下一拍检测自对齐） ───
  useEffect(() => {
    void (async () => {
      await runDetect("startup");
      // 挂载时补自动领取结算徽章（自动领取可能发生在窗口关闭期间）
      await platform
        .getOmnicodeConsoleUiState?.()
        .then((state) => refreshAutoBadgeFromHistory(state.claimHistory ?? []))
        .catch(() => undefined);
    })();
  }, [platform, refreshAutoBadgeFromHistory, runDetect]);

  // ─── 领取事件订阅（manualRunId 区分本浮层发起的 run 与 main 自动领取 run） ───
  useEffect(() => {
    const unsubscribe = platform.onOmnicodeAccountClaimEvent?.((payload: OmnicodeAccountClaimEventPayload) => {
      if (payload.type === "started" && payload.runId === manualRunIdRef.current) {
        setRunTotal(payload.total);
        setOutcomes([]);
        return;
      }
      if (payload.type === "started") {
        // main 侧自动领取 run 启动：不打扰（无动效），仅记录
        return;
      }
      if (payload.type === "account_start") return;
      if (payload.type === "account_result") {
        // [OmniCode] 挑刺 B-03：mode 是广播方事实，与 renderer 侧 runId 登记时序无关
        //（main 的 skipped account_result 在 invoke resolve 前到达，runId 匹配会把
        // manual 首批事件误归 auto 分支）。runId 匹配保留为双保险，mode 为准。
        const isManual = payload.mode === "manual" || payload.runId === manualRunIdRef.current;
        if (isManual) {
          const next: OmnicodeClaimTicketOutcome = {
            profileId: payload.profileId,
            outcome: payload.outcome,
            ...(payload.grantedUnits !== undefined ? { grantedUnits: payload.grantedUnits } : {}),
            ...(payload.reasonKey !== undefined ? { reasonKey: payload.reasonKey } : {}),
          };
          outcomesRef.current = [...outcomesRef.current, next];
          setOutcomes(outcomesRef.current);
          if (phaseRef.current !== "silent") {
            setFlownIds((previous) => new Set(previous).add(payload.profileId));
          }
          return;
        }
        // 自动领取：逐张静默清票（不打扰）
        setTickets((previous) => previous.filter((ticket) => ticket.profileId !== payload.profileId));
        return;
      }
      if (payload.type === "done") {
        const isManual = payload.mode === "manual" || payload.runId === manualRunIdRef.current;
        if (isManual) {
          const summary = summarizeOmnicodeClaimSettlement(outcomesRef.current, {
            aborted: payload.aborted,
          });
          setSettlement(summary);
          setPhase("settled");
          phaseRef.current = "settled";
          setTickets([]);
          manualRunIdRef.current = null;
          return;
        }
        // 自动领取完成：徽章（明细读 claimHistory——main 已落盘）
        setTickets([]);
        void platform
          .getOmnicodeConsoleUiState?.()
          .then((state) => {
            refreshAutoBadgeFromHistory(state.claimHistory ?? []);
            setAutoBadgeDismissed(false);
          })
          .catch(() => undefined);
      }
    });
    return unsubscribe ?? (() => {});
    // 逐张结果经 outcomesRef 累积（ref 与 state 双写），订阅只挂一次不随事件重建
  }, [platform, refreshAutoBadgeFromHistory]);

  /** 启动手动领取（点击门票叠）：silent=false 播动效 / true 静默（右键菜单）。 */
  const startClaimRun = useCallback(
    async (silent: boolean) => {
      if (phaseRef.current === "claiming" || phaseRef.current === "silent") return;
      try {
        const result = await platform.runOmnicodeAccountClaim?.({ mode: "manual" });
        if (!result) return;
        if (!result.ok) {
          if (result.reason === "no_targets") {
            toast(intl.formatMessage({ id: "console.egg.toastNoTargets" }), { variant: "default" });
            setTickets([]);
          } else if (result.reason === "in_progress") {
            toast(intl.formatMessage({ id: "console.egg.toastInProgress" }), { variant: "default" });
          }
          return;
        }
        manualRunIdRef.current = result.runId ?? null;
        // [OmniCode] 批次3 终审修复（P2-①）：total 直接取 ClaimRun 响应——started 事件
        // 在 invoke resolve 前同步广播（manualRunId 尚未登记，事件走 auto 分支），此前
        // runTotal 恒 0（HUD「x/0」）。started 分支保留 runTotal 对齐（防御旧 main）。
        setRunTotal(typeof result.total === "number" && result.total > 0 ? result.total : 0);
        outcomesRef.current = [];
        setOutcomes([]);
        setFlownIds(new Set());
        setCtxMenu(null);
        setPhase(silent ? "silent" : "claiming");
        phaseRef.current = silent ? "silent" : "claiming";
        if (silent) setFlownIds(new Set(tickets.map((ticket) => ticket.profileId)));
      } catch {
        toast(intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" }), {
          variant: "warning",
        });
      }
    },
    [intl, platform, tickets],
  );

  /** 跳过动画：已到账条目保留，剩余门票瞬时飞出（事件仍逐张到达，只停动效等待）。 */
  const skipAnimation = useCallback(() => {
    if (phaseRef.current !== "claiming") return;
    setPhase("silent");
    phaseRef.current = "silent";
    setFlownIds((previous) => {
      const next = new Set(previous);
      for (const ticket of tickets) next.add(ticket.profileId);
      return next;
    });
  }, [tickets]);

  /** 关闭结算卡（回到无痕；下次检测/事件再出现）。 */
  const dismissSettlement = useCallback(() => {
    setSettlement(null);
    setPhase("idle");
    phaseRef.current = "idle";
  }, []);

  const layout = useMemo(() => buildOmnicodeTicketStackLayout(tickets.length), [tickets.length]);
  const claimedCount = outcomes.length;
  const idleStack = phase === "idle" && tickets.length > 0;
  const claiming = phase === "claiming" || phase === "silent";
  const showOverlay =
    detectionDone &&
    (idleStack || claiming || phase === "settled" || (autoSettlement !== null && !autoBadgeDismissed));
  // [OmniCode] omni.5 真机修复（F3-7）：零态引导——检测完成但无可领（且无任何浮层态）
  // 时渲染常驻小入口：检测中/暂无可领额度/需登录三态 + 手动检测按钮，不再静默隐藏。
  const zeroStateVisible =
    detectionDone &&
    phase === "idle" &&
    tickets.length === 0 &&
    settlement === null &&
    !(autoSettlement !== null && !autoBadgeDismissed);
  const needsLoginCount = detectEntries.filter((entry) => entry.state === "missing_jwt").length;

  if (!showOverlay && !zeroStateVisible) return null;

  return (
    <div
      className="absolute bottom-4 left-4 z-30 flex flex-col items-start gap-2 [app-region:no-drag]"
      onContextMenu={(event) => {
        if (!idleStack) return;
        event.preventDefault();
        // 菜单容器是 fixed 全屏层：坐标直接用视口 clientX/Y（并向左下钳制避免出窗）
        setCtxMenu({
          x: Math.max(8, event.clientX - 40),
          y: Math.max(8, event.clientY - 8),
        });
      }}
    >
      {/* 逐张到账 chips（manual 动效） */}
      {phase === "claiming" && outcomes.length > 0 ? (
        <ul className="flex max-h-40 flex-col gap-1.5 overflow-hidden">
          {outcomes.map((outcome, index) => {
            const ticket = tickets.find((item) => item.profileId === outcome.profileId);
            return (
              <li
                key={`${outcome.profileId}-${index}`}
                className="flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-ui-sm shadow-md"
              >
                {outcome.outcome === "success" ? (
                  <Check className="size-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <X className="size-3.5 shrink-0 text-amber-500" />
                )}
                <span className="max-w-44 truncate font-medium text-foreground">
                  {ticket?.displayName ?? outcome.profileId}
                </span>
                {outcome.outcome === "success" && outcome.grantedUnits !== undefined ? (
                  <span className="font-mono text-ui-xs text-amber-500">
                    +{outcome.grantedUnits}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* 顶部进度 HUD（manual 动效中） */}
      {phase === "claiming" ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-popover px-3 py-1.5 text-ui-sm text-foreground-subtle shadow-md">
          <span>
            {intl.formatMessage(
              { id: "console.egg.claimingHud" },
              { current: String(claimedCount), total: String(runTotal) },
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-ui-xs text-primary"
            onClick={skipAnimation}
          >
            {intl.formatMessage({ id: "console.egg.skipAnimation" })}
          </Button>
        </div>
      ) : null}
      {phase === "silent" ? (
        <div className="rounded-lg border border-border bg-popover px-3 py-1.5 text-ui-sm text-foreground-subtle shadow-md">
          {intl.formatMessage({ id: "console.egg.settling" })}
        </div>
      ) : null}

      {/* 门票叠（idle / 动效中保留可见；结算态隐藏） */}
      {tickets.length > 0 && phase !== "settled" ? (
        <button
          type="button"
          className="group relative h-[72px] w-44 cursor-pointer outline-none"
          onClick={() => void startClaimRun(false)}
          title={intl.formatMessage({ id: "console.egg.stackTitle" })}
          aria-label={intl.formatMessage({ id: "console.egg.stackTitle" })}
        >
          <span className="absolute -right-2 -top-2 z-50 rounded-full bg-amber-400 px-2 py-0.5 text-ui-xs font-bold text-black shadow">
            ×{layout.badgeCount}
          </span>
          {tickets.map((ticket, index) => {
            const slot = layout.slotIndexes[index] ?? 0;
            const flown = flownIds.has(ticket.profileId);
            return (
              <span
                key={ticket.profileId}
                className={cn(
                  "absolute inset-0 flex items-center gap-2.5 rounded-xl border border-amber-400/50 bg-gradient-to-br from-amber-400/20 via-amber-400/5 to-white/5 px-3 text-left shadow-md transition-transform duration-300 ease-out",
                  // 错落 transform 走 CSS 变量：静止态用 --tf，hover 由 group 切到 --tf-hover
                  "[transform:var(--tf)] group-hover:[transform:var(--tf-hover)]",
                  flown && "opacity-0 [transform:translateY(-120px)_rotate(8deg)_scale(1.05)]",
                )}
                style={
                  {
                    "--tf": TICKET_SLOT_TRANSFORMS[slot],
                    "--tf-hover": TICKET_SLOT_HOVER_TRANSFORMS[slot],
                    zIndex: TICKET_SLOT_Z[slot],
                  } as React.CSSProperties
                }
                data-omnicode-ticket-slot={slot}
              >
                <Egg className="size-6 shrink-0 text-amber-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-sm font-semibold text-foreground">
                    {ticket.displayName}
                  </span>
                  <span className="block truncate font-mono text-ui-xs text-amber-400">
                    {ticket.grantedUnits !== undefined
                      ? intl.formatMessage(
                          { id: "console.egg.ticketUnits" },
                          { units: String(ticket.grantedUnits) },
                        )
                      : (ticket.planName ??
                        intl.formatMessage({ id: "console.egg.ticketFallback" }))}
                  </span>
                </span>
              </span>
            );
          })}
        </button>
      ) : null}

      {/* 结算态（manual 完成） */}
      {settlement ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2 shadow-md">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-500 text-black">
            <Check className="size-4" />
          </span>
          <span className="min-w-0">
            <b className="block text-ui-sm font-bold text-foreground">
              {intl.formatMessage(
                { id: "console.egg.settledTitle" },
                { count: String(settlement.succeeded) },
              )}
            </b>
            <span className="block text-ui-xs text-foreground-subtle">
              {settlement.grantedTotal !== undefined
                ? intl.formatMessage(
                    { id: "console.egg.settledSub" },
                    { units: String(settlement.grantedTotal) },
                  )
                : intl.formatMessage({ id: "console.egg.settledSubUnknown" })}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={dismissSettlement}
            aria-label={intl.formatMessage({ id: "console.egg.dismiss" })}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {/* 自动领取结算徽章 */}
      {autoSettlement && !autoBadgeDismissed ? (
        <div className="relative">
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-popover px-2.5 py-1.5 text-ui-xs text-foreground shadow-sm"
            onClick={() => setAutoBadgeOpen((previous) => !previous)}
          >
            <Egg className="size-3.5 text-amber-400" />
            {intl.formatMessage(
              { id: "console.egg.autoBadgeTitle" },
              { count: String(autoSettlement.count) },
            )}
          </button>
          {autoBadgeOpen ? (
            <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-border bg-popover p-3 shadow-lg">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-ui-sm font-semibold text-foreground">
                  {intl.formatMessage({ id: "console.egg.autoDetailsTitle" })}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  onClick={() => setAutoBadgeDismissed(true)}
                  aria-label={intl.formatMessage({ id: "console.egg.dismiss" })}
                >
                  <X className="size-3" />
                </Button>
              </div>
              {autoDetails.length === 0 ? (
                <p className="text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({ id: "console.egg.autoDetailsEmpty" })}
                </p>
              ) : (
                <ul className="flex max-h-52 flex-col gap-1 overflow-auto">
                  {autoDetails.map((entry, index) => (
                    <li
                      key={`${entry.at}-${entry.profileId}-${index}`}
                      className="flex items-center gap-2 text-ui-xs"
                    >
                      <span
                        className={cn(
                          "shrink-0",
                          entry.outcome === "success" ? "text-emerald-500" : "text-amber-500",
                        )}
                      >
                        {entry.outcome === "success" ? "✓" : "×"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {displayNameById[entry.profileId] ?? entry.profileId}
                      </span>
                      <span className="shrink-0 text-foreground-subtlest">
                        {entry.planName ?? entry.planId}
                      </span>
                      {entry.outcome === "success" && entry.grantedUnits !== undefined ? (
                        <span className="shrink-0 font-mono text-amber-500">
                          +{entry.grantedUnits}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* [OmniCode] omni.5 真机修复（F3-7/F3-8）：零态引导（无票且无任何浮层态时常驻）——
          三态按检测实际结果切换：检测中 / 暂无可领额度 / N 个实例未登录（登录后可领）；
          常驻「重新检测」按钮 = 首屏可见的手动检测入口（不依赖设置页）。 */}
      {zeroStateVisible ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-ui-xs text-foreground-subtle shadow-sm">
          <Egg className="size-3.5 shrink-0 text-amber-400" />
          <span>
            {detecting
              ? intl.formatMessage({ id: "console.egg.zeroDetecting" })
              : needsLoginCount > 0
                ? intl.formatMessage(
                    { id: "console.egg.zeroNeedsLogin" },
                    { count: String(needsLoginCount) },
                  )
                : intl.formatMessage({ id: "console.egg.zeroNoClaim" })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-2 text-ui-xs text-primary"
            disabled={detecting}
            data-testid="console-egg-redetect"
            onClick={() => void runDetect("manual")}
          >
            <RefreshCw className={cn("size-3", detecting && "animate-spin")} />
            {intl.formatMessage({ id: "console.egg.redetect" })}
          </Button>
        </div>
      ) : null}

      {/* 右键菜单（静默全部领取） */}
      {ctxMenu ? (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setCtxMenu(null);
          }}
          role="presentation"
        >
          <div
            className="absolute min-w-40 rounded-lg border border-border bg-popover p-1 shadow-lg"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              disabled={phase !== "idle"}
              onClick={() => void startClaimRun(true)}
            >
              {intl.formatMessage({ id: "console.egg.ctxSilentClaim" })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

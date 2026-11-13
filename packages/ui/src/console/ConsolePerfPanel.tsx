// [OmniCode] 批次2.5 X1：性能监控面板（右侧抽屉，spec: docs/omnicode/console-extras.md §X1）。
// 每运行实例一行（名称 + 当前内存 + 纯 SVG spark 曲线）+ 全局合计；CPU 列 v1 显示 —
// （tasklist 无 CPU 占用列，spec 已知限制 1）。数据 = main 的 OmnicodePerfEvent 广播
//（面板开=采样；unavailable=面板关闭、入口保留可点击重探——R1 P2-1，由 ConsoleInstanceGrid 控制）。
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { OmnicodeProfileSummaryInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  buildOmnicodeSparklinePoints,
  formatOmnicodeMemoryMB,
  pushOmnicodePerfSample,
  type OmnicodePerfSamplePoint,
} from "@/console/perfSpark.js";

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;

export interface ConsolePerfPanelState {
  /** 最新一轮各实例内存（MB；缺省=该实例本轮无样本）。 */
  currentMemoryByProfileId: ReadonlyMap<string, number>;
  /** 各实例走势（环形缓冲，60 点）。 */
  seriesByProfileId: ReadonlyMap<string, OmnicodePerfSamplePoint[]>;
  /** 已收到至少一轮 sample（区分"等待首轮"与"不可用"）。 */
  hasSample: boolean;
}

/**
 * 性能抽屉面板。onClose 由 ConsoleInstanceGrid 传入（同时负责翻转 perfPanelOpen 并
 * 上报 PerfState enabled=false 停止采样）；onUnavailable=main 广播降级（面板关闭 +
 * toast，入口保留可点击重探——R1 P2-1，由 ConsoleInstanceGrid 控制）。
 */
export function ConsolePerfPanel(props: {
  profiles: OmnicodeProfileSummaryInfo[];
  onClose: () => void;
  onUnavailable: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { profiles, onClose, onUnavailable } = props;

  // ─── 采样事件订阅：renderer 侧环形缓冲（纯函数 pushOmnicodePerfSample 累积） ───
  const [state, setState] = useState<ConsolePerfPanelState>({
    currentMemoryByProfileId: new Map(),
    seriesByProfileId: new Map(),
    hasSample: false,
  });
  useEffect(() => {
    const unsubscribe = platform.onOmnicodePerfEvent?.((payload) => {
      // 降级（非 Windows / tasklist 连续失败）：上报网格隐藏「性能」入口（spec §降级语义）
      if (payload.type === "unavailable") {
        onUnavailable();
        return;
      }
      if (payload.type !== "sample") return;
      setState((previous) => {
        const nextMemory = new Map(previous.currentMemoryByProfileId);
        for (const sample of payload.samples) {
          nextMemory.set(sample.profileId, sample.memoryMB);
        }
        // 本轮消失的实例（查询窗口内退出）：移出当前值与曲线（行随之消失，spec 验收 3）
        const alive = new Set(payload.samples.map((sample) => sample.profileId));
        for (const profileId of nextMemory.keys()) {
          if (!alive.has(profileId)) nextMemory.delete(profileId);
        }
        const nextSeries = new Map(previous.seriesByProfileId);
        for (const profileId of nextSeries.keys()) {
          if (!alive.has(profileId) && !nextMemory.has(profileId)) nextSeries.delete(profileId);
        }
        for (const sample of payload.samples) {
          nextSeries.set(
            sample.profileId,
            pushOmnicodePerfSample(nextSeries.get(sample.profileId) ?? [], payload.at, sample.memoryMB),
          );
        }
        return {
          currentMemoryByProfileId: nextMemory,
          seriesByProfileId: nextSeries,
          hasSample: true,
        };
      });
    });
    return unsubscribe ?? (() => {});
  }, [platform, onUnavailable]);

  const running = useMemo(() => profiles.filter((profile) => profile.running), [profiles]);
  const totalMemoryMB = useMemo(() => {
    if (running.length === 0) return null;
    let total = 0;
    for (const profile of running) {
      const memory = state.currentMemoryByProfileId.get(profile.id);
      if (memory === undefined) return null; // 任一实例本轮无样本：不显示合计（不编造部分和）
      total += memory;
    }
    return total;
  }, [running, state.currentMemoryByProfileId]);

  return (
    <aside
      className={cn(
        "absolute right-0 top-0 z-30 flex h-full w-80 flex-col border-l border-border bg-popover/95 backdrop-blur-sm",
      )}
      aria-label={intl.formatMessage({ id: "console.perfPanelTitle" })}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate text-ui-sm font-semibold text-foreground">
          {intl.formatMessage({ id: "console.perfPanelTitle" })}
        </h3>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </header>

      {/* 全局合计（任一实例无样本时不显示——不编造部分和） */}
      <div className="shrink-0 border-b border-border px-3 py-2 text-ui-xs text-foreground-subtle">
        {totalMemoryMB !== null ? (
          <span>
            {intl.formatMessage(
              { id: "console.perfTotalMemory" },
              { memory: formatOmnicodeMemoryMB(totalMemoryMB) },
            )}
          </span>
        ) : (
          <span>{intl.formatMessage({ id: "console.perfWaiting" })}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {running.length === 0 ? (
          <p className="px-3 py-4 text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "console.perfNoRunning" })}
          </p>
        ) : (
          <ul className="flex flex-col">
            {running.map((profile) => {
              const memory = state.currentMemoryByProfileId.get(profile.id);
              const series = state.seriesByProfileId.get(profile.id) ?? [];
              const points = buildOmnicodeSparklinePoints(
                series.map((point) => point.memoryMB),
                SPARK_WIDTH,
                SPARK_HEIGHT,
              );
              return (
                <li
                  key={profile.id}
                  className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground" title={profile.name}>
                    {profile.name}
                  </span>
                  {/* spark：纯 SVG polyline（不引图表库） */}
                  <svg
                    width={SPARK_WIDTH}
                    height={SPARK_HEIGHT}
                    viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
                    className="shrink-0"
                    aria-hidden="true"
                  >
                    {points ? (
                      <polyline
                        points={points}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        className="text-primary"
                      />
                    ) : null}
                  </svg>
                  <span className="w-16 shrink-0 text-right text-ui-xs tabular-nums text-foreground-subtle">
                    {memory !== undefined ? formatOmnicodeMemoryMB(memory) : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="shrink-0 border-t border-border px-3 py-2 text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "console.perfCpuPlaceholder" })}
      </footer>
    </aside>
  );
}

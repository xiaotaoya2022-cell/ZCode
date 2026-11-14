// [OmniCode] 批次2 B2-3：控制台 UI 状态持久化 + 模式切换/预览订阅决策（纯函数可单测）。
// spec: docs/omnicode/profile-runtime.md §批次2 D9。
// 落盘 = 管理器数据根 console-ui.json（原子写 readJsonWithRecovery/writeJsonAtomic）；
// 不写入 .zcode/v2/setting.json——收养后该树归属实例，管理器只写自己的管理数据
// （spec §进程模型："数据根 = 纯管理数据 + 待收养的旧凭据"）。
import { join } from "node:path";
import type {
  OmnicodeClaimHistoryEntry,
  OmnicodeConsoleUiState,
  OmnicodeConsoleUiStatePatch,
} from "@zcode/shared";
import { resolveOmnicodeInstanceDocked } from "@zcode/shared";
import { readJsonWithRecovery, writeJsonAtomic } from "./atomicJson.js";
import { getOmnicodeConsoleDataBaseDir } from "./profileRuntime.js";

export const DEFAULT_OMNICODE_CONSOLE_UI_STATE: OmnicodeConsoleUiState = {
  dockDefault: true,
  dockedByProfileId: {},
  previewEnabled: true,
};

/**
 * [OmniCode] 批次3：领取历史上限（FIFO，超出丢最旧；spec:
 * F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3 存储建议）。
 */
export const OMNICODE_CLAIM_HISTORY_MAX_ENTRIES = 50;

/**
 * UI 状态部分合并（纯函数）：仅接受已知字段且值域合法；未知/非法字段被丢弃
 * （落盘值永远收敛到合法形态）。previewEnabled 相同的字段写不写等价。
 * [OmniCode] 批次2.5 X1：perfPanelOpen 为可选布尔（旧档缺省=关；spec:
 * docs/omnicode/console-extras.md §X1）——只有显式布尔才写入，避免旧档被动携带该字段。
 * [OmniCode] 批次3：autoClaimEnabled 为可选布尔（默认关，语义同 perfPanelOpen）；
 * claimHistory 仅接受合法条目数组（逐条校验、FIFO 截断到上限 50）。
 * [OmniCode] 批次3 停靠重构：dockDefault 仅接受显式布尔；dockAll=v 语义 =
 * dockDefault=v 且清空每实例覆盖表（收敛到全局语义）；dockInstance 写单键覆盖
 * （profileId 非空字符串 ∧ docked 布尔才接受）。旧全局 mode 字段不再接受
 * （迁移只发生在读档路径 migrateOmnicodeConsoleUiState）。
 */
export function mergeOmnicodeConsoleUiState(
  current: OmnicodeConsoleUiState,
  patch: OmnicodeConsoleUiStatePatch | undefined,
): OmnicodeConsoleUiState {
  if (!patch || typeof patch !== "object") return current;
  const next: OmnicodeConsoleUiState = { ...current };
  if (typeof patch.dockDefault === "boolean") {
    next.dockDefault = patch.dockDefault;
  }
  if (patch.dockAll === true || patch.dockAll === false) {
    next.dockDefault = patch.dockAll;
    next.dockedByProfileId = {};
  }
  if (
    patch.dockInstance &&
    typeof patch.dockInstance === "object" &&
    typeof patch.dockInstance.profileId === "string" &&
    patch.dockInstance.profileId.length > 0 &&
    typeof patch.dockInstance.docked === "boolean"
  ) {
    next.dockedByProfileId = { ...next.dockedByProfileId, [patch.dockInstance.profileId]: patch.dockInstance.docked };
  }
  if (typeof patch.previewEnabled === "boolean") {
    next.previewEnabled = patch.previewEnabled;
  }
  if (typeof patch.perfPanelOpen === "boolean") {
    next.perfPanelOpen = patch.perfPanelOpen;
  }
  if (typeof patch.autoClaimEnabled === "boolean") {
    next.autoClaimEnabled = patch.autoClaimEnabled;
  }
  if (patch.claimHistory !== undefined) {
    const normalized = normalizeOmnicodeClaimHistory(patch.claimHistory);
    // 显式携带 claimHistory 才更新（undefined = 不变）；空数组 = 清空历史
    next.claimHistory = normalized;
  }
  return next;
}

/** claimHistory 单条合法性校验（纯函数）：缺核心字段/枚举越界即丢弃该条。 */
function isValidOmnicodeClaimHistoryEntry(entry: unknown): entry is OmnicodeClaimHistoryEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate["at"] !== "number" || !Number.isFinite(candidate["at"])) return false;
  if (typeof candidate["profileId"] !== "string" || candidate["profileId"].length === 0) return false;
  if (typeof candidate["planId"] !== "string" || candidate["planId"].length === 0) return false;
  if (candidate["outcome"] !== "success" && candidate["outcome"] !== "failed" && candidate["outcome"] !== "skipped") {
    return false;
  }
  if (candidate["mode"] !== "manual" && candidate["mode"] !== "auto") return false;
  if (
    candidate["reasonKey"] !== undefined &&
    (typeof candidate["reasonKey"] !== "string" || candidate["reasonKey"].length === 0)
  ) {
    return false;
  }
  if (
    candidate["planName"] !== undefined &&
    (typeof candidate["planName"] !== "string" || candidate["planName"].length === 0)
  ) {
    return false;
  }
  if (
    candidate["grantedUnits"] !== undefined &&
    (typeof candidate["grantedUnits"] !== "number" || !Number.isFinite(candidate["grantedUnits"]))
  ) {
    return false;
  }
  return true;
}

/** claimHistory 归一（纯函数）：逐条校验 + FIFO 截断（保最新 50 条）。 */
export function normalizeOmnicodeClaimHistory(
  raw: readonly unknown[],
): OmnicodeClaimHistoryEntry[] {
  const valid = (Array.isArray(raw) ? raw : []).filter(isValidOmnicodeClaimHistoryEntry);
  return valid.length > OMNICODE_CLAIM_HISTORY_MAX_ENTRIES
    ? valid.slice(valid.length - OMNICODE_CLAIM_HISTORY_MAX_ENTRIES)
    : valid;
}

/**
 * 追加一条领取历史（纯函数）：FIFO 上限 50 条（超出丢最旧）。current 里的非法条目
 * 一并清洗（读档归一的兜底，写路径永远收敛到合法形态）。
 */
export function appendOmnicodeClaimHistory(
  current: readonly OmnicodeClaimHistoryEntry[] | undefined,
  entry: OmnicodeClaimHistoryEntry,
): OmnicodeClaimHistoryEntry[] {
  const base = normalizeOmnicodeClaimHistory(current ?? []);
  const merged = [...base, entry];
  return merged.length > OMNICODE_CLAIM_HISTORY_MAX_ENTRIES
    ? merged.slice(merged.length - OMNICODE_CLAIM_HISTORY_MAX_ENTRIES)
    : merged;
}

/**
 * [OmniCode] 批次3 停靠重构：旧档案一次性迁移（纯函数）。console-ui.json 携带全局
 * `mode`（"embedded"|"desktop"）时：mode=desktop → 全部拖出（dockDefault=false）；
 * mode=embedded（或损坏值，按缺省语义回停靠）→ 全部停靠（dockDefault=true）；
 * 覆盖表清空（迁移语义=现状整体映射，不保留历史覆盖）。迁移后档案不再含 mode 字段
 * （写回由 loadOmnicodeConsoleUiStateMigrating 完成）。无 mode 字段 = 原样透传。
 */
export function migrateOmnicodeConsoleUiState(
  parsed: unknown,
): { state: Partial<OmnicodeConsoleUiState> & Record<string, unknown>; migrated: boolean } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: {}, migrated: false };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw["mode"] === undefined) {
    return { state: raw as Partial<OmnicodeConsoleUiState> & Record<string, unknown>, migrated: false };
  }
  const legacyDocked = raw["mode"] !== "desktop"; // "embedded" 或损坏值 → 停靠（缺省语义）
  const { mode: _legacyMode, ...rest } = raw;
  return {
    state: {
      ...rest,
      dockDefault: legacyDocked,
      dockedByProfileId: {},
    },
    migrated: true,
  };
}

/**
 * 读取持久化状态并完成旧档案一次性迁移写回（损坏/缺省回退默认；不抛错——UI 偏好
 * 不值得阻断启动）。[OmniCode] 批次3 停靠重构：读档即迁移（mode → dockDefault），
 * 迁移发生时原子写回（去掉 mode 字段），保证"读取旧值迁移后写回、用户现状不丢"；
 * 迁移写失败不阻断（下次读档仍会迁移，幂等）。
 */
export async function loadOmnicodeConsoleUiStateMigrating(): Promise<{
  state: OmnicodeConsoleUiState;
  migratedFromLegacyMode: boolean;
}> {
  const parsed = await readJsonWithRecovery<Partial<OmnicodeConsoleUiState> & Record<string, unknown>>(
    getConsoleUiStatePath(),
  );
  const { state: migratedPartial, migrated } = migrateOmnicodeConsoleUiState(parsed);
  const state = mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, migratedPartial);
  if (migrated) {
    await writeOmnicodeConsoleUiState(state);
  }
  return { state, migratedFromLegacyMode: migrated };
}

/** 读取持久化状态（迁移感知；不写回——写回仅由 loadOmnicodeConsoleUiStateMigrating 完成）。 */
export async function readOmnicodeConsoleUiState(): Promise<OmnicodeConsoleUiState> {
  return (await loadOmnicodeConsoleUiStateMigrating()).state;
}

/** 原子写持久化（失败仅告警——模式/预览偏好丢失可接受，不该阻断交互）。 */
export async function writeOmnicodeConsoleUiState(state: OmnicodeConsoleUiState): Promise<void> {
  try {
    await writeJsonAtomic(getConsoleUiStatePath(), state);
  } catch (error) {
    console.warn("[omnicode] console-ui.json 写入失败（不阻断）:", error);
  }
}

function getConsoleUiStatePath(): string {
  return join(getOmnicodeConsoleDataBaseDir(), "console-ui.json");
}

/**
 * [OmniCode] 批次3 停靠重构：停靠状态迁移差异决策（纯函数，替代旧全局 mode 跨越判定）。
 * 对给定候选实例集合逐个解析前后停靠态，输出需要进入停靠（toDock）与需要拖出
 *（toUndock）的 profileId 列表；顺序保持候选输入顺序（ownInstances 批处理稳定）。
 */
export interface OmnicodeDockStateDiff {
  toDock: string[];
  toUndock: string[];
}

export function diffOmnicodeDockState(
  previous: Pick<OmnicodeConsoleUiState, "dockDefault" | "dockedByProfileId">,
  next: Pick<OmnicodeConsoleUiState, "dockDefault" | "dockedByProfileId">,
  profileIds: readonly string[],
): OmnicodeDockStateDiff {
  const toDock: string[] = [];
  const toUndock: string[] = [];
  for (const profileId of profileIds) {
    const wasDocked = resolveOmnicodeInstanceDocked(previous, profileId);
    const nowDocked = resolveOmnicodeInstanceDocked(next, profileId);
    if (wasDocked === nowDocked) continue;
    if (nowDocked) toDock.push(profileId);
    else toUndock.push(profileId);
  }
  return { toDock, toUndock };
}

/**
 * 实时预览订阅决策（纯函数）：每个已连接实例的期望订阅态 =
 * 总开关 ∧ 卡片在视口内。总开关关 = 全部退订（卡片停留最后一帧灰暗化，spec §4.3）。
 * 输出以 Map 返回，调用方与桥实际订阅态做 diff 后增减指令。
 */
export function resolveOmnicodePreviewSubscriptions(input: {
  previewEnabled: boolean;
  visibleProfileIds: readonly string[];
  connectedProfileIds: readonly string[];
}): Map<string, boolean> {
  const visible = new Set(input.visibleProfileIds);
  const desired = new Map<string, boolean>();
  for (const profileId of input.connectedProfileIds) {
    desired.set(profileId, input.previewEnabled && visible.has(profileId));
  }
  return desired;
}

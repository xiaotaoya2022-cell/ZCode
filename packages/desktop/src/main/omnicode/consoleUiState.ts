// [OmniCode] 批次2 B2-3：控制台 UI 状态持久化 + 模式切换/预览订阅决策（纯函数可单测）。
// spec: docs/omnicode/profile-runtime.md §批次2 D9。
// 落盘 = 管理器数据根 console-ui.json（原子写 readJsonWithRecovery/writeJsonAtomic）；
// 不写入 .zcode/v2/setting.json——收养后该树归属实例，管理器只写自己的管理数据
// （spec §进程模型："数据根 = 纯管理数据 + 待收养的旧凭据"）。
import { join } from "node:path";
import type { OmnicodeConsoleUiState, OmnicodeConsoleUiStatePatch } from "@zcode/shared";
import { readJsonWithRecovery, writeJsonAtomic } from "./atomicJson.js";
import { getOmnicodeConsoleDataBaseDir } from "./profileRuntime.js";

export type OmnicodeConsoleMode = OmnicodeConsoleUiState["mode"];

export const DEFAULT_OMNICODE_CONSOLE_UI_STATE: OmnicodeConsoleUiState = {
  mode: "embedded",
  previewEnabled: true,
};

/**
 * UI 状态部分合并（纯函数）：仅接受已知字段且值域合法；未知/非法字段被丢弃
 * （落盘值永远收敛到合法形态）。mode 相同 / previewEnabled 相同的字段写不写等价。
 */
export function mergeOmnicodeConsoleUiState(
  current: OmnicodeConsoleUiState,
  patch: OmnicodeConsoleUiStatePatch | undefined,
): OmnicodeConsoleUiState {
  if (!patch || typeof patch !== "object") return current;
  const next: OmnicodeConsoleUiState = { ...current };
  if (patch.mode === "embedded" || patch.mode === "desktop") {
    next.mode = patch.mode;
  }
  if (typeof patch.previewEnabled === "boolean") {
    next.previewEnabled = patch.previewEnabled;
  }
  return next;
}

/** 读取持久化状态（损坏/缺省回退默认；不抛错——UI 偏好不值得阻断启动）。 */
export async function readOmnicodeConsoleUiState(): Promise<OmnicodeConsoleUiState> {
  const parsed = await readJsonWithRecovery<Partial<OmnicodeConsoleUiState>>(getConsoleUiStatePath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_OMNICODE_CONSOLE_UI_STATE };
  return mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, parsed);
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

/** 模式切换决策（纯函数）：只有 embedded↔desktop 跨越才触发 owned 编排/解除。 */
export type OmnicodeConsoleModeTransition = "none" | "enterEmbed" | "exitEmbed";

export function resolveOmnicodeConsoleModeTransition(
  currentMode: OmnicodeConsoleMode,
  requestedMode: OmnicodeConsoleMode,
): OmnicodeConsoleModeTransition {
  if (currentMode === requestedMode) return "none";
  return requestedMode === "embedded" ? "enterEmbed" : "exitEmbed";
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

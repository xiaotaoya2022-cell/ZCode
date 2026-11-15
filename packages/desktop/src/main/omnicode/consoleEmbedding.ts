// [OmniCode] 批次2 B2-3：管理器内嵌编排（owned-window 方案，spec §批次2 D9）。
// [OmniCode] 批次3 停靠重构：全局 embedded/desktop 模式退役，改为每实例 docked 布尔
//（console-ui.json dockDefault + dockedByProfileId，spec §批次3 停靠重构）。
// - docked=true：窗口 owned 进卡片画面区（贴合 B 套件：隐藏底图由 renderer 完成，
//   零滞后跟随 = 窗口 move/resize 直推缓存矩形，resize 手柄 = 卡片权威调高）；
// - docked=false：releaseEmbed 恢复桌面窗口（任务栏项复位），卡片转纯监控态；
//   实例不被 own、不参与布局下发、不受管理器最小化影响（owned 关系已解除）。
//
// 生命周期红线（Win32：owned window 随 owner 销毁——管理器窗口销毁会连带杀死内嵌实例）：
// - 管理器窗口 close/before-quit → prepareAppQuit 屏障内 await releaseOmnicodeEmbedForQuit()
//   （幂等 + 超时上限）。owned 登记 ≡ 停靠实例（undocked 实例无 owned 关系），
//   故 quit 收尾天然只处理 docked；undocked 实例 quit 时不打扰。
// - 管理器崩溃/被强杀无法收尾 → 停靠实例被连坐销毁，记录为已知限制（spec D9）。
//
// PowerShell 纪律：owned 设置/解除 = 一次性 spawn（-NoProfile -NonInteractive -Command，
// argv 数组直传、禁 shell 拼接），全部动态参数经 16 位 hex 白名单字面量校验后内插；
// 不长驻任何脚本进程。
//
// 导入说明：桥服务从实现文件导入（经 contract.ts 会与本文件形成导出循环，同
// instanceManager 的既有约定）。
import { execFile } from "node:child_process";
import process from "node:process";
import type { BrowserWindow } from "electron";
import type {
  OmnicodeConsoleEmbedLayoutInput,
  OmnicodeConsolePreviewStateInput,
  OmnicodeConsoleUiState,
} from "@zcode/shared";
import { resolveOmnicodeInstanceDocked } from "@zcode/shared";
import { assertValidProfileId } from "./profileRuntime.js";
import {
  sendOmnicodeInstanceCommand,
  setOmnicodeInstanceThumbnailSubscription,
  getOmnicodeConnectedInstanceProfileIds,
} from "./instanceBridgeServer.js";
import {
  clampOmnicodeScreenRectToEmbedMinimum,
  convertOmnicodeClientRectToScreen,
  insetOmnicodeEmbedRectForResizeHandles,
  isOmnicodeEmbedRectUsable,
  isValidOmnicodeHwndHex,
} from "./embedLayoutMath.js";
import {
  diffOmnicodeDockState,
  loadOmnicodeConsoleUiStateMigrating,
  readOmnicodeConsoleUiState,
  writeOmnicodeConsoleUiState,
  resolveOmnicodePreviewSubscriptions,
} from "./consoleUiState.js";

/** renderer 上报布局变化的下发节流（main 侧 move/resize 走零滞后直推，不经此节流）。 */
const EMBED_DISPATCH_THROTTLE_MS = 60;
/** 单次 PowerShell 批处理的硬超时（spawn 卡死不阻断退出流程）。 */
const POWERSHELL_TIMEOUT_MS = 5_000;
/** 退出收尾（解除全部 owned）的总预算：超时放行退出（已知限制：未解除的实例被连坐）。 */
const QUIT_TEARDOWN_BUDGET_MS = 4_000;
const GWL_HWNDPARENT = -8;

// ─── 状态 ───

let managerWindow: BrowserWindow | null = null;
/**
 * [OmniCode] 批次3 停靠重构：每实例停靠态镜像（与 console-ui.json 同源，装配时初始化、
 * UiStateSet dock 变化时经 applyOmnicodeConsoleDockStateChange 同步）。覆盖表只存显式
 * 键（Record 形态与落盘同构——解析直查属性，避免窗口 move 热路径建 Map 开销），
 * 缺省键按 dockDefault 解析（resolveOmnicodeInstanceDocked 唯一口径）。
 */
let dockDefault = true;
let dockOverrideRecord: Record<string, boolean> = {};
let dockStateInitialized = false;
/**
 * [OmniCode] B2 评审修复（P2-6）→ 批次3 语义沿用：停靠/拖出编排的过渡标志。拖出实例时
 * 先 await 解除 owned（PowerShell 批处理可达秒级），期间尾随节流 timer 的
 * dispatchEmbedLayout 仍会重下发 embedLayout 并经 ownInstances 重登记 owned——用本标志
 * 在 dispatchEmbedLayout / ownInstances 入口短路，编排落地后才恢复跟随。
 */
let dockTransitionActive = false;
/**
 * [OmniCode] B2 评审修复（P2-6）→ 批次3 语义沿用：停靠状态变化串行队列。并发双击
 * （拖出→快速收回往返）时第二个请求可能失步（旧请求未落地、镜像还是旧值）——全部
 * 编排请求排队串行执行，各自执行时以最新镜像重判，最终收敛到最后一次用户意图。
 */
let dockChangeQueue: Promise<void> = Promise.resolve();
const instanceHwndHexByProfileId = new Map<string, string>();
const ownedProfileIds = new Set<string>();
/** 内嵌中但卡片滚出视口被临时隐藏的实例（回视口时 embedLayout 自带 show）。 */
const hiddenEmbeddedProfileIds = new Set<string>();
/**
 * [OmniCode] B2 评审复审修复（N1/N2）：owned 设置/解除失败的每实例退避窗口
 * （profileId → 退避截止 epoch ms）。PowerShell 病态环境（被禁/卡死超时）下，
 * 若无退避，60ms 节流的每轮 dispatch 都会重跑注定失败的批处理（拖动期间并发
 * 数十个待超时进程），且实例反复收 embedLayout→releaseEmbed 来回跳。退避期内
 * 跳过该实例的 own 重试与 embedLayout 下发，实例稳定保持桌面态。
 */
const ownBackoffUntilByProfileId = new Map<string, number>();
const OWN_RETRY_BACKOFF_MS = 5000;
let latestClientLayout: OmnicodeConsoleEmbedLayoutInput | null = null;
let managerWindowMoveListenersAttached = false;
let dispatchTrailingTimer: NodeJS.Timeout | null = null;
let lastDispatchAt = 0;
let quitTeardownInFlight: Promise<void> | null = null;
/** 每实例当前订阅态（与桥实际下发 diff，避免重复命令）。 */
const subscribedByProfileId = new Map<string, boolean>();
let previewState: OmnicodeConsolePreviewStateInput = { previewEnabled: true, visibleProfileIds: [] };

/**
 * 镜像态 → 每实例停靠判定（resolveOmnicodeInstanceDocked 唯一口径，属性直查零分配）。
 * 导出给 instanceManager（arrange/restoreBounds 只投递未停靠实例——桥命令在实例侧会
 * 解除内嵌态，投给停靠实例会静默破坏贴合）等编排方消费。
 */
export function isOmnicodeProfileDocked(profileId: string): boolean {
  return resolveOmnicodeInstanceDocked(
    { dockDefault, dockedByProfileId: dockOverrideRecord },
    profileId,
  );
}

/** 候选列表过滤：仅保留停靠实例（undocked 实例不参与 own/布局下发）。 */
function filterDockedProfileIds(profileIds: readonly string[]): string[] {
  return profileIds.filter((profileId) => isOmnicodeProfileDocked(profileId));
}

// ─── PowerShell owned 设置/解除（一次性 spawn，全字面量参数） ───

interface WindowOwnerPair {
  /** 子窗口（实例）HWND hex（已过白名单）。 */
  child: string;
  /** 属主（管理器）HWND hex；null=解除 owned。 */
  owner: string | null;
}

/** hex → PowerShell 字面量（"0x1a2b" → Int64 转换表达式；0 → [IntPtr]::Zero）。 */
function psIntPtrLiteral(hex: string | null): string {
  if (!hex) return "[IntPtr]::Zero";
  return `[IntPtr]([Convert]::ToInt64('${hex.slice(2)}',16))`;
}

function buildSetWindowOwnerScript(pairs: readonly WindowOwnerPair[]): string {
  const source =
    "using System;using System.Runtime.InteropServices;" +
    "public static class OmniWinOwner{[DllImport(\"user32.dll\",SetLastError=true)]" +
    "public static extern IntPtr SetWindowLongPtr(IntPtr hWnd,int nIndex,IntPtr dwNewLong);}";
  const calls = pairs
    .map(
      (pair) =>
        `[OmniWinOwner]::SetWindowLongPtr(${psIntPtrLiteral(pair.child)},${GWL_HWNDPARENT},${psIntPtrLiteral(pair.owner)})|Out-Null;`,
    )
    .join("");
  return `Add-Type -TypeDefinition '${source}';${calls}`;
}

/**
 * [OmniCode] B2 评审修复（P1-3）：返回本次批处理是否成功（调用方据此决定 owned 登记）。
 * spawn 失败/超时/白名单复核不过 → false（调用方不登记、补发 releaseEmbed、下轮重试）。
 */
function runSetWindowOwner(pairs: readonly WindowOwnerPair[]): Promise<boolean> {
  if (process.platform !== "win32" || pairs.length === 0) return Promise.resolve(true);
  // 白名单复核（防御内部调用方）：全部通过才 spawn，任一非法整批放弃。
  for (const pair of pairs) {
    if (!isValidOmnicodeHwndHex(pair.child)) {
      console.warn(`[omnicode] owned 设置放弃：非法子窗口 HWND ${String(pair.child)}`);
      return Promise.resolve(false);
    }
    if (pair.owner !== null && !isValidOmnicodeHwndHex(pair.owner)) {
      console.warn("[omnicode] owned 设置放弃：非法属主 HWND");
      return Promise.resolve(false);
    }
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", buildSetWindowOwnerScript(pairs)],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (error) {
          console.warn("[omnicode] owned 设置/解除 PowerShell 失败（继续流程）:", error.message);
          resolve(false);
          return;
        }
        resolve(true);
      },
    );
  });
}

function getManagerHwndHex(): string | null {
  if (!managerWindow || managerWindow.isDestroyed()) return null;
  try {
    const handle = managerWindow.getNativeWindowHandle();
    const hex = handle.length >= 8 ? handle.readBigUInt64LE(0).toString(16) : handle.readUIntLE(0, Math.min(handle.length, 6)).toString(16);
    return hex ? `0x${hex}` : null;
  } catch {
    return null;
  }
}

// ─── 每实例停靠编排 ───

/**
 * 装配：初始化持久化停靠态（进程启动时调用一次；窗口引用此时可为 null，主窗口创建后
 * 经 setOmnicodeEmbedManagerWindow 补挂）。[OmniCode] 批次3：读档即迁移（旧全局 mode →
 * dockDefault，迁移后原子写回去掉 mode 字段）；随后把已连接且停靠的实例跟接进 owned。
 */
export async function setupOmnicodeConsoleEmbedding(): Promise<void> {
  if (dockStateInitialized) return;
  dockStateInitialized = true;
  const { state } = await loadOmnicodeConsoleUiStateMigrating();
  dockDefault = state.dockDefault !== false;
  dockOverrideRecord = { ...(state.dockedByProfileId ?? {}) };
  // 与旧 embedded 全局模式同构：装配时已连接的停靠实例直接跟接（owned + 布局下发）。
  void ownDockedConnectedInstances();
}

/** 管理器主窗口引用变化（重建/销毁）时更新；窗口失效时解除 move/resize 监听。 */
export function setOmnicodeEmbedManagerWindow(window: BrowserWindow | null): void {
  detachManagerWindowListeners();
  managerWindow = window;
  // 批次3：监听不再按全局模式挂/摘——停靠实例可能随时存在（每实例 docked），
  // move/resize 直推在无停靠实例时 owned 集为空、dispatch 早退，开销可忽略。
  if (window) attachManagerWindowListeners();
}

/** 装配期跟接：已连接且停靠的实例索取 HWND（缺则兜底命令）→ owned → 布局下发。 */
async function ownDockedConnectedInstances(): Promise<void> {
  const connected = getOmnicodeConnectedInstanceProfileIds();
  const docked = filterDockedProfileIds(connected);
  for (const profileId of docked) {
    if (!instanceHwndHexByProfileId.has(profileId)) {
      sendOmnicodeInstanceCommand(profileId, { type: "requestWindowHandle" });
    }
  }
  await ownInstances(docked);
  dispatchEmbedLayout();
}

/**
 * 停靠状态变化入口（UI 状态 set IPC 调用；持久化由调用方完成）。
 * [OmniCode] B2 评审修复（P2-6）语义沿用：请求串行排队（并发往返失步）+ 过渡标志
 * 短路尾随 dispatch；实际编排见 performDockStateChange。
 */
export function applyOmnicodeConsoleDockStateChange(next: {
  dockDefault: boolean;
  dockedByProfileId: Record<string, boolean>;
}): Promise<void> {
  const run = dockChangeQueue.then(() => performDockStateChange(next));
  // 队列上的失败不阻塞后续编排请求（编排本身不抛，防御性兜底）
  dockChangeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function performDockStateChange(next: {
  dockDefault: boolean;
  dockedByProfileId: Record<string, boolean>;
}): Promise<void> {
  // 差异候选 = 已连接 ∪ 当前 owned（owned 者必已连接；并集覆盖"已 owned 后被改判"）
  const candidates = new Set<string>([...getOmnicodeConnectedInstanceProfileIds(), ...ownedProfileIds]);
  const previous = { dockDefault, dockedByProfileId: dockOverrideRecord };
  const { toDock, toUndock } = diffOmnicodeDockState(previous, next, [...candidates]);
  if (toUndock.length > 0) {
    // 生命周期红线：拖出先解除 owned（幂等、带超时），再改镜像——解除进行中的尾随
    // dispatch 被过渡标志短路，不会把刚拖出的实例重新 own 回来。
    dockTransitionActive = true;
    try {
      await releaseEmbeddedInstances(toUndock);
    } finally {
      dockTransitionActive = false;
    }
  }
  // 编排落地后提交镜像（toDock 的 own 链以新状态为准）
  dockDefault = next.dockDefault !== false;
  dockOverrideRecord = { ...next.dockedByProfileId };
  for (const profileId of toDock) {
    if (!instanceHwndHexByProfileId.has(profileId)) {
      sendOmnicodeInstanceCommand(profileId, { type: "requestWindowHandle" });
    }
  }
  if (toDock.length > 0) {
    await ownInstances(toDock);
  }
  dispatchEmbedLayout();
}

/** 实例 hello 上报的 HWND 登记；停靠实例自动跟接（owned + 等待布局下发）。 */
export function notifyOmnicodeInstanceHello(profileId: string, hwndHex: string): void {
  try {
    assertValidProfileId(profileId);
  } catch {
    return;
  }
  if (!isValidOmnicodeHwndHex(hwndHex)) return;
  instanceHwndHexByProfileId.set(profileId, hwndHex.toLowerCase());
  if (isOmnicodeProfileDocked(profileId)) {
    void ownInstances([profileId]).then(() => dispatchEmbedLayout());
  }
}

/** 实例断开：清 HWND/owned 簿记（窗口已不存在，无需 PowerShell 解除）。 */
export function notifyOmnicodeInstanceDisconnected(profileId: string): void {
  instanceHwndHexByProfileId.delete(profileId);
  ownedProfileIds.delete(profileId);
  hiddenEmbeddedProfileIds.delete(profileId);
  subscribedByProfileId.delete(profileId);
  // [OmniCode] B2 评审修复（P1-2）：断开侧同样对账——已连集合变化后把残余期望态
  //（如断开实例的退订簿记）与桥实际态收敛。
  reconcilePreviewSubscriptions();
}

/**
 * 实例回连：停靠实例索取 HWND（hello 轮询兜底）并补 owned；预览订阅对账。
 * [OmniCode] B2 评审修复（P1-2）：连接路径末尾 reconcilePreviewSubscriptions——
 * 兑现 spec D9"连接时即时对账"（连接不再等于订阅：总开关∧视口可见才订）。
 * [OmniCode] 批次3：undocked 实例连接只对账订阅，不做 owned 编排（不受管理器联动）。
 */
export function notifyOmnicodeInstanceConnected(profileId: string): void {
  if (isOmnicodeProfileDocked(profileId)) {
    sendOmnicodeInstanceCommand(profileId, { type: "requestWindowHandle" });
    if (instanceHwndHexByProfileId.has(profileId)) {
      void ownInstances([profileId]).then(() => dispatchEmbedLayout());
    }
    // 尚无 HWND：实例 hello 上报时经 notifyOmnicodeInstanceHello 自动跟接
  }
  reconcilePreviewSubscriptions();
}

// ─── owned 登记决策（纯函数，P1-3，单测登记 engineering-test-files.json） ───

/** 本轮需要设置 owned 的实例（child=实例 HWND hex，owner=管理器 HWND hex）。 */
export interface OmnicodeOwnCandidate {
  profileId: string;
  child: string;
  owner: string;
}

/**
 * 候选过滤：非 win32 / 管理器 HWND 缺失 → 空；已登记 owned、尚无 HWND 的实例跳过。
 * 纯函数（不碰模块状态），ownInstances 组合消费。
 */
export function resolveOmnicodeOwnCandidates(input: {
  platform: string;
  managerHwndHex: string | null;
  ownedProfileIds: ReadonlySet<string>;
  hwndHexByProfileId: ReadonlyMap<string, string>;
  profileIds: readonly string[];
}): OmnicodeOwnCandidate[] {
  if (input.platform !== "win32" || !input.managerHwndHex) return [];
  const candidates: OmnicodeOwnCandidate[] = [];
  for (const profileId of input.profileIds) {
    if (input.ownedProfileIds.has(profileId)) continue;
    const child = input.hwndHexByProfileId.get(profileId);
    if (!child) continue;
    candidates.push({ profileId, child, owner: input.managerHwndHex });
  }
  return candidates;
}

export type OmnicodeOwnedRegistrationOutcome =
  | { kind: "registered"; profileIds: string[] }
  | { kind: "retry"; profileIds: string[] };

/**
 * 登记决策（P1-3 核心）：PowerShell 成功才登记 owned；失败不登记（下轮 ownInstances
 * 重试）并由调用方给每个实例补发 releaseEmbed（保持桌面态+任务栏可见，窗口不失踪）。
 */
export function resolveOmnicodeOwnedRegistrationOutcome(
  profileIds: readonly string[],
  setOwnerSucceeded: boolean,
): OmnicodeOwnedRegistrationOutcome {
  const list = [...profileIds];
  return setOwnerSucceeded
    ? { kind: "registered", profileIds: list }
    : { kind: "retry", profileIds: list };
}

/**
 * [OmniCode] B2 评审复审修复（N1）：退避过滤决策（纯函数，供单测）。返回仍可尝试
 * own 的实例与仍在退避期内的实例。now 由调用方传入（测试可注入时钟）。
 */
export function resolveOmnicodeOwnBackoffFilter(
  profileIds: readonly string[],
  ownBackoffUntilByProfileId: ReadonlyMap<string, number>,
  now: number,
): { eligible: string[]; backedOff: string[] } {
  const eligible: string[] = [];
  const backedOff: string[] = [];
  for (const profileId of profileIds) {
    const until = ownBackoffUntilByProfileId.get(profileId);
    if (until !== undefined && until > now) backedOff.push(profileId);
    else eligible.push(profileId);
  }
  return { eligible, backedOff };
}

function recordOwnBackoff(profileIds: readonly string[], now: number): void {
  for (const profileId of profileIds) {
    ownBackoffUntilByProfileId.set(profileId, now + OWN_RETRY_BACKOFF_MS);
  }
}

function clearOwnBackoff(profileIds: readonly string[]): void {
  for (const profileId of profileIds) ownBackoffUntilByProfileId.delete(profileId);
}

async function ownInstances(profileIds: readonly string[]): Promise<void> {
  if (dockTransitionActive || process.platform !== "win32") return;
  const managerHex = getManagerHwndHex();
  if (!managerHex) {
    console.warn("[omnicode] 内嵌 owned 设置跳过：管理器窗口 HWND 不可用");
    return;
  }
  // [OmniCode] 批次3：候选先过停靠过滤（undocked 实例不参与 own；调用方已过滤时为空转）。
  const { eligible } = resolveOmnicodeOwnBackoffFilter(
    filterDockedProfileIds(profileIds),
    ownBackoffUntilByProfileId,
    Date.now(),
  );
  const pending = resolveOmnicodeOwnCandidates({
    platform: process.platform,
    managerHwndHex: managerHex,
    ownedProfileIds,
    hwndHexByProfileId: instanceHwndHexByProfileId,
    profileIds: eligible,
  });
  if (pending.length === 0) return;
  // [OmniCode] B2 评审修复（P1-3）：登记移到 PowerShell 成功之后——乐观登记会让
  // 失败的实例永远留在 ownedProfileIds（不重试 → 实例窗口留在桌面，"失踪"于网格）。
  const setOwnerSucceeded = await runSetWindowOwner(
    pending.map((candidate) => ({ child: candidate.child, owner: candidate.owner })),
  );
  const outcome = resolveOmnicodeOwnedRegistrationOutcome(
    pending.map((candidate) => candidate.profileId),
    setOwnerSucceeded,
  );
  if (outcome.kind === "registered") {
    for (const profileId of outcome.profileIds) ownedProfileIds.add(profileId);
    clearOwnBackoff(outcome.profileIds);
    return;
  }
  // 失败：不登记 + 给实例补发 releaseEmbed（实例侧可能已收到 embedLayout 进入内嵌
  // 约束 skipTaskbar/冻结尺寸，补发保持桌面态 + 任务栏可见，窗口不"失踪"）；
  // 并记退避（N1）——退避期内不再向该实例下发 embedLayout/own 重试。
  console.warn(
    `[omnicode] owned 设置失败，本轮不登记并补发 releaseEmbed（${OWN_RETRY_BACKOFF_MS}ms 后重试）: ${outcome.profileIds.join(",")}`,
  );
  recordOwnBackoff(outcome.profileIds, Date.now());
  for (const profileId of outcome.profileIds) {
    sendOmnicodeInstanceCommand(profileId, { type: "releaseEmbed" });
  }
}

/** 内嵌跟随：renderer 上报卡片画面区客户区矩形（CSS px），换算屏幕 DIP 后下发（布局变化走节流档）。 */
export function applyOmnicodeConsoleEmbedLayout(input: OmnicodeConsoleEmbedLayoutInput): void {
  latestClientLayout = input;
  scheduleDispatch(false);
}

let onManagerWindowMoved: (() => void) | null = null;

function attachManagerWindowListeners(): void {
  if (!managerWindow || managerWindowMoveListenersAttached) return;
  managerWindowMoveListenersAttached = true;
  // [OmniCode] 批次3 停靠重构（B 套件 b 零滞后跟随）：窗口 move/resize 不再走 60ms
  // 节流档——管理器窗口位移期间 renderer 不重布局、上报矩形不变，main 直接用缓存
  // 相对矩形（latestClientLayout）+ 当前 contentBounds 换算直推（跳过 renderer 60ms
  // hop），每事件同步 dispatch（Electron move/resize 至多帧率级触发，回环 WS +
  // SetWindowPos 可承载）。renderer 上报仅服务布局变化（滚动/卡片尺寸/增删）。
  onManagerWindowMoved = () => dispatchEmbedLayout();
  managerWindow.on("move", onManagerWindowMoved);
  managerWindow.on("resize", onManagerWindowMoved);
}

function detachManagerWindowListeners(): void {
  if (managerWindow && onManagerWindowMoved) {
    managerWindow.removeListener("move", onManagerWindowMoved);
    managerWindow.removeListener("resize", onManagerWindowMoved);
  }
  onManagerWindowMoved = null;
  managerWindowMoveListenersAttached = false;
}

/** 节流调度（renderer 上报档）：立即档（60ms 内至多一次）+ 尾随兜底（最后一次位移不丢）。 */
function scheduleDispatch(fromWindowEvent: boolean): void {
  const now = Date.now();
  const elapsed = now - lastDispatchAt;
  if (elapsed >= EMBED_DISPATCH_THROTTLE_MS) {
    lastDispatchAt = now;
    dispatchEmbedLayout();
    return;
  }
  if (dispatchTrailingTimer) return;
  dispatchTrailingTimer = setTimeout(
    () => {
      dispatchTrailingTimer = null;
      lastDispatchAt = Date.now();
      dispatchEmbedLayout();
    },
    fromWindowEvent ? EMBED_DISPATCH_THROTTLE_MS - elapsed : 0,
  );
  dispatchTrailingTimer.unref?.();
}

/**
 * [OmniCode] 批次3 停靠重构：本轮 CSS→DIP 纵向换算比例（renderer resize 手柄数学的
 * 下限钳制依据）。取最近一次上报布局 + 当前 contentBounds；不可得时返回 null（renderer
 * 按 1 兜底）。
 */
export function getOmnicodeConsoleEmbedScale(): number | null {
  const layout = latestClientLayout;
  if (!managerWindow || managerWindow.isDestroyed() || !layout || layout.viewportHeight <= 0) {
    return null;
  }
  const content = managerWindow.getContentBounds();
  if (content.height <= 0) return null;
  const scale = content.height / layout.viewportHeight;
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

function dispatchEmbedLayout(): void {
  // P2-6：停靠/拖出编排过渡期（解除 owned 进行中）不重下发 embedLayout/重登记 owned
  if (dockTransitionActive || !managerWindow || managerWindow.isDestroyed()) {
    return;
  }
  const layout = latestClientLayout;
  if (!layout || !Array.isArray(layout.rects)) return;
  // 批次3：无停靠实例（owned 集 + 候选均空）时早退——undocked-only 世界里 move/resize
  // 直推路径的每事件开销收敛为一次矩形换算前检查。
  if (ownedProfileIds.size === 0) return;
  const content = managerWindow.getContentBounds();
  const basis = {
    contentX: content.x,
    contentY: content.y,
    contentWidth: content.width,
    contentHeight: content.height,
    viewportWidth: layout.viewportWidth,
    viewportHeight: layout.viewportHeight,
  };
  const screenRects: { profileId: string; x: number; y: number; width: number; height: number }[] = [];
  for (const rect of layout.rects) {
    if (!rect || typeof rect !== "object") continue;
    try {
      assertValidProfileId(rect.profileId);
    } catch {
      continue;
    }
    if (!isOmnicodeProfileDocked(rect.profileId)) continue;
    const screen = convertOmnicodeClientRectToScreen(basis, rect);
    if (!screen) continue;
    // [OmniCode] 批次3（B 套件 c）：低于内嵌最低规格的矩形钳制到下限（resize 手柄
    // 场景 scale 镜像滞后/损坏时的防御；正常路径 renderer 已按 scale 钳制）——
    // 保持窗口与卡片可换算一致，而非丢弃矩形让窗口停留旧位置。
    const clamped = clampOmnicodeScreenRectToEmbedMinimum(screen);
    if (!isOmnicodeEmbedRectUsable({ profileId: rect.profileId, ...clamped })) continue;
    // [OmniCode] 批次3 终审修复（P1-2）：下发矩形四边内缩 6px——实例窗口只盖画面区
    // 内区，卡片四边 resize 手柄 DOM（6px 命中带）露出在窗口外沿可命中（此前窗口
    // 精确盖满画面区，owned 窗口恒在 DOM 之上，手柄 pointerdown 全部落到实例窗口，
    // 拖拽调高整个功能失效）。内缩只改实例窗口 setBounds，卡片画面区尺寸不变；
    // 内缩后可能低于内嵌最低规格（下限矩形 -12px），再钳一次保证实例侧独立校验必过
    //（实例侧 clamp/校验逻辑原样不动）。
    const insetRect = insetOmnicodeEmbedRectForResizeHandles(clamped);
    const finalRect = clampOmnicodeScreenRectToEmbedMinimum(insetRect);
    if (!isOmnicodeEmbedRectUsable({ profileId: rect.profileId, ...finalRect })) continue;
    screenRects.push({ profileId: rect.profileId, ...finalRect });
  }
  // 视口外的内嵌实例临时隐藏（owned 窗口无裁剪，悬在管理器外会遮挡桌面）
  const inLayout = new Set(screenRects.map((rect) => rect.profileId));
  for (const profileId of ownedProfileIds) {
    if (!inLayout.has(profileId) && !hiddenEmbeddedProfileIds.has(profileId)) {
      if (sendOmnicodeInstanceCommand(profileId, { type: "hide" })) {
        hiddenEmbeddedProfileIds.add(profileId);
      }
    } else if (inLayout.has(profileId) && hiddenEmbeddedProfileIds.has(profileId)) {
      hiddenEmbeddedProfileIds.delete(profileId); // embedLayout 处理含 show
    }
  }
  if (screenRects.length === 0) return;
  // [OmniCode] B2 评审复审修复（N1）：退避期内的实例不下发 embedLayout——own 失败
  // 刚补发过 releaseEmbed（桌面态），立刻再发 embedLayout 会让窗口在两种约束间跳动。
  const { backedOff } = resolveOmnicodeOwnBackoffFilter(
    [...inLayout],
    ownBackoffUntilByProfileId,
    Date.now(),
  );
  const backedOffSet = new Set(backedOff);
  for (const profileId of inLayout) {
    if (backedOffSet.has(profileId)) continue;
    sendOmnicodeInstanceCommand(profileId, { type: "embedLayout", rects: screenRects });
  }
  // 新进矩形但尚未 owned 的实例（如刚回连）补 owned（下次布局起生效）
  void ownInstances([...inLayout]);
}

/**
 * 解除内嵌（全部或指定实例）：PowerShell GWL_HWNDPARENT=0（批处理）+ releaseEmbed
 * 桥命令（实例恢复任务栏/桌面约束并回基线=拖出语义）。幂等；每次 PowerShell 批处理
 * ≤5s。仅 owned（≡ 停靠）实例受影响；undocked 实例不在 targets 时为 no-op。
 */
export async function releaseEmbeddedInstances(profileIds?: readonly string[]): Promise<void> {
  const targets = profileIds
    ? profileIds.filter((id) => ownedProfileIds.has(id))
    : [...ownedProfileIds];
  if (targets.length === 0) return;
  const pairs: WindowOwnerPair[] = [];
  for (const profileId of targets) {
    const hwndHex = instanceHwndHexByProfileId.get(profileId);
    if (hwndHex) pairs.push({ child: hwndHex, owner: null });
    // [OmniCode] N2 决策：簿记仍提前删（而非"PowerShell 成功后才删"）。理由：解除
    // 批处理的失败可能是假阴性（超时但部分/全部已解除）——提前删后，若残留 owned
    // 关系，下次进入停靠（dock）时 ownInstances 会幂等重设自愈；反之"成功后才删"在
    // 假阴性下簿记永久残留 owned → 后续 dispatch 跳过该实例的 own → 窗口不跟随
    // 且无自愈路径。病态重试由退避（N1）统一抑制，见下方失败分支。
    ownedProfileIds.delete(profileId);
    hiddenEmbeddedProfileIds.delete(profileId);
    sendOmnicodeInstanceCommand(profileId, { type: "releaseEmbed" });
  }
  const released = await runSetWindowOwner(pairs);
  if (released) {
    clearOwnBackoff(targets);
  } else {
    // [OmniCode] N2（配 N1 退避）：解除失败同样记退避——PowerShell 病态环境下避免
    // 立即重试再撞同一堵墙（收回停靠的第一轮 own 重试会被退避挡住 5s）。
    recordOwnBackoff(targets, Date.now());
  }
}

/**
 * 退出收尾队列（生命周期红线）：管理器 close/before-quit 屏障内 await——先于窗口销毁
 * 解除全部 owned。幂等 + 总预算 4s（PowerShell 卡死时放行退出，残余 owned 实例被连坐
 * 销毁为已知限制）。[OmniCode] 批次3 停靠重构：owned 登记 ≡ 停靠实例（undocked 实例
 * 无 owned 关系、不受管理器退出收尾影响），故本函数天然只处理 docked、模式无关。
 * 窗口未销毁前实例已恢复任务栏与桌面位置，即使强杀也独立存活。
 */
export function releaseOmnicodeEmbedForQuit(): Promise<void> {
  if (!quitTeardownInFlight) {
    quitTeardownInFlight = (async () => {
      detachManagerWindowListeners();
      await withTimeout(releaseEmbeddedInstances(), QUIT_TEARDOWN_BUDGET_MS);
    })().finally(() => {
      quitTeardownInFlight = null;
    });
  }
  return quitTeardownInFlight;
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ─── 实时预览订阅对账（T1） ───

/** renderer 上报预览状态（总开关 + 视口内卡片集合）；对已连接实例即时增减订阅。 */
export function applyOmnicodePreviewState(input: OmnicodeConsolePreviewStateInput): void {
  previewState = {
    previewEnabled: Boolean(input?.previewEnabled),
    visibleProfileIds: Array.isArray(input?.visibleProfileIds) ? [...input.visibleProfileIds] : [],
  };
  reconcilePreviewSubscriptions();
}

/**
 * 仅更新预览总开关（UI 状态 set IPC 路径）：保留 renderer 最近上报的可见集合——
 * 从 UiStateSet 改开关时不该把可见集合清零（否则要等 renderer 下一拍上报才恢复订阅）。
 */
export function applyOmnicodePreviewEnabled(previewEnabled: boolean): void {
  previewState = { ...previewState, previewEnabled: Boolean(previewEnabled) };
  reconcilePreviewSubscriptions();
}

/** 实例连接时的对账入口（managerHooks.onInstanceConnected → desktopProfileIpc）。 */
export function reconcilePreviewSubscriptions(): void {
  const desired = resolveOmnicodePreviewSubscriptions({
    previewEnabled: previewState.previewEnabled,
    visibleProfileIds: previewState.visibleProfileIds,
    connectedProfileIds: getOmnicodeConnectedInstanceProfileIds(),
  });
  for (const [profileId, wantSubscribed] of desired) {
    if (subscribedByProfileId.get(profileId) === wantSubscribed) continue;
    setOmnicodeInstanceThumbnailSubscription(profileId, wantSubscribed);
    subscribedByProfileId.set(profileId, wantSubscribed);
  }
}

/** 当前持久化状态读写透传（desktopProfileIpc 使用）。 */
export { readOmnicodeConsoleUiState, writeOmnicodeConsoleUiState };

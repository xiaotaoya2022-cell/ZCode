// [OmniCode] 批次2 B2-3：管理器内嵌编排（owned-window 方案，spec §批次2 D9）。
//
// 生命周期红线（Win32：owned window 随 owner 销毁——管理器窗口销毁会连带杀死内嵌实例）：
// - 管理器窗口 close/before-quit → prepareAppQuit 屏障内 await releaseOmnicodeEmbedForQuit()
//   （幂等 + 超时上限）；切桌面模式同样先解除。
// - 管理器崩溃/被强杀无法收尾 → 内嵌实例被连坐销毁，记录为已知限制（spec D9）。
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
} from "@zcode/shared";
import { assertValidProfileId } from "./profileRuntime.js";
import {
  sendOmnicodeInstanceCommand,
  setOmnicodeInstanceThumbnailSubscription,
  getOmnicodeConnectedInstanceProfileIds,
} from "./instanceBridgeServer.js";
import {
  convertOmnicodeClientRectToScreen,
  isOmnicodeEmbedRectUsable,
  isValidOmnicodeHwndHex,
} from "./embedLayoutMath.js";
import {
  readOmnicodeConsoleUiState,
  writeOmnicodeConsoleUiState,
  resolveOmnicodePreviewSubscriptions,
  type OmnicodeConsoleMode,
} from "./consoleUiState.js";

/** 跟随下发的最小间隔（renderer rAF+60ms 节流之上，main 侧 move/resize 再兜一层）。 */
const EMBED_DISPATCH_THROTTLE_MS = 60;
/** 单次 PowerShell 批处理的硬超时（spawn 卡死不阻断退出流程）。 */
const POWERSHELL_TIMEOUT_MS = 5_000;
/** 退出收尾（解除全部 owned）的总预算：超时放行退出（已知限制：未解除的实例被连坐）。 */
const QUIT_TEARDOWN_BUDGET_MS = 4_000;
const GWL_HWNDPARENT = -8;

// ─── 状态 ───

let managerWindow: BrowserWindow | null = null;
let embedMode: OmnicodeConsoleMode = "embedded"; // 与 consoleUiState 同源，装配时初始化
let embedModeInitialized = false;
/**
 * [OmniCode] B2 评审修复（P2-6）：模式切换过渡标志。切桌面时先 await 解除全部 owned
 * （PowerShell 批处理可达秒级），期间尾随节流 timer 的 dispatchEmbedLayout 仍会以
 * embedded 态重下发 embedLayout 并经 ownInstances 重登记 owned——用本标志在
 * dispatchEmbedLayout / ownInstances 入口短路，切换落地后才恢复跟随。
 */
let switchingMode = false;
/**
 * [OmniCode] B2 评审修复（P2-6）：模式切换串行队列。并发双击（desktop→embedded 快速
 * 往返）时第二个请求在 `embedMode === mode` 早退检查处失步（旧请求未落地、embedMode
 * 还是旧值）——全部切换请求排队串行执行，各自执行时以最新 embedMode 重判，最终收敛
 * 到最后一次用户意图。
 */
let modeChangeQueue: Promise<void> = Promise.resolve();
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

// ─── 内嵌模式编排 ───

/**
 * 装配：初始化持久化模式（进程启动时调用一次；窗口引用此时可为 null，主窗口创建后
 * 经 setOmnicodeEmbedManagerWindow 补挂）。持久化模式为内嵌时立即进入内嵌态。
 */
export async function setupOmnicodeConsoleEmbedding(): Promise<void> {
  if (embedModeInitialized) return;
  embedModeInitialized = true;
  embedMode = (await readOmnicodeConsoleUiState()).mode;
  if (embedMode === "embedded") {
    setEmbedModeInternal("embedded");
  }
}

/** 管理器主窗口引用变化（重建/销毁）时更新；窗口失效时解除 move/resize 监听。 */
export function setOmnicodeEmbedManagerWindow(window: BrowserWindow | null): void {
  detachManagerWindowListeners();
  managerWindow = window;
  if (window && embedMode === "embedded") attachManagerWindowListeners();
}

function setEmbedModeInternal(mode: OmnicodeConsoleMode): void {
  embedMode = mode;
  if (mode === "embedded") {
    attachManagerWindowListeners();
    void ownAllConnectedInstances();
  } else {
    detachManagerWindowListeners();
    void releaseEmbeddedInstances();
  }
}

/**
 * 模式切换入口（UI 状态 set IPC 调用；持久化由调用方完成）。
 * [OmniCode] B2 评审修复（P2-6）：请求串行排队（并发双击失步）+ 过渡标志短路尾随
 * dispatch（详见 switchingMode 注释）；实际编排见 performModeChange。
 */
export function applyOmnicodeConsoleModeChange(mode: OmnicodeConsoleMode): Promise<void> {
  const run = modeChangeQueue.then(() => performModeChange(mode));
  // 队列上的失败不阻塞后续切换请求（编排本身不抛，防御性兜底）
  modeChangeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function performModeChange(mode: OmnicodeConsoleMode): Promise<void> {
  if (embedMode === mode) return;
  switchingMode = true;
  try {
    if (mode === "desktop") {
      // 生命周期红线：切桌面模式先解除全部 owned（幂等、带超时），再改状态。
      await releaseEmbeddedInstances();
    }
  } finally {
    // 先置回再 setEmbedModeInternal：进入内嵌的 own 链不被过渡标志短路
    switchingMode = false;
  }
  setEmbedModeInternal(mode);
}

/** 实例 hello 上报的 HWND 登记；内嵌态下自动跟接（owned + 等待布局下发）。 */
export function notifyOmnicodeInstanceHello(profileId: string, hwndHex: string): void {
  try {
    assertValidProfileId(profileId);
  } catch {
    return;
  }
  if (!isValidOmnicodeHwndHex(hwndHex)) return;
  instanceHwndHexByProfileId.set(profileId, hwndHex.toLowerCase());
  if (embedMode === "embedded") {
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
 * 实例回连：内嵌态下索取 HWND（hello 轮询兜底）并补 owned；预览订阅对账。
 * [OmniCode] B2 评审修复（P1-2）：连接路径末尾 reconcilePreviewSubscriptions——
 * 兑现 spec D9"连接时即时对账"（连接不再等于订阅：总开关∧视口可见才订）。
 */
export function notifyOmnicodeInstanceConnected(profileId: string): void {
  if (embedMode === "embedded") {
    sendOmnicodeInstanceCommand(profileId, { type: "requestWindowHandle" });
    if (instanceHwndHexByProfileId.has(profileId)) {
      void ownInstances([profileId]).then(() => dispatchEmbedLayout());
    }
    // 尚无 HWND：实例 hello 上报时经 notifyOmnicodeInstanceHello 自动跟接
  }
  reconcilePreviewSubscriptions();
}

async function ownAllConnectedInstances(): Promise<void> {
  const connected = getOmnicodeConnectedInstanceProfileIds();
  // 没有 HWND 的先索取 hello（实例 1s 轮询兜底重发）
  for (const profileId of connected) {
    if (!instanceHwndHexByProfileId.has(profileId)) {
      sendOmnicodeInstanceCommand(profileId, { type: "requestWindowHandle" });
    }
  }
  await ownInstances(connected);
  dispatchEmbedLayout();
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
  if (embedMode !== "embedded" || switchingMode || process.platform !== "win32") return;
  const managerHex = getManagerHwndHex();
  if (!managerHex) {
    console.warn("[omnicode] 内嵌 owned 设置跳过：管理器窗口 HWND 不可用");
    return;
  }
  // [OmniCode] B2 评审复审修复（N1）：退避期内的实例跳过 own 重试（PowerShell 病态
  // 环境下避免每轮 60ms 节流重跑注定失败的批处理——进程放大 + 窗口来回跳）。
  const { eligible } = resolveOmnicodeOwnBackoffFilter(
    profileIds,
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

/** 内嵌跟随：renderer 上报卡片画面区客户区矩形（CSS px），换算屏幕 DIP 后下发。 */
export function applyOmnicodeConsoleEmbedLayout(input: OmnicodeConsoleEmbedLayoutInput): void {
  latestClientLayout = input;
  if (embedMode !== "embedded") return;
  scheduleDispatch(false);
}

let onManagerWindowMoved: (() => void) | null = null;

function attachManagerWindowListeners(): void {
  if (!managerWindow || managerWindowMoveListenersAttached) return;
  managerWindowMoveListenersAttached = true;
  onManagerWindowMoved = () => scheduleDispatch(true);
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

/** 节流调度：立即档（60ms 内至多一次）+ 尾随兜底（窗口拖动中的最后一次位移不丢）。 */
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

function dispatchEmbedLayout(): void {
  // P2-6：模式切换过渡期（解除 owned 进行中）不重下发 embedLayout/重登记 owned
  if (embedMode !== "embedded" || switchingMode || !managerWindow || managerWindow.isDestroyed()) {
    return;
  }
  const layout = latestClientLayout;
  if (!layout || !Array.isArray(layout.rects)) return;
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
    const screen = convertOmnicodeClientRectToScreen(basis, rect);
    if (!screen || !isOmnicodeEmbedRectUsable({ profileId: rect.profileId, ...screen })) continue;
    screenRects.push({ profileId: rect.profileId, ...screen });
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
 * 桥命令（实例恢复任务栏/桌面约束并回基线）。幂等；每次 PowerShell 批处理 ≤5s。
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
    // 关系，下次进入 embedded 时 ownInstances 会幂等重设自愈；反之"成功后才删"在
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
    // [OmniCode] N2（配 N1 退避）：解除失败同样记退避——PowerShell 病态环境下，切到
    // 桌面模式后 dispatch 已不再跑（embedMode=desktop），但切回 embedded 的第一轮
    // own 重试也会被退避挡住 5s，避免立即再撞同一堵墙。
    recordOwnBackoff(targets, Date.now());
  }
}

/**
 * 退出收尾队列（生命周期红线）：管理器 close/before-quit 屏障内 await——先于窗口销毁
 * 解除全部 owned。幂等 + 总预算 4s（PowerShell 卡死时放行退出，残余 owned 实例被连坐
 * 销毁为已知限制）。窗口未销毁前实例已恢复任务栏与桌面位置，即使强杀也独立存活。
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

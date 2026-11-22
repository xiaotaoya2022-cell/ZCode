// [OmniCode] 实例侧桥接客户端：回连控制台，接受窗口命令并按需上报缩略图帧。
// 仅 Profile 实例身份启动时激活（OMNICODE_PROFILE_ID + OMNICODE_BRIDGE_* 由
// profileBootstrap 从 spawn env 注入并自派生双保险，批次1 D6 后不再经 handoff 文件）。
// [OmniCode] 后台降载：窗口不可见（停靠 hide/最小化）→ 停帧档（不再调用 capturePage，
// 帧生产归零；v0 时代"隐藏窗口仍每 tick 调 capturePage"的开销消除）；可见但失焦 →
// 降帧档（capture 间隔 700ms→2000ms）。Electron 底座对隐藏/遮挡窗口已有 Chromium
// 原生节流（rAF 停 + timer 1Hz），但本 capture 循环是自家帧生产驱动器，底座管不到；
// setFrameRate 仅 offscreen 渲染生效（屏幕窗口不可用），降帧只能自控生产频率。
// 停帧只停渲染帧与截屏：WS 连接 / hello 心跳 / agent 会话 / 网络活动全部照常。
// [OmniCode] 批次2 B2-3（T1/T2）：缩略图帧附内容区 {w,h}（卡片 letterbox）；hello 上报
// 主窗口 HWND（管理器 owned-window 内嵌用）；embedLayout/releaseEmbed 内嵌布局命令
//（校验/解除最大化/最低尺寸放宽 + skipTaskbar + 桌面基线保存，spec §批次2 D9）。
import WebSocket from "ws";
import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { PlatformChannels } from "@zcode/shared";
import process from "node:process";
import {
  findOmnicodeEmbedRectForProfile,
  formatOmnicodeNativeHandleHex,
  OMNICODE_EMBED_MIN_WIDTH,
  OMNICODE_EMBED_MIN_HEIGHT,
  type OmnicodeEmbedRectInput,
} from "./embedLayoutMath.js";
import { MIN_DESKTOP_WINDOW_WIDTH, MIN_DESKTOP_WINDOW_HEIGHT } from "../desktopWindowSize.js";
import { handleOmnicodeGlobalPrefsApplyCommand } from "./globalPrefs.js";
import { handleOmnicodeTakeoverDownlink, clearOmnicodeTakeoverInstanceState } from "./takeoverInstance.js";
// [OmniCode] 丙1 远程聚合 R3（spec: docs/omnicode/remote-aggregation.md §4/§5/§8-R3）：
// 被聚合实例侧执行器——目录查询应答 + 快照变化上行报告（事件驱动零轮询；实例零 relay）。
import {
  handleOmnicodeRemoteHostAnnounce,
  handleOmnicodeRemoteWorkspaceListRequest,
  notifyOmnicodeRemoteWorkspaceSnapshotChanged,
} from "./remoteForwardInstance.js";

export const CAPTURE_INTERVAL_MS = 700; // ≈1.4fps；JPEG q55 单帧约 40-80KB，本地回环无压力
/** [OmniCode] 后台降载·降帧档：可见但失焦（非活动）时的 capture 间隔（≈0.5fps）。 */
export const CAPTURE_INTERVAL_INACTIVE_MS = 2000;
const RECONNECT_DELAY_MS = 3000;
const HELLO_POLL_INTERVAL_MS = 1000;

let reconnectTimer: NodeJS.Timeout | null = null;
let captureTimer: NodeJS.Timeout | null = null;
let helloTimer: NodeJS.Timeout | null = null;
let thumbnailSubscribed = false;
let captureInFlight = false;
/** 最近一次成功发出缩略图帧的时刻（降帧档频率闸门）。 */
let lastSentFrameAt = 0;
/** 已向管理器广播的停帧态（只在翻转时广播一次；断连复位由重连后重新上报收敛）。 */
let lastNotifiedPaused = false;
/** 最近一次已上报的 HWND（变化时重发 hello——窗口销毁重建后句柄会变）。 */
let lastReportedHwndHex: string | null = null;
/** 内嵌中标记：embedLayout 成功后置位，releaseEmbed/编排冲突时复位。 */
let embedActive = false;
/** [OmniCode] 批次4：当前回连 socket（全局偏好上行上报通道；断开置空）。 */
let activeReportSocket: WebSocket | null = null;
// [OmniCode] 批次4 单点下沉：共享资产取回的在途请求表（requestId → pending）。
const pendingSharedAssetRequests = new Map<
  string,
  { resolve: (result: OmnicodeSharedAssetFetchReply) => void; timer: NodeJS.Timeout }
>();
/** 共享资产取回应答载荷（ok=false 时实例 Host 回退直连）。 */
export type OmnicodeSharedAssetFetchReply = {
  ok: boolean;
  dataBase64?: string;
  error?: string;
};
/** 共享资产取回总预算：管理器自身下载超时 30s + 回环两跳开销（spec §G3.3）。 */
export const SHARED_ASSET_FETCH_TIMEOUT_MS = 40_000;
// [OmniCode] 模式二 R2（spec: docs/omnicode/multi-account-sessions.md §5）：附加账号材料
// 桥取回的在途请求表与总预算。管理器侧只做本地盘解密（无网络下载），预算远低于共享
// 资产；ok=false 时实例 Host 按"目录未命中"回落 local 来源提供者。
const pendingAccountMaterialRequests = new Map<
  string,
  { resolve: (result: OmnicodeAccountMaterialFetchReply) => void; timer: NodeJS.Timeout }
>();
/** 附加账号材料取回应答载荷（ok=false 时实例 Host 回落 local 文件提供者）。 */
export type OmnicodeAccountMaterialFetchReply = {
  ok: boolean;
  dataBase64?: string;
  error?: string;
};
/** 附加账号材料取回总预算：管理器本地解密链（bounded 读 + 逐字段解密）+ 回环两跳。 */
export const OMNICODE_ACCOUNT_MATERIAL_FETCH_TIMEOUT_MS = 15_000;

function getPrimaryInstanceWindow(): BrowserWindow | undefined {
  // 实例是单主窗口应用（primaryWindowCoordinator 单飞）
  return BrowserWindow.getAllWindows()[0];
}

function getProfileId(): string {
  return process.env.OMNICODE_PROFILE_ID?.trim() ?? "";
}

/** [OmniCode] M2 v1 平铺编排的还原基线：最近一次收到 arrange 时的窗口 bounds（spec §实时视窗）。 */
let lastBoundsBeforeArrange: Electron.Rectangle | null = null;
/** [OmniCode] 批次2 B2-3：内嵌前的桌面基线 bounds（restoreBounds 同形语义，解除内嵌回位）。 */
let lastBoundsBeforeEmbed: Electron.Rectangle | null = null;

/**
 * 校验父进程下发的 arrange 目标矩形：有限非负整数且 width≥200 / height≥150。
 * 来源白名单是父进程 workArea 计算，但实例侧仍独立把关（spec 安全边界）。
 */
function isOmnicodeArrangeBounds(value: unknown): value is Electron.Rectangle {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Partial<Electron.Rectangle>;
  const { x, y, width, height } = bounds;
  const isNonNegativeInt = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0;
  return (
    isNonNegativeInt(x) &&
    isNonNegativeInt(y) &&
    isNonNegativeInt(width) &&
    isNonNegativeInt(height) &&
    width >= 200 &&
    height >= 150
  );
}

/**
 * [OmniCode] 批次2 B2-3：上报主窗口 HWND（hex）。管理器用它做跨进程 owned 设置
 * （SetWindowLongPtr GWL_HWNDPARENT）。窗口尚未创建时跳过，由 hello 轮询补发。
 */
function sendInstanceHello(ws: WebSocket): void {
  if (ws.readyState !== 1) return;
  const win = getPrimaryInstanceWindow();
  if (!win || win.isDestroyed()) return;
  let hwndHex: string | null = null;
  try {
    hwndHex = formatOmnicodeNativeHandleHex(win.getNativeWindowHandle());
  } catch {
    hwndHex = null;
  }
  if (!hwndHex || hwndHex === lastReportedHwndHex) return;
  lastReportedHwndHex = hwndHex;
  ws.send(JSON.stringify({ type: "hello", hwndHex }));
}

function startHelloLoop(ws: WebSocket): void {
  stopHelloLoop();
  // 窗口句柄在窗口创建后才存在，且销毁重建会变：轮询比对、变化即上报（unref 不阻退出）。
  helloTimer = setInterval(() => sendInstanceHello(ws), HELLO_POLL_INTERVAL_MS);
  helloTimer.unref?.();
  sendInstanceHello(ws);
}

function stopHelloLoop(): void {
  if (helloTimer) {
    clearInterval(helloTimer);
    helloTimer = null;
  }
}

/** 恢复桌面窗口约束（退出内嵌时）：可拖拽缩放 + 常规最低尺寸 + 任务栏可见。 */
function restoreDesktopWindowConstraints(win: BrowserWindow): void {
  win.setResizable(true);
  win.setMinimumSize(MIN_DESKTOP_WINDOW_WIDTH, MIN_DESKTOP_WINDOW_HEIGHT);
  win.setSkipTaskbar(false);
}

/**
 * [OmniCode] 批次2 B2-3：内嵌布局命令。管理器下发全量 rects（客户区换算后的屏幕 DIP），
 * 实例滤出自己的矩形并独立校验（embedLayoutMath，spec 安全边界），通过后：
 * 解除最小化/最大化 → 冻结可缩放与最低尺寸（480×640 的桌面下限会顶住小格子）→
 * skipTaskbar(true) → 保存桌面基线（首次）→ setBounds。窗口被管理器临时隐藏
 *（卡片滚出视口）时重新 show。
 */
function applyEmbedLayout(win: BrowserWindow, rects: unknown): void {
  const own = findOmnicodeEmbedRectForProfile(
    Array.isArray(rects) ? (rects as OmnicodeEmbedRectInput[]) : undefined,
    getProfileId(),
  );
  if (!own) return;
  if (win.isMinimized()) win.restore();
  if (win.isMaximized()) win.unmaximize();
  if (!embedActive) {
    embedActive = true;
    lastBoundsBeforeEmbed = win.getBounds();
    win.setResizable(false);
    win.setMinimumSize(OMNICODE_EMBED_MIN_WIDTH, OMNICODE_EMBED_MIN_HEIGHT);
    win.setSkipTaskbar(true);
  }
  win.setBounds({ x: own.x, y: own.y, width: own.width, height: own.height });
  if (!win.isVisible()) win.show();
}

/** 解除内嵌：恢复桌面约束并回到内嵌前基线（幂等；未内嵌时仅恢复约束）。 */
function releaseEmbed(win: BrowserWindow): void {
  if (embedActive) {
    embedActive = false;
    if (win.isMinimized()) win.restore();
    if (win.isMaximized()) win.unmaximize();
    restoreDesktopWindowConstraints(win);
    if (lastBoundsBeforeEmbed) {
      win.setBounds(lastBoundsBeforeEmbed);
      lastBoundsBeforeEmbed = null;
    }
    win.show();
    return;
  }
  restoreDesktopWindowConstraints(win);
}

function applyCommand(command: { type?: string; bounds?: unknown; path?: unknown; rects?: unknown; prefs?: unknown; sourceInstanceId?: unknown; title?: unknown; assetRequestId?: unknown; assetResult?: unknown; accountRequestId?: unknown; accountResult?: unknown }): void {
  // [OmniCode] D12 接管流：takeoverRequest（转投持有者）/ takeoverResult（回执通知
  // 观察者）不依赖窗口存在性判断的其余分支——转发前自行校验（shared schema）+ 惰性取
  // 主窗口（渲染层未就绪的确认请求由管理器死线按 timeout 收口）。
  if (command.type === "takeoverRequest" || command.type === "takeoverResult") {
    handleOmnicodeTakeoverDownlink(
      command,
      (message) => {
        const ws = activeReportSocket;
        if (!ws || ws.readyState !== 1) return false;
        try {
          ws.send(JSON.stringify(message));
          return true;
        } catch {
          return false;
        }
      },
    );
    return;
  }
  // [OmniCode] 批次4 单点下沉：assetFetch 应答不依赖窗口存在性——按 requestId 关联
  // pending 表（响应到达时在途表必有项，迟到/陌生 requestId 直接丢弃防串扰）。
  if (command.type === "assetFetchResult") {
    const requestId =
      typeof command.assetRequestId === "string" ? command.assetRequestId : "";
    const pending = pendingSharedAssetRequests.get(requestId);
    if (!pending) return;
    pendingSharedAssetRequests.delete(requestId);
    clearTimeout(pending.timer);
    const result = command.assetResult as OmnicodeSharedAssetFetchReply | undefined;
    pending.resolve(
      result && typeof result === "object"
        ? {
            ok: result.ok === true,
            ...(typeof result.dataBase64 === "string" ? { dataBase64: result.dataBase64 } : {}),
            ...(typeof result.error === "string" ? { error: result.error } : {}),
          }
        : { ok: false, error: "asset_reply" },
    );
    return;
  }
  // [OmniCode] 模式二 R2：accountMaterial 应答不依赖窗口存在性——按 requestId 关联
  // pending 表（迟到/陌生 requestId 直接丢弃防串扰；ok=false 由调用方回落 local 来源）。
  if (command.type === "accountMaterialResult") {
    const requestId =
      typeof command.accountRequestId === "string" ? command.accountRequestId : "";
    const pending = pendingAccountMaterialRequests.get(requestId);
    if (!pending) return;
    pendingAccountMaterialRequests.delete(requestId);
    clearTimeout(pending.timer);
    const result = command.accountResult as OmnicodeAccountMaterialFetchReply | undefined;
    pending.resolve(
      result && typeof result === "object"
        ? {
            ok: result.ok === true,
            ...(typeof result.dataBase64 === "string" ? { dataBase64: result.dataBase64 } : {}),
            ...(typeof result.error === "string" ? { error: result.error } : {}),
          }
        : { ok: false, error: "account_material_reply" },
    );
    return;
  }
  // [OmniCode] 丙1 远程聚合 R3：remoteWorkspaceListRequest 不依赖窗口存在性——快照
  // 读取与上行在执行器内完成（探针缺席/发送失败静默放弃，管理器死线惰性收口；
  // 被聚合实例零 relay 零凭据——只应答目录查询，spec §3 角色边界）。
  if (command.type === "remoteWorkspaceListRequest") {
    handleOmnicodeRemoteWorkspaceListRequest(command, sendOmnicodeInstanceBridgeUplink);
    return;
  }
  // [OmniCode] 丙1 远程聚合 R4 failover：remoteHostAnnounce 宿主变更广播（spec §6）。
  // 不依赖窗口存在性——schema 校验 + epoch 单调去重 + 本地目录视图缓存失效全在
  // 执行器内完成（本阶段不做宿主自动转移，接收面只做提示配套的视图失效）。
  if (command.type === "remoteHostAnnounce") {
    handleOmnicodeRemoteHostAnnounce(command);
    return;
  }
  // [OmniCode] 批次2 B2-1（T4）：openWorkspace 不依赖窗口存在性——冷启动早期的请求也
  // 要能投递（Root 的 onOpenWorkspacePath 由 preload 先缓存后回放，天然容忍 renderer
  // 未就绪）。其余命令仍以主窗口存在为前提。
  if (command.type === "openWorkspace") {
    const path = typeof command.path === "string" ? command.path.trim() : "";
    if (!path) return;
    // 实例走自身正常打开流程：官方 OpenWorkspacePath 通道 → Root onOpenWorkspacePath
    // → saveProject 打开锁守卫（工作区被其他实例占用即结构化错误冒泡，不再静默）。
    getPrimaryInstanceWindow()?.webContents.send(PlatformChannels.OpenWorkspacePath, path);
    return;
  }
  if (command.type === "requestWindowHandle") {
    // 管理器在需要建立 owned 关系但尚未收到 hello 时主动索取（连上即 hello，此为兜底）
    lastReportedHwndHex = null; // 强制重发
    return;
  }
  // [OmniCode] 批次4 全局偏好层：applyGlobalPrefs 不依赖窗口存在性——环形抑制/消毒/
  // setting.json 写入/热应用全在协调器（globalPrefs.ts）内完成（fire-and-forget）。
  if (command.type === "applyGlobalPrefs") {
    void handleOmnicodeGlobalPrefsApplyCommand(command.prefs, command.sourceInstanceId);
    return;
  }
  // [OmniCode] 实例元数据批次：rename——窗口原生标题热更新（win.setTitle）+ renderer
  // document.title 同步（广播 OmnicodeInstanceTitleChanged，preload 直写 document.title；
  // page-title-updated 默认链路随后把原生标题对齐同一字符串，双保险同值）。窗口未就绪
  // 时跳过（下次启动由 profile.json env 快照收敛）。
  if (command.type === "rename") {
    const title = typeof command.title === "string" ? command.title.trim() : "";
    if (!title) return;
    const win = getPrimaryInstanceWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.setTitle(title);
    } catch (error) {
      console.warn("[omnicode] 实例窗口标题热更新失败:", error);
    }
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(PlatformChannels.OmnicodeInstanceTitleChanged, title);
    }
    return;
  }
  const win = getPrimaryInstanceWindow();
  if (!win) return;
  switch (command.type) {
    case "show":
    case "restore":
      win.show();
      break;
    case "hide":
      win.hide();
      break;
    case "focus":
      if (win.isMinimized()) win.restore();
      win.show();
      // [OmniCode] 批次3 T2：Windows 前台锁会拦截后台进程的 focus 激活（SetForegroundWindow
      // 限制），实例窗口可能仍被管理器或其他窗口盖住。moveTop 无条件把窗口提到 Z 序最前
      //（只抬升不抢激活权，规避前台锁），focus 随后尽力激活；被拦时窗口至少已置顶可见。
      win.moveTop();
      win.focus();
      break;
    case "quit":
      app.quit();
      break;
    case "subscribeThumbnails":
      thumbnailSubscribed = true;
      break;
    case "unsubscribeThumbnails":
      thumbnailSubscribed = false;
      break;
    // M2 v1 平铺编排：先解除最小化/最大化再 setBounds（Windows 最大化态下 setBounds 异常）；
    // 覆盖保存编排前 bounds（还原=回到最近一次编排前位置）。
    // 批次2 B2-3：arrange 是桌面模式动作，先解除内嵌态再编排。
    case "arrange":
      if (!isOmnicodeArrangeBounds(command.bounds)) break;
      if (embedActive) releaseEmbed(win);
      if (win.isMinimized()) win.restore();
      if (win.isMaximized()) win.unmaximize();
      lastBoundsBeforeArrange = win.getBounds();
      win.setBounds(command.bounds);
      break;
    case "restoreBounds":
      if (!lastBoundsBeforeArrange) break;
      if (embedActive) releaseEmbed(win);
      win.setBounds(lastBoundsBeforeArrange);
      break;
    // [OmniCode] 批次2 B2-3：内嵌布局/解除（spec §批次2 D9）
    case "embedLayout":
      applyEmbedLayout(win, command.rects);
      break;
    case "releaseEmbed":
      releaseEmbed(win);
      break;
    default:
      break;
  }
}

// ─── [OmniCode] 后台降载 tick 决策（纯函数，单测登记 engineering-test-files.json） ───

/** 帧生产档位：paused=停帧（不产帧）；inactive=降帧（低频产帧）；active=正常。 */
export type OmnicodeCaptureFramePolicy = "paused" | "inactive" | "active";

/**
 * 帧生产档位决策（纯函数）。停帧档：窗口不可见（停靠 hide）或最小化 → 不再调用
 * capturePage（可见性从窗口状态直接读取，无需 renderer 回路；Chromium 的 Windows
 * 原生遮挡检测会让被完全遮挡窗口的 capturePage 拿不到新帧，表现自然回落为冻结，
 * 归入降帧档的低频采样即可）。降帧档：可见但失焦（非活动）→ 低频采样。
 * 分支序 paused > inactive > active。
 */
export function resolveOmnicodeCaptureFramePolicy(input: {
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}): OmnicodeCaptureFramePolicy {
  if (!input.visible || input.minimized) return "paused";
  if (!input.focused) return "inactive";
  return "active";
}

/**
 * 档位 → capture 间隔。paused 时调用方根本不产帧（间隔无意义，回正常档常量）；
 * inactive 档 2000ms（≈0.5fps，与正常档 700ms≈1.4fps 相比降 64% 帧量）。
 */
export function resolveOmnicodeCaptureIntervalMs(policy: OmnicodeCaptureFramePolicy): number {
  return policy === "inactive" ? CAPTURE_INTERVAL_INACTIVE_MS : CAPTURE_INTERVAL_MS;
}

/**
 * 停帧态广播决策（纯函数）：仅 policy=paused 的进入/退出翻转时返回应广播值，
 * 稳态返回 null（不广播）。inactive/active 离开 paused 也算翻转（恢复广播）。
 */
export function resolveOmnicodeFramePausedBroadcast(input: {
  policy: OmnicodeCaptureFramePolicy;
  lastNotifiedPaused: boolean;
}): boolean | null {
  const paused = input.policy === "paused";
  if (paused === input.lastNotifiedPaused) return null;
  return paused;
}

export interface OmnicodeFrameGateDecision {
  /** true = 本 tick 放行产帧。 */
  open: boolean;
  /** true = 检测到时钟回拨，调用方须把 lastSentFrameAt 重置为 0（锚点失效自愈）。 */
  resetAnchor: boolean;
}

/**
 * 降帧闸门判定（纯函数）：elapsed = now - lastSentFrameAt 与当前档间隔比较。
 * 时钟回拨（NTP 校正/VM 快照恢复）会让 elapsed 为负——负值夹 0 判锚点失效：
 * 本 tick 放行 + 调用方重置 lastSentFrameAt=0（按新时钟重新起算，发送成功即重锚）。
 * 否则负差值恒小于间隔，全部 tick 被跳过 → 缩略图冻结至墙钟追平回拨量。
 */
export function resolveOmnicodeFrameGate(input: {
  now: number;
  lastSentFrameAt: number;
  intervalMs: number;
}): OmnicodeFrameGateDecision {
  const elapsed = input.now - input.lastSentFrameAt;
  if (elapsed < 0) return { open: true, resetAnchor: true };
  return { open: elapsed >= input.intervalMs, resetAnchor: false };
}

function startCaptureLoop(ws: WebSocket): void {
  if (captureTimer) return;
  captureTimer = setInterval(() => {
    if (!thumbnailSubscribed || captureInFlight || ws.readyState !== 1) return;
    const win = getPrimaryInstanceWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    // [OmniCode] 后台降载：档位决策唯一口径（v0 的 isMinimized 单点检查升级为
    // paused/inactive/active 三档；隐藏窗口在此档位下不再调用 capturePage）。
    const policy = resolveOmnicodeCaptureFramePolicy({
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      focused: win.isFocused(),
    });
    syncOmnicodeFramePausedNotification(ws, policy);
    if (policy === "paused") return;
    // 降帧档：距上一帧不足当前档间隔则跳过本 tick（tick 心跳保持 700ms，空 tick
    // 成本 ≈ 一次 setTimeout 回调，与 X1 pause-invisible 同先例）。时钟回拨：负差值
    // 夹 0 判锚点失效——重置后本 tick 放行按新时钟重新起算（自愈，不冻结缩略图）。
    const gate = resolveOmnicodeFrameGate({
      now: Date.now(),
      lastSentFrameAt,
      intervalMs: resolveOmnicodeCaptureIntervalMs(policy),
    });
    if (gate.resetAnchor) lastSentFrameAt = 0;
    if (!gate.open) return;
    captureInFlight = true;
    // [OmniCode] 批次2 B2-3（T1）：帧附内容区尺寸（DIP）——管理器侧卡片按真实宽高比
    // letterbox（修"显示不完整"）。capturePage 与 getContentSize 同步读取，口径一致。
    const [contentWidth, contentHeight] = win.getContentSize();
    const contentSize =
      typeof contentWidth === "number" &&
      typeof contentHeight === "number" &&
      contentWidth > 0 &&
      contentHeight > 0
        ? { width: contentWidth, height: contentHeight }
        : undefined;
    void win.webContents
      .capturePage()
      .then((image) => {
        captureInFlight = false;
        if (image.isEmpty()) return;
        // 停帧竞态防御：capturePage 在飞期间窗口转不可见（hide/最小化）→ 丢弃该帧，
        // 不把旧帧/空帧混进停帧期；恢复可见后下一 tick 重截新鲜帧（capturePage 对
        // 可见窗口总是取当前合成器帧，1-2 tick 内画面正确，无黑帧/残影）。
        if (
          resolveOmnicodeCaptureFramePolicy({
            visible: win.isVisible(),
            minimized: win.isMinimized(),
            focused: win.isFocused(),
          }) === "paused"
        ) {
          return;
        }
        const frame = image.toJPEG(55).toString("base64");
        if (ws.readyState === 1 && frame.length > 0) {
          lastSentFrameAt = Date.now();
          ws.send(
            JSON.stringify({
              type: "thumbnail",
              frame,
              ...(contentSize ? { width: contentSize.width, height: contentSize.height } : {}),
            }),
          );
        }
      })
      .catch(() => {
        captureInFlight = false;
      });
  }, CAPTURE_INTERVAL_MS);
  captureTimer.unref?.();
}

/**
 * 停帧态翻转广播（实例 → 管理器）：只在 paused 进入/退出时发一次 framePaused；
 * 发送成功才登记已通知态（失败下 tick 重试）。断连时复位（重连后重新上报收敛）。
 */
function syncOmnicodeFramePausedNotification(
  ws: WebSocket,
  policy: OmnicodeCaptureFramePolicy,
): void {
  const paused = resolveOmnicodeFramePausedBroadcast({ policy, lastNotifiedPaused });
  if (paused === null || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type: "framePaused", paused }));
    lastNotifiedPaused = paused;
  } catch {
    // 发送失败不登记（下一 tick 按同一翻转重试）；消息仅在状态翻转时产生，无风暴风险
  }
}

/** Profile 实例身份启动时由 index.ts 在 app ready 后调用；非实例身份为 no-op。 */
export function startOmnicodeInstanceBridgeClient(): void {
  const profileId = process.env.OMNICODE_PROFILE_ID?.trim() ?? "";
  const port = Number(process.env.OMNICODE_BRIDGE_PORT ?? 0);
  const token = process.env.OMNICODE_BRIDGE_TOKEN ?? "";
  if (
    !/^p[0-9a-z]{8,20}$/.test(profileId) ||
    !Number.isInteger(port) ||
    port <= 0 ||
    !/^[0-9a-f]{32}$/.test(token)
  ) {
    return;
  }
  const connect = (): void => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${token}&profileId=${encodeURIComponent(profileId)}`,
    );
    ws.on("open", () => {
      activeReportSocket = ws;
      startCaptureLoop(ws);
      startHelloLoop(ws);
      // [OmniCode] 丙1 远程聚合 R3：连桥即推当前 workspace 快照（fire-and-forget，与
      // 管理器侧"连接即查询"双保险——覆盖实例桥先连、renderer 慢就绪的时序差；探针
      // 缺席/未开工作区静默跳过，spec §5 目录来源收敛零轮询）。
      notifyOmnicodeRemoteWorkspaceSnapshotChanged(sendOmnicodeInstanceBridgeUplink);
    });
    ws.on("message", (data) => {
      try {
        applyCommand(JSON.parse(String(data)));
      } catch {
        // 忽略坏帧
      }
    });
    ws.on("close", () => {
      if (activeReportSocket === ws) {
        activeReportSocket = null;
      }
      // [OmniCode] 批次4 单点下沉：断连即失败全部在途共享资产请求（调用方回退直连，
      // 不等重连——重连耗时会让资产渲染比直连更慢）。
      for (const pending of pendingSharedAssetRequests.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: "bridge_disconnected" });
      }
      pendingSharedAssetRequests.clear();
      // [OmniCode] 模式二 R2：断连同样即失败全部在途附加账号材料请求（Host 回落 local）。
      for (const pending of pendingAccountMaterialRequests.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: "bridge_disconnected" });
      }
      pendingAccountMaterialRequests.clear();
      // [OmniCode] D12 接管流：断连清持有者在途确认簿记（管理器死线按 timeout 收口）。
      clearOmnicodeTakeoverInstanceState();
      stopHelloLoop();
      lastReportedHwndHex = null;
      // [OmniCode] 后台降载：停帧广播态随连接复位——重连后下一 tick 按当前档位
      // 重新上报（管理器侧 disconnected 已清停帧态，两侧收敛一致）。
      lastNotifiedPaused = false;
      lastSentFrameAt = 0;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, RECONNECT_DELAY_MS);
      }
    });
    ws.on("error", () => {
      ws.close();
    });
  };
  connect();
}

/**
 * [OmniCode] D12 接管流：实例桥上行的稳定发送入口（index.ts 装配接管 IPC 时注入）。
 * 未回连/发送失败返回 false；与 reportOmnicodeGlobalPrefsToManager 同语义（不重试）。
 */
export function sendOmnicodeInstanceBridgeUplink(message: unknown): boolean {
  const ws = activeReportSocket;
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/**
 * [OmniCode] 批次4 全局偏好层：实例 → 管理器上行上报（fire-and-forget）。
 * 未回连/发送失败返回 false（调用方只记日志，不重试——连接即推快照兜底收敛）。
 */
export function reportOmnicodeGlobalPrefsToManager(
  prefs: unknown,
  sourceInstanceId: string,
): boolean {
  const ws = activeReportSocket;
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(
      JSON.stringify({ type: "reportGlobalPrefs", prefs, sourceInstanceId }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * [OmniCode] 模式二 R2（spec: docs/omnicode/multi-account-sessions.md §5）：实例 → 管理器
 * 附加账号材料取回（requestId 关联，超时/断连即失败 → 实例 Host 回落 local 文件来源）。
 * 管理器是唯一解密权威（实例不持有其他 profile 密钥）；应答 base64 只进内存（实例侧
 * 短 TTL 缓存），不落盘不进日志。未回连立刻失败（不等待重连）。
 */
export function requestOmnicodeAccountMaterialFromManager(
  request: { accountId: string },
  timeoutMs: number = OMNICODE_ACCOUNT_MATERIAL_FETCH_TIMEOUT_MS,
): Promise<OmnicodeAccountMaterialFetchReply> {
  const ws = activeReportSocket;
  if (!ws || ws.readyState !== 1) {
    return Promise.resolve({ ok: false, error: "bridge_disconnected" });
  }
  const requestId = randomUUID();
  return new Promise<OmnicodeAccountMaterialFetchReply>((resolve) => {
    const timer = setTimeout(() => {
      pendingAccountMaterialRequests.delete(requestId);
      resolve({ ok: false, error: "account_material_timeout" });
    }, Math.max(1_000, timeoutMs));
    timer.unref?.();
    pendingAccountMaterialRequests.set(requestId, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      timer,
    });
    try {
      ws.send(JSON.stringify({ type: "accountMaterial", requestId, request }));
    } catch {
      pendingAccountMaterialRequests.delete(requestId);
      clearTimeout(timer);
      resolve({ ok: false, error: "account_material_send" });
    }
  });
}

/**
 * [OmniCode] 批次4 单点下沉：实例 → 管理器共享资产取回（requestId 关联，超时/断连即
 * 失败 → 调用方回退直连）。仅在实例身份桥接激活时可用；未回连立刻失败（不等待重连——
 * 等待会让资产渲染比直连更慢）。
 */
export function requestOmnicodeSharedAssetFromManager(
  request: { src: string; sha256: string; kind: "image" | "video" | "bundle" },
  timeoutMs: number = SHARED_ASSET_FETCH_TIMEOUT_MS,
): Promise<OmnicodeSharedAssetFetchReply> {
  const ws = activeReportSocket;
  if (!ws || ws.readyState !== 1) {
    return Promise.resolve({ ok: false, error: "bridge_disconnected" });
  }
  const requestId = randomUUID();
  return new Promise<OmnicodeSharedAssetFetchReply>((resolve) => {
    const settle = (result: OmnicodeSharedAssetFetchReply) => {
      clearTimeout(timer);
      pendingSharedAssetRequests.delete(requestId);
      resolve(result);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, error: "asset_timeout" });
    }, Math.max(1_000, timeoutMs));
    timer.unref?.();
    pendingSharedAssetRequests.set(requestId, {
      resolve: (result) => {
        // 应答路径已清表；这里只转发结果。
        resolve(result);
      },
      timer,
    });
    try {
      ws.send(JSON.stringify({ type: "assetFetch", requestId, request }));
    } catch {
      settle({ ok: false, error: "asset_send" });
    }
  });
}

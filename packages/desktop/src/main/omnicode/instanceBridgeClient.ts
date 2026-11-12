// [OmniCode] 实例侧桥接客户端：回连控制台，接受窗口命令并按需上报缩略图帧。
// 仅 Profile 实例身份启动时激活（OMNICODE_PROFILE_ID + OMNICODE_BRIDGE_* 由
// profileBootstrap 从 spawn env 注入并自派生双保险，批次1 D6 后不再经 handoff 文件）。
// 已知限制：窗口隐藏/最小化时 capturePage 可能拿不到新帧（v0 接受，网格停留最后一帧）。
// [OmniCode] 批次2 B2-3（T1/T2）：缩略图帧附内容区 {w,h}（卡片 letterbox）；hello 上报
// 主窗口 HWND（管理器 owned-window 内嵌用）；embedLayout/releaseEmbed 内嵌布局命令
//（校验/解除最大化/最低尺寸放宽 + skipTaskbar + 桌面基线保存，spec §批次2 D9）。
import WebSocket from "ws";
import { app, BrowserWindow } from "electron";
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

const CAPTURE_INTERVAL_MS = 700; // ≈1.4fps；JPEG q55 单帧约 40-80KB，本地回环无压力
const RECONNECT_DELAY_MS = 3000;
const HELLO_POLL_INTERVAL_MS = 1000;

let reconnectTimer: NodeJS.Timeout | null = null;
let captureTimer: NodeJS.Timeout | null = null;
let helloTimer: NodeJS.Timeout | null = null;
let thumbnailSubscribed = false;
let captureInFlight = false;
/** 最近一次已上报的 HWND（变化时重发 hello——窗口销毁重建后句柄会变）。 */
let lastReportedHwndHex: string | null = null;
/** 内嵌中标记：embedLayout 成功后置位，releaseEmbed/编排冲突时复位。 */
let embedActive = false;

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

function applyCommand(command: { type?: string; bounds?: unknown; path?: unknown; rects?: unknown }): void {
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

function startCaptureLoop(ws: WebSocket): void {
  if (captureTimer) return;
  captureTimer = setInterval(() => {
    if (!thumbnailSubscribed || captureInFlight || ws.readyState !== 1) return;
    const win = getPrimaryInstanceWindow();
    if (!win || win.isMinimized() || win.webContents.isDestroyed()) return;
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
        const frame = image.toJPEG(55).toString("base64");
        if (ws.readyState === 1 && frame.length > 0) {
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
      startCaptureLoop(ws);
      startHelloLoop(ws);
    });
    ws.on("message", (data) => {
      try {
        applyCommand(JSON.parse(String(data)));
      } catch {
        // 忽略坏帧
      }
    });
    ws.on("close", () => {
      stopHelloLoop();
      lastReportedHwndHex = null;
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

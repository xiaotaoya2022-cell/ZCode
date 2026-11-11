// [OmniCode] 实例侧桥接客户端：回连控制台，接受窗口命令并按需上报缩略图帧。
// 仅 Profile 实例身份启动时激活（OMNICODE_PROFILE_ID + OMNICODE_BRIDGE_* 由
// profileBootstrap 从 spawn env 注入并自派生双保险，批次1 D6 后不再经 handoff 文件）。
// 已知限制：窗口隐藏/最小化时 capturePage 可能拿不到新帧（v0 接受，网格停留最后一帧）。
import WebSocket from "ws";
import { app, BrowserWindow } from "electron";
import process from "node:process";

const CAPTURE_INTERVAL_MS = 700; // ≈1.4fps；JPEG q55 单帧约 40-80KB，本地回环无压力
const RECONNECT_DELAY_MS = 3000;

let reconnectTimer: NodeJS.Timeout | null = null;
let captureTimer: NodeJS.Timeout | null = null;
let thumbnailSubscribed = false;
let captureInFlight = false;

function getPrimaryInstanceWindow(): BrowserWindow | undefined {
  // 实例是单主窗口应用（primaryWindowCoordinator 单飞）
  return BrowserWindow.getAllWindows()[0];
}

/** [OmniCode] M2 v1 平铺编排的还原基线：最近一次收到 arrange 时的窗口 bounds（spec §实时视窗）。 */
let lastBoundsBeforeArrange: Electron.Rectangle | null = null;

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

function applyCommand(command: { type?: string; bounds?: unknown }): void {
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
    case "arrange":
      if (!isOmnicodeArrangeBounds(command.bounds)) break;
      if (win.isMinimized()) win.restore();
      if (win.isMaximized()) win.unmaximize();
      lastBoundsBeforeArrange = win.getBounds();
      win.setBounds(command.bounds);
      break;
    case "restoreBounds":
      if (!lastBoundsBeforeArrange) break;
      win.setBounds(lastBoundsBeforeArrange);
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
    void win.webContents
      .capturePage()
      .then((image) => {
        captureInFlight = false;
        if (image.isEmpty()) return;
        const frame = image.toJPEG(55).toString("base64");
        if (ws.readyState === 1 && frame.length > 0) {
          ws.send(JSON.stringify({ type: "thumbnail", frame }));
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
    });
    ws.on("message", (data) => {
      try {
        applyCommand(JSON.parse(String(data)));
      } catch {
        // 忽略坏帧
      }
    });
    ws.on("close", () => {
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

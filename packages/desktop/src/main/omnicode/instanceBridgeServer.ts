// [OmniCode] 实例桥接枢纽（控制台侧）：本地 WebSocket 服务，实例回连上报缩略图帧并接受命令。
// spec: docs/omnicode/profile-runtime.md §实时视窗。
//
// 安全边界：
// - 仅监听 127.0.0.1，端口随机（listen(0)）；
// - 握手 token = randomBytes(16).hex，经 spawn env 原子注入实例（批次1 D6：身份通道
//   退役一次性 handoff 文件，回连信息与身份同走 spawn 参数面）；
// - token 比较用 timingSafeEqual；一个 profileId 同时只允许一条连接（后连踢前连）；
// - 缩略图帧只投递给注册的监听者（console main 转发给 renderer）。
// [OmniCode] 批次2 B2-3：thumbnail 帧可附内容区 {w,h}（卡片 letterbox）；hello 消息
// 上报实例 HWND（管理器 owned-window 内嵌）；新增 embedLayout/releaseEmbed/
// requestWindowHandle 命令（spec §批次2 D9）。管理器侧反应经 managerHooks 注入
//（desktopProfileIpc 装配，避免 server↔consoleEmbedding 导入循环）。
import { WebSocketServer, type WebSocket } from "ws";
import { BrowserWindow } from "electron";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PlatformChannels,
  ZCODE_PRODUCT_FLAVOR,
  type OmnicodeInstanceEventPayload,
  type ZCodeProductFlavor,
} from "@zcode/shared";

export interface OmnicodeInstanceBridgeCommand {
  type:
    | "show"
    | "hide"
    | "focus"
    | "quit"
    | "subscribeThumbnails"
    | "unsubscribeThumbnails"
    | "restore"
    // M2 v1 平铺编排（spec §实时视窗）：arrange 带目标矩形，restoreBounds 按实例侧基线回位
    | "arrange"
    | "restoreBounds"
    // [OmniCode] 批次2 B2-1（T4）：管理器把"打开工作区"请求直转实例（实例走自身
    // 正常打开流程，尊重工作区锁）；path 为本地目录绝对路径
    | "openWorkspace"
    // [OmniCode] 批次2 B2-3（T2 内嵌，spec §批次2 D9）：rects=屏幕 DIP 矩形（实例按
    // 自身 profileId 滤出并独立校验）；releaseEmbed=解除内嵌回桌面基线；
    // requestWindowHandle=索取 hello（HWND 兜底重报）
    | "embedLayout"
    | "releaseEmbed"
    | "requestWindowHandle";
  /** arrange 命令的目标矩形（父进程由 workArea 计算后下发）。 */
  bounds?: { x: number; y: number; width: number; height: number };
  /** openWorkspace 命令的工作区目录路径。 */
  path?: string;
  /** embedLayout 命令的目标矩形集合（管理器换算屏幕 DIP 后下发，含全部内嵌实例）。 */
  rects?: { profileId: string; x: number; y: number; width: number; height: number }[];
}

export interface OmnicodeInstanceBridgeListeners {
  onInstanceConnected?: (profileId: string) => void;
  onInstanceDisconnected?: (profileId: string) => void;
  onThumbnail?: (profileId: string, frameBase64: string, size?: { width: number; height: number }) => void;
}

/** 管理器侧反应钩子（desktopProfileIpc 注入：HWND 登记 / 内嵌跟接 / 预览订阅对账）。 */
export interface OmnicodeInstanceBridgeManagerHooks {
  onInstanceConnected?: (profileId: string) => void;
  onInstanceDisconnected?: (profileId: string) => void;
  onInstanceHello?: (profileId: string, hwndHex: string) => void;
}

let managerHooks: OmnicodeInstanceBridgeManagerHooks | null = null;

export function setOmnicodeInstanceBridgeManagerHooks(hooks: OmnicodeInstanceBridgeManagerHooks | null): void {
  managerHooks = hooks;
}

/** [OmniCode] 推送给全部 renderer 窗口（设置页网格订阅渲染缩略图）。 */
function broadcastOmnicodeInstanceEvent(payload: OmnicodeInstanceEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.OmnicodeInstanceEvent, payload);
    }
  }
}

let startPromise: Promise<{ port: number; token: string }> | null = null;

/**
 * [OmniCode] B2 评审修复（P1-2）：实例连接时是否沿用 v0"连上即订阅缩略图"。
 * 仅官方 flavor 保留（官方进程无管理器订阅编排，且实际不会有实例回连，纯零影响保持）；
 * omnicode 管理器完全交给 managerHooks.onInstanceConnected → reconcilePreviewSubscriptions
 * 的按卡片对账（spec §批次2 D9"总开关关闭 = 全部退订；不再是连上即订阅"）。纯函数可单测。
 */
export function shouldAutoSubscribeThumbnailsOnConnect(flavor: ZCodeProductFlavor): boolean {
  return flavor !== "omnicode";
}

/** [OmniCode] 幂等启动桥接服务并接通 renderer 广播；doLaunch 前必须 await。 */
export function ensureOmnicodeInstanceBridgeServerStarted(): Promise<{
  port: number;
  token: string;
}> {
  if (!startPromise) {
    startPromise = startOmnicodeInstanceBridgeServer({
      onThumbnail: (profileId, frame, size) =>
        broadcastOmnicodeInstanceEvent({
          profileId,
          type: "thumbnail",
          frame,
          ...(size ? { width: size.width, height: size.height } : {}),
        }),
      onInstanceConnected: (profileId) => {
        broadcastOmnicodeInstanceEvent({ profileId, type: "connected" });
        // [OmniCode] B2 评审修复（P1-2）：v0"连上即订阅"收窄为官方 flavor 专属
        //（官方无订阅编排、实际无实例回连，零影响保持）；omnicode 管理器连接后由
        // managerHooks.onInstanceConnected → reconcilePreviewSubscriptions 按
        // 总开关∧视口可见 对账订阅（spec §批次2 D9——预览关时连接不产生订阅）。
        if (shouldAutoSubscribeThumbnailsOnConnect(ZCODE_PRODUCT_FLAVOR)) {
          setOmnicodeInstanceThumbnailSubscription(profileId, true);
        }
        managerHooks?.onInstanceConnected?.(profileId);
      },
      onInstanceDisconnected: (profileId) => {
        broadcastOmnicodeInstanceEvent({ profileId, type: "disconnected" });
        managerHooks?.onInstanceDisconnected?.(profileId);
      },
    });
  }
  return startPromise;
}

interface BridgeServerState {
  wss: WebSocketServer;
  token: string;
  port: number;
  listeners: OmnicodeInstanceBridgeListeners;
}

const connectionsByProfileId = new Map<string, WebSocket>();
let serverState: BridgeServerState | null = null;

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** 启动桥接服务；重复调用幂等。端口在 listen 回调后就绪。 */
export function startOmnicodeInstanceBridgeServer(
  listeners: OmnicodeInstanceBridgeListeners,
): Promise<{ port: number; token: string }> {
  if (serverState) {
    return Promise.resolve({ port: serverState.port, token: serverState.token });
  }
  const token = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const address = wss.address();
      const port = typeof address === "object" && address ? address.port : 0;
      serverState = { wss, token, port, listeners };
      resolve({ port, token });
    });
    wss.on("connection", (ws: WebSocket, request) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const tokenParam = url.searchParams.get("token") ?? "";
      const profileIdParam = url.searchParams.get("profileId") ?? "";
      const tokenOk =
        /^[0-9a-f]{32}$/.test(tokenParam) &&
        timingSafeEqual(tokenDigest(token), tokenDigest(tokenParam));
      const profileOk = /^p[0-9a-z]{8,20}$/.test(profileIdParam);
      if (!tokenOk || !profileOk) {
        ws.close(4001, "unauthorized");
        return;
      }
      const previous = connectionsByProfileId.get(profileIdParam);
      if (previous) {
        previous.close(4003, "replaced");
      }
      connectionsByProfileId.set(profileIdParam, ws);
      serverState?.listeners.onInstanceConnected?.(profileIdParam);
      ws.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const message = parsed as { type?: string; frame?: unknown; hwndHex?: unknown; width?: unknown; height?: unknown };
        if (message.type === "thumbnail" && typeof message.frame === "string") {
          const width = typeof message.width === "number" && message.width > 0 ? message.width : undefined;
          const height = typeof message.height === "number" && message.height > 0 ? message.height : undefined;
          serverState?.listeners.onThumbnail?.(
            profileIdParam,
            message.frame,
            width !== undefined && height !== undefined ? { width, height } : undefined,
          );
          return;
        }
        if (message.type === "hello" && typeof message.hwndHex === "string") {
          managerHooks?.onInstanceHello?.(profileIdParam, message.hwndHex.trim());
        }
      });
      ws.on("close", () => {
        // [OmniCode] B2 评审修复（P2-10）：一个 profileId 同时只允许一条连接（后连踢前连）。
        // 被顶替的旧连接关闭时 connectionsByProfileId 已指向新连接——只有当前登记连接
        // 的 close 才代表该实例真正断开（否则 UI 收到假 disconnected、内嵌簿记被误清）。
        if (connectionsByProfileId.get(profileIdParam) === ws) {
          connectionsByProfileId.delete(profileIdParam);
          serverState?.listeners.onInstanceDisconnected?.(profileIdParam);
        }
      });
    });
  });
}

export function getOmnicodeInstanceBridgeInfo(): { port: number; token: string } | null {
  return serverState ? { port: serverState.port, token: serverState.token } : null;
}

/** 当前已回连的实例 profileId 集合（预览订阅对账/内嵌目标计算用）。 */
export function getOmnicodeConnectedInstanceProfileIds(): string[] {
  return [...connectionsByProfileId.keys()];
}

/** 向实例发命令；未连接返回 false。 */
export function sendOmnicodeInstanceCommand(
  profileId: string,
  command: OmnicodeInstanceBridgeCommand,
): boolean {
  const ws = connectionsByProfileId.get(profileId);
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(command));
  return true;
}

/** 控制 renderer 订阅关系变化时，通知实例开始/停止产帧。 */
export function setOmnicodeInstanceThumbnailSubscription(profileId: string, subscribed: boolean): void {
  const ws = connectionsByProfileId.get(profileId);
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: subscribed ? "subscribeThumbnails" : "unsubscribeThumbnails" }));
}

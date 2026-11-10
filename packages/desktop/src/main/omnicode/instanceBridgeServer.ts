// [OmniCode] 实例桥接枢纽（控制台侧）：本地 WebSocket 服务，实例回连上报缩略图帧并接受命令。
// spec: docs/omnicode/profile-runtime.md §实时视窗（M2）。
//
// 安全边界：
// - 仅监听 127.0.0.1，端口随机（listen(0)）；
// - 握手 token = randomBytes(16).hex，经 handoff 文件交给实例（不进命令行/长期 env）；
// - token 比较用 timingSafeEqual；一个 profileId 同时只允许一条连接（后连踢前连）；
// - 缩略图帧只投递给注册的监听者（console main 转发给 renderer）。
import { WebSocketServer, type WebSocket } from "ws";
import { BrowserWindow } from "electron";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PlatformChannels, type OmnicodeInstanceEventPayload } from "@zcode/shared";

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
    | "restoreBounds";
  /** arrange 命令的目标矩形（父进程由 workArea 计算后下发）。 */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface OmnicodeInstanceBridgeListeners {
  onInstanceConnected?: (profileId: string) => void;
  onInstanceDisconnected?: (profileId: string) => void;
  onThumbnail?: (profileId: string, frameBase64: string) => void;
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

/** [OmniCode] 幂等启动桥接服务并接通 renderer 广播；doLaunch 前必须 await。 */
export function ensureOmnicodeInstanceBridgeServerStarted(): Promise<{
  port: number;
  token: string;
}> {
  if (!startPromise) {
    startPromise = startOmnicodeInstanceBridgeServer({
      onThumbnail: (profileId, frame) =>
        broadcastOmnicodeInstanceEvent({ profileId, type: "thumbnail", frame }),
      onInstanceConnected: (profileId) => {
        broadcastOmnicodeInstanceEvent({ profileId, type: "connected" });
        // v0：实例连上即订阅缩略图（1.4fps/实例，本地回环开销可忽略）；
        // 按设置页可见性精化订阅是 v1 优化点。
        setOmnicodeInstanceThumbnailSubscription(profileId, true);
      },
      onInstanceDisconnected: (profileId) =>
        broadcastOmnicodeInstanceEvent({ profileId, type: "disconnected" }),
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
        const message = parsed as { type?: string; frame?: unknown };
        if (message.type === "thumbnail" && typeof message.frame === "string") {
          serverState?.listeners.onThumbnail?.(profileIdParam, message.frame);
        }
      });
      ws.on("close", () => {
        if (connectionsByProfileId.get(profileIdParam) === ws) {
          connectionsByProfileId.delete(profileIdParam);
        }
        serverState?.listeners.onInstanceDisconnected?.(profileIdParam);
      });
    });
  });
}

export function getOmnicodeInstanceBridgeInfo(): { port: number; token: string } | null {
  return serverState ? { port: serverState.port, token: serverState.token } : null;
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

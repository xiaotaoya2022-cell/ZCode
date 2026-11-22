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
  omnicodeRemoteWorkspaceListUplinkSchema,
  omnicodeSharedAssetRequestSchema,
  // [OmniCode] 模式二 R2：附加账号材料请求载荷 schema（桥服务侧校验后交管理器代理）。
  omnicodeAccountMaterialRequestPayloadSchema,
  PlatformChannels,
  sanitizeOmnicodeGlobalPrefsPayload,
  ZCODE_PRODUCT_FLAVOR,
  type OmnicodeAccountMaterialRequestPayload,
  type OmnicodeGlobalPrefsPayload,
  type OmnicodeInstanceEventPayload,
  type OmnicodeRemoteWorkspaceListUplinkMessage,
  type OmnicodeSharedAssetRequest,
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
    | "requestWindowHandle"
    // [OmniCode] 批次4 全局偏好层（spec: docs/omnicode/global-preferences.md）：管理器
    // → 实例的全局偏好下发（白名单键载荷已消毒；sourceInstanceId 供实例环形抑制）。
    | "applyGlobalPrefs"
    // [OmniCode] 实例元数据批次：改名热更新——实例 main 热更新窗口原生标题 + 广播
    // renderer document.title（title = "ZCode [新名]"，manager 侧构造）。
    | "rename"
    // [OmniCode] 批次4 单点下沉：assetFetch 的应答（管理器 → 实例；requestId 关联
    // 实例侧 pending 请求。spec: docs/omnicode/omnicode-shared-services.md §G3.3）。
    | "assetFetchResult"
    // [OmniCode] D12 接管流（spec: docs/omnicode/profile-runtime.md §批次3 D12）：
    // 转投持有者（载荷已经管理器归一：requesterProfileId=桥连接真身）；
    // takeoverResult=回执通知观察者（accepted 后观察者复用 P1-1 链路自动重开）。
    | "takeoverRequest"
    | "takeoverResult"
    // [OmniCode] 丙1 远程聚合 R3（spec: docs/omnicode/remote-aggregation.md §4/§5/§8-R3）：
    // 跨实例 workspace-list 目录查询（管理器 → 被聚合实例；实例执行器回
    // remoteWorkspaceListResult 上行应答 + 快照变化 remoteWorkspaceListReport 报告）。
    | "remoteWorkspaceListRequest"
    // [OmniCode] 模式二 R2（spec: docs/omnicode/multi-account-sessions.md §5）：
    // accountMaterialResult = 附加账号材料取回的应答（管理器 → 实例；requestId 关联
    // 实例侧 pending 请求；ok=false 时实例 Host 回落 local 文件来源提供者）。
    | "accountMaterialResult"
    // [OmniCode] 模式二 R3（spec §7）：accountDirectoryListResult = 附加账号目录元数据
    // 查询的应答（管理器 → 实例；requestId 关联实例侧 pending；条目为元数据 only，
    // 凭据/deviceMid 永不出管理器——红线）。
    | "accountDirectoryListResult"
    // [OmniCode] 丙1 远程聚合 R4 failover（spec: docs/omnicode/remote-aggregation.md §6）：
    // 宿主变更广播（宿主退出 → epoch+1；本阶段不做宿主自动转移——实例按 epoch 判新旧
    // 并刷新本地目录视图缓存，载荷按 R1 omnicodeRemoteHostAnnounceMessageSchema 校验）。
    | "remoteHostAnnounce";
  /** arrange 命令的目标矩形（父进程由 workArea 计算后下发）。 */
  bounds?: { x: number; y: number; width: number; height: number };
  /** openWorkspace 命令的工作区目录路径。 */
  path?: string;
  /** embedLayout 命令的目标矩形集合（管理器换算屏幕 DIP 后下发，含全部内嵌实例）。 */
  rects?: { profileId: string; x: number; y: number; width: number; height: number }[];
  /** applyGlobalPrefs 命令的白名单偏好载荷（发送前已消毒；实例侧再消毒一次）。 */
  prefs?: OmnicodeGlobalPrefsPayload;
  /** applyGlobalPrefs 的源身份（manager 或发起实例的 profileId；环形抑制依据）。 */
  sourceInstanceId?: string;
  /** rename 命令的实例窗口新标题（"ZCode [新名]"，manager 侧构造）。 */
  title?: string;
  /** assetFetchResult 命令的请求关联 id（实例侧 pending 表主键）。 */
  assetRequestId?: string;
  /** assetFetchResult 命令的结果载荷（ok=false 时实例回退直连）。 */
  assetResult?: { ok: boolean; dataBase64?: string; error?: string };
  // [OmniCode] 模式二 R2：accountMaterialResult 命令载荷（requestId 关联实例侧 pending 表）。
  accountRequestId?: string;
  /** accountMaterialResult 命令的结果载荷（ok=false 时实例回落 local 文件来源）。 */
  accountResult?: { ok: boolean; dataBase64?: string; error?: string };
  // [OmniCode] 模式二 R3：accountDirectoryListResult 命令载荷（requestId 关联实例侧 pending 表）。
  accountDirectoryRequestId?: string;
  /** accountDirectoryListResult 命令的结果载荷（元数据 only；ok=false 只带结构化错误键）。 */
  accountDirectoryResult?: { ok: boolean; accounts?: unknown[]; error?: string };
  // [OmniCode] 丙1 远程聚合 R4 failover：remoteHostAnnounce 命令载荷（R1 schema 校验）。
  hostProfileId?: string;
  epoch?: number;
  // [OmniCode] D12 接管流：takeoverRequest/takeoverResult 命令载荷（shared schema 校验）。
  requestId?: string;
  requesterProfileId?: string;
  requesterName?: string;
  outcome?: string;
  reason?: string;
  holderName?: string;
}

/** [OmniCode] 批次4：实例 → 管理器的全局偏好上行消息（reportGlobalPrefs）。 */
export interface OmnicodeInstanceBridgeReport {
  type: "reportGlobalPrefs";
  prefs: OmnicodeGlobalPrefsPayload;
  sourceInstanceId: string;
}

// [OmniCode] 批次4 单点下沉：实例 → 管理器的共享资产取回请求（requestId 关联应答）。
export interface OmnicodeInstanceBridgeAssetFetchRequest {
  type: "assetFetch";
  requestId: string;
  request: OmnicodeSharedAssetRequest;
}

// [OmniCode] 模式二 R2：实例 → 管理器的附加账号材料取回请求（requestId 关联应答）。
export interface OmnicodeInstanceBridgeAccountMaterialRequest {
  type: "accountMaterial";
  requestId: string;
  request: OmnicodeAccountMaterialRequestPayload;
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
  /**
   * [OmniCode] 批次4：实例上行全局偏好（载荷已在桥服务侧消毒，钩子内再走协调器二次消毒）。
   */
  onOmnicodeGlobalPrefsReport?: (
    profileId: string,
    prefs: OmnicodeGlobalPrefsPayload,
    sourceInstanceId: string,
  ) => void;
  /**
   * [OmniCode] 批次4 单点下沉：实例共享资产取回请求（载荷已在桥服务侧按
   * omnicodeSharedAssetRequestSchema 校验）。钩子缺席时桥服务回结构化错误（实例回退直连）。
   */
  onSharedAssetFetchRequest?: (
    profileId: string,
    request: OmnicodeSharedAssetRequest,
  ) => Promise<{ ok: boolean; dataBase64?: string; error?: string }>;
  /**
   * [OmniCode] 模式二 R2（spec: docs/omnicode/multi-account-sessions.md §5）：实例附加账号
   * 材料取回请求（载荷已在桥服务侧按 omnicodeAccountMaterialRequestPayloadSchema 校验）。
   * 管理器是唯一解密权威：钩子内经附加账号目录解密代理现取应答（内存现取，不落盘不进
   * 日志）。钩子缺席（官方 flavor / 未装配）时桥服务回结构化错误，实例 Host 回落 local。
   * 首参 profileId = 桥握手已验的连接真身（管理器据此排除请求方自身的主账号材料）。
   */
  onAccountMaterialRequest?: (
    profileId: string,
    request: OmnicodeAccountMaterialRequestPayload,
  ) => Promise<{ ok: boolean; dataBase64?: string; error?: string }>;
  /**
   * [OmniCode] 模式二 R3（spec: docs/omnicode/multi-account-sessions.md §7）：实例附加账号
   * 目录元数据查询。管理器仍是唯一枚举权威：钩子内经附加账号目录逐 profile 只读枚举，
   * 并**裁剪为元数据 only**（accountId/sourceProfileId/family/displayName）——deviceMid
   * 与任何凭据材料永不越过本边界（红线）。钩子缺席（官方 flavor / 未装配）时桥服务回
   * 结构化错误，实例侧目录显示为空。首参 profileId = 桥握手已验连接真身（排除请求方
   * 自身的主账号 profile）。
   */
  onAccountDirectoryListRequest?: (
    profileId: string,
  ) => Promise<{ ok: boolean; accounts?: unknown[]; error?: string }>;
  // ─── [OmniCode] D12 接管流（spec: docs/omnicode/profile-runtime.md §批次3 D12）───
  // 三个钩子的首参都是桥握手已验的连接身份（senderProfileId）——请求方/回执方绑定认证
  // 在这里完成，协调器不信任任何载荷自报身份。
  /** 观察者上行 takeoverRequest（转投持有者协调）。 */
  onTakeoverRequestFromInstance?: (profileId: string, message: unknown) => void;
  /** 持有者上行 takeoverReply（回执转投观察者）。 */
  onTakeoverReplyFromInstance?: (profileId: string, message: unknown) => void;
  /** 观察者上行 takeoverCancel（取消在途请求）。 */
  onTakeoverCancelFromInstance?: (profileId: string, message: unknown) => void;
  /**
   * [OmniCode] 丙1 远程聚合 R3：实例 workspace-list 目录上行（Result 应答 / Report 报告，
   * 载荷已按 omnicodeRemoteWorkspaceListUplinkSchema 校验，null=校验失败静默丢弃）。
   * 钩子缺席（官方 flavor / 未装配）即目录链天然禁用。
   */
  onOmnicodeRemoteWorkspaceListUplink?: (
    profileId: string,
    message: OmnicodeRemoteWorkspaceListUplinkMessage | null,
  ) => void;
}

let managerHooks: OmnicodeInstanceBridgeManagerHooks | null = null;

export function setOmnicodeInstanceBridgeManagerHooks(hooks: OmnicodeInstanceBridgeManagerHooks | null): void {
  managerHooks = hooks;
}

/**
 * [OmniCode] 推送给全部 renderer 窗口（设置页网格订阅渲染缩略图）。
 * [OmniCode] 批次2.5 X3：导出复用——托盘聚焦实例时广播 focusRequested 事件（renderer
 * 网格滚动定位对应卡片，spec: docs/omnicode/console-extras.md §X3）。
 */
export function broadcastOmnicodeInstanceEvent(payload: OmnicodeInstanceEventPayload): void {
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
        const message = parsed as { type?: string; frame?: unknown; hwndHex?: unknown; width?: unknown; height?: unknown; prefs?: unknown; sourceInstanceId?: unknown; paused?: unknown };
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
          return;
        }
        // [OmniCode] 后台降载：实例停帧态翻转上行 → 广播 renderer（卡片/性能面板标注
        // "已停帧"；下一帧缩略图到达时消费方兜底清除，防事件丢失）。
        if (message.type === "framePaused" && typeof message.paused === "boolean") {
          broadcastOmnicodeInstanceEvent({
            profileId: profileIdParam,
            type: "framePaused",
            paused: message.paused,
          });
          return;
        }
        // [OmniCode] 批次4：全局偏好上行（reportGlobalPrefs）。桥服务侧先消毒载荷
        //（白名单过滤；白名单外键到不了钩子），再交协调器落全局层并下行广播。
        if (message.type === "reportGlobalPrefs") {
          const prefs = sanitizeOmnicodeGlobalPrefsPayload(message.prefs);
          const sourceInstanceId =
            typeof message.sourceInstanceId === "string" ? message.sourceInstanceId : "";
          managerHooks?.onOmnicodeGlobalPrefsReport?.(profileIdParam, prefs, sourceInstanceId);
          return; // 审计 R1 遗留 2：命中后即收口，免落后续分支判型
        }
        // [OmniCode] 批次4 单点下沉：实例共享资产取回请求。先按 shared 契约校验形态
        //（https 直链/sha256/kind 白名单），再交管理器缓存解析；应答只回请求实例。
        // 钩子缺席（官方 flavor）或解析失败都回结构化错误 → 实例回退直连（不瘫）。
        if (message.type === "assetFetch") {
          const parsedRequest = omnicodeSharedAssetRequestSchema.safeParse(
            (message as { request?: unknown }).request,
          );
          const requestId = (message as { requestId?: unknown }).requestId;
          const reply = (result: { ok: boolean; dataBase64?: string; error?: string }) => {
            const socket = connectionsByProfileId.get(profileIdParam);
            if (socket && socket.readyState === 1) {
              socket.send(
                JSON.stringify({
                  type: "assetFetchResult",
                  ...(typeof requestId === "string" && requestId ? { assetRequestId: requestId } : {}),
                  assetResult: result,
                }),
              );
            }
          };
          if (!parsedRequest.success || typeof requestId !== "string" || !requestId) {
            reply({ ok: false, error: "asset_request" });
            return;
          }
          void Promise.resolve()
            .then(() =>
              managerHooks?.onSharedAssetFetchRequest?.(profileIdParam, parsedRequest.data),
            )
            .then((result) =>
              reply(result ?? { ok: false, error: "asset_unavailable" }),
            )
            .catch((error: unknown) =>
              reply({
                ok: false,
                error: error instanceof Error && error.message ? error.message : "asset_fetch",
              }),
            );
          return;
        }
        // [OmniCode] 模式二 R2：实例附加账号材料取回请求。先按 shared 契约校验载荷形态
        //（accountId 白名单），再交管理器附加账号目录解密代理（钩子缺席=官方 flavor/
        // 未装配 → 结构化错误，实例 Host 回落 local 来源提供者）。应答只回请求实例；
        // 首参 = 桥握手已验连接真身（管理器据此排除请求方自身的主账号材料）。
        if (message.type === "accountMaterial") {
          const parsedRequest = omnicodeAccountMaterialRequestPayloadSchema.safeParse(
            (message as { request?: unknown }).request,
          );
          const requestId = (message as { requestId?: unknown }).requestId;
          const reply = (result: { ok: boolean; dataBase64?: string; error?: string }) => {
            const socket = connectionsByProfileId.get(profileIdParam);
            if (socket && socket.readyState === 1) {
              socket.send(
                JSON.stringify({
                  type: "accountMaterialResult",
                  ...(typeof requestId === "string" && requestId
                    ? { accountRequestId: requestId }
                    : {}),
                  accountResult: result,
                }),
              );
            }
          };
          if (!parsedRequest.success || typeof requestId !== "string" || !requestId) {
            reply({ ok: false, error: "account_material_request" });
            return;
          }
          void Promise.resolve()
            .then(() =>
              managerHooks?.onAccountMaterialRequest?.(profileIdParam, parsedRequest.data),
            )
            .then((result) =>
              reply(result ?? { ok: false, error: "account_material_unavailable" }),
            )
            .catch((error: unknown) =>
              reply({
                ok: false,
                error:
                  error instanceof Error && error.message
                    ? error.message
                    : "account_material_fetch",
              }),
            );
          return;
        }
        // [OmniCode] 模式二 R3：实例附加账号目录元数据查询。管理器是唯一枚举权威（钩子
        // 内逐 profile 只读枚举并裁剪为元数据 only）；钩子缺席（官方 flavor/未装配）回
        // 结构化错误，实例侧目录显示为空。应答只回请求实例（requestId 关联）。
        if (message.type === "accountDirectoryList") {
          const requestId = (message as { requestId?: unknown }).requestId;
          const reply = (result: { ok: boolean; accounts?: unknown[]; error?: string }) => {
            const socket = connectionsByProfileId.get(profileIdParam);
            if (socket && socket.readyState === 1) {
              socket.send(
                JSON.stringify({
                  type: "accountDirectoryListResult",
                  ...(typeof requestId === "string" && requestId
                    ? { accountDirectoryRequestId: requestId }
                    : {}),
                  accountDirectoryResult: result,
                }),
              );
            }
          };
          if (typeof requestId !== "string" || !requestId) {
            reply({ ok: false, error: "account_directory_request" });
            return;
          }
          void Promise.resolve()
            .then(() => managerHooks?.onAccountDirectoryListRequest?.(profileIdParam))
            .then((result) =>
              reply(result ?? { ok: false, error: "account_directory_unavailable" }),
            )
            .catch((error: unknown) =>
              reply({
                ok: false,
                error:
                  error instanceof Error && error.message ? error.message : "account_directory_fetch",
              }),
            );
          return;
        }
        // [OmniCode] D12 接管流上行（观察者发起 / 持有者回执 / 观察者取消）。载荷校验与
        // 授权（连接身份绑定）在协调器内完成；钩子缺席（官方 flavor / 未装配）静默丢弃。
        if (
          message.type === "takeoverRequest" ||
          message.type === "takeoverReply" ||
          message.type === "takeoverCancel"
        ) {
          if (message.type === "takeoverRequest") {
            void managerHooks?.onTakeoverRequestFromInstance?.(profileIdParam, parsed);
          } else if (message.type === "takeoverReply") {
            managerHooks?.onTakeoverReplyFromInstance?.(profileIdParam, parsed);
          } else {
            managerHooks?.onTakeoverCancelFromInstance?.(profileIdParam, parsed);
          }
          return;
        }
        // [OmniCode] 丙1 远程聚合 R3：workspace-list 目录上行（Result 应答 / Report 报告）。
        // 桥服务侧先按 shared union 校验（条目逐条 schema + 200 上限——防异常快照放大桥
        // 载荷），再交管理器目录（来源绑定桥握手真身，载荷自报值不参与授权）。
        if (
          message.type === "remoteWorkspaceListResult" ||
          message.type === "remoteWorkspaceListReport"
        ) {
          const uplink = omnicodeRemoteWorkspaceListUplinkSchema.safeParse(parsed);
          managerHooks?.onOmnicodeRemoteWorkspaceListUplink?.(
            profileIdParam,
            uplink.success ? uplink.data : null,
          );
          return;
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

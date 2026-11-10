/* oxlint-disable eslint(max-lines) -- Deep Link 路由必须在同一模块内保持协议校验和投递原子性。 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { app, BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import {
  type Locale,
  type OAuthProviderId,
  type OAuthStateRegistration,
  isOmnicodeProfileInstanceEnv,
  PlatformChannels,
} from "@zcode/shared";
import {
  extractWorkspaceOpenPath,
  extractShareImportCode,
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isWorkspaceOpenUrl,
  isShareImportUrl,
} from "./desktopDeepLinkUrl.js";
import { registerLinuxDeepLinkProtocol } from "./desktopLinuxDeepLinkRegistration.js";

interface DeepLinkLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface DeepLinkWorkspaceGateOptions {
  canOpenWorkspace?: (workspacePath: string) => boolean;
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  onWorkspaceOpenBlocked?: (workspacePath: string) => void;
  /** 业务窗口解析器；必须排除 CUA indicator 等 Main 辅助窗口。 */
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export interface ExternalWorkspaceOpenDialogCopy {
  buttons: [string, string];
  title: string;
  message: string;
  detail: (path: string) => string;
}

interface OAuthRouteTarget {
  windowId: number;
  provider?: OAuthProviderId;
}

const oauthStateToWindow = new Map<string, OAuthRouteTarget>();
const rendererReadyWebContentsIds = new Set<number>();
let pendingDeepLinkUrl: string | null = null;
let pendingPaymentDeepLinkUrl: string | null = null;
let pendingOpenWorkspaceRequest: {
  path: string;
  targetWebContentsId?: number;
} | null = null;
const pendingShareImports: { shareCode: string; targetWebContentsId?: number }[] = [];
const MAX_PENDING_SHARE_IMPORTS = 8;

function enqueuePendingShareImport(
  payload: { shareCode: string },
  targetWebContentsId?: number,
): void {
  if (
    pendingShareImports.some(
      (item) =>
        item.shareCode === payload.shareCode && item.targetWebContentsId === targetWebContentsId,
    )
  ) {
    return;
  }
  pendingShareImports.push(
    targetWebContentsId === undefined ? { ...payload } : { ...payload, targetWebContentsId },
  );
  if (pendingShareImports.length > MAX_PENDING_SHARE_IMPORTS) {
    pendingShareImports.shift();
  }
}

export function parseOAuthStateRegistration(payload: unknown): OAuthStateRegistration | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    state?: unknown;
    provider?: unknown;
  };

  if (typeof candidate.state !== "string" || candidate.state.trim() === "") {
    return null;
  }

  if (candidate.provider != null && typeof candidate.provider !== "string") {
    return null;
  }

  return {
    state: candidate.state.trim(),
    ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
  };
}

function focusDeepLinkTargetWindow(targetWindow: BrowserWindow): void {
  // macOS 的 open-url 回调只会把 URL 投递给当前实例，不会自动把窗口带回前台。
  // 之前这里只做了 IPC 转发，用户完成 OAuth 或从系统服务打开目录后仍停留在外部应用。
  // 这里在路由成功后显式激活并聚焦目标窗口，统一多平台回跳体验。
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (process.platform === "darwin") {
    app.show();
  }

  targetWindow.focus();
}

function hasOAuthAuthorizationCode(parsedUrl: URL): boolean {
  return parsedUrl.searchParams.has("code") || parsedUrl.searchParams.has("authCode");
}

// ============================================================================
// [OmniCode] zcode:// 跨实例投递（spec: docs/omnicode/instance-login-browser.md §任务2）
//
// 背景：zcode:// 的 OS 级注册是全局单点（registerDeepLinkProtocol 不带实例标识），
// OS 回调只会拉起"注册时的默认实例"。正常路径（内置授权窗口拦截 + 同实例
// oauthStateToWindow 路由）完全不受本段影响；这里只是"回调落到错误实例"这一
// 边缘场景的最后兜底：错误实例把回调 URL 落盘到跨实例共享目录，发起登录的
// 实例在自己 1s 轮询节奏里读取并按官方 handleDeepLink 路由。
// ============================================================================

/** [OmniCode] 与 services omnicode/workspaceLocks.ts getOmnicodeSharedRoot 语义一致：
 * OMNICODE_SHARED_ROOT 优先，否则 ~/.omnicode/shared。desktop 包不 import services
 * 实现，保持同一环境变量合同即可（两处独立实现、语义对齐）。 */
function resolveOmnicodeOAuthRelayDir(): string {
  const override = process.env.OMNICODE_SHARED_ROOT?.trim();
  const sharedRoot = override ? override : join(homedir(), ".omnicode", "shared");
  return join(sharedRoot, "oauth-callbacks");
}

/** OAuth state 由 oauthService randomBytes(32).toString("hex") 生成（64 位 hex）。
 * 文件名直接用 state，必须收紧为 hex 白名单防路径穿越。 */
function isSafeOmnicodeRelayState(state: string): boolean {
  return /^[0-9a-f]{16,64}$/u.test(state);
}

/** 把回调 URL 写入跨实例投递文件 `<state>.json`（{url, receivedAt}）。
 * 写入失败只降级为"未转投"，不阻断 handleDeepLink 其余分支。 */
function writeOmnicodeOAuthCallbackRelay(
  state: string,
  url: string,
  logger: DeepLinkLogger,
): boolean {
  if (!isSafeOmnicodeRelayState(state)) {
    logger.warn("[deep-link] OAuth 回调 state 非 hex 形状，跳过跨实例投递", { state });
    return false;
  }
  try {
    const relayDir = resolve(resolveOmnicodeOAuthRelayDir());
    mkdirSync(relayDir, { recursive: true });
    // resolve 后必须仍落在 relayDir 内，杜绝 state 携带 ../ 的路径越界。
    const relayPath = resolve(join(relayDir, `${state}.json`));
    if (!relayPath.startsWith(relayDir + "\\") && !relayPath.startsWith(relayDir + "/")) {
      logger.warn("[deep-link] OAuth 回调投递路径越界，已拒绝", { state });
      return false;
    }
    writeFileSync(relayPath, JSON.stringify({ url, receivedAt: Date.now() }), "utf8");
    logger.info("[deep-link] OAuth 回调不属于本实例，已写入跨实例投递文件等待发起方消费", {
      state,
      relayPath,
    });
    return true;
  } catch (error) {
    logger.warn("[deep-link] OAuth 回调跨实例投递写入失败", {
      state,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 读取投递目录并消费：state 与本进程 oauthStateToWindow 匹配 → 官方 handleDeepLink
 * 路由后删除文件；不匹配的文件超 60s 懒删除（最后兜底，正常路径不产生这些文件）。
 * @returns 目录里是否仍有未清理文件（供消费定时器决定是否继续运行）。 */
function consumeOmnicodeOAuthCallbackRelayFiles(logger: DeepLinkLogger): boolean {
  const relayDir = resolveOmnicodeOAuthRelayDir();
  let entries: string[];
  try {
    entries = readdirSync(relayDir);
  } catch {
    // 目录不存在 = 没有任何投递，最常见路径。
    return false;
  }

  let hasRemainingFiles = false;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const state = entry.slice(0, -".json".length);
    if (!isSafeOmnicodeRelayState(state)) {
      continue;
    }
    const relayPath = resolve(join(relayDir, entry));
    if (oauthStateToWindow.has(state)) {
      let relayedUrl: string | null = null;
      try {
        const parsed = JSON.parse(readFileSync(relayPath, "utf8")) as { url?: unknown };
        if (typeof parsed?.url === "string" && parsed.url.trim() !== "") {
          relayedUrl = parsed.url;
        }
      } catch (error) {
        logger.warn("[deep-link] OAuth 投递文件解析失败，已删除", {
          state,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (relayedUrl) {
        // 走官方 handleDeepLink：state 校验 + 路由到发起窗口，与窗口拦截路径零差异。
        const accepted = handleDeepLink(relayedUrl, logger);
        if (accepted) {
          try {
            rmSync(relayPath, { force: true });
          } catch (error) {
            logger.warn("[deep-link] OAuth 投递文件删除失败（下轮重试）", { state, error });
            hasRemainingFiles = true;
          }
          continue;
        }
        // 目标窗口尚未就绪：保留文件，下一轮 tick 重试（handleDeepLink 已缓存 pending）。
        hasRemainingFiles = true;
        continue;
      }
      try {
        rmSync(relayPath, { force: true });
      } catch {
        // 清理失败留给下一轮。
        hasRemainingFiles = true;
      }
      continue;
    }

    // 非本进程的 state：懒清理（>60s 删除），不主动消费。
    try {
      const stats = statSync(relayPath);
      if (now - stats.mtimeMs > 60_000) {
        rmSync(relayPath, { force: true });
        logger.info("[deep-link] 清理过期 OAuth 跨实例投递文件", { state });
      } else {
        hasRemainingFiles = true;
      }
    } catch {
      // 文件已被其他实例消费/清理，忽略。
    }
  }
  return hasRemainingFiles;
}

let omnicodeRelayConsumerTimer: ReturnType<typeof setInterval> | null = null;
let omnicodeRelayConsumerLogger: DeepLinkLogger | null = null;

/** 发起登录（registerOAuthState）时拉起 1s 消费 tick，与 renderer 官方 1s 轮询同节奏；
 * 本进程没有进行中的 OAuth flow 且投递目录已空时自动停表，不常驻。 */
export function startOmnicodeOAuthCallbackRelayConsumer(logger: DeepLinkLogger): void {
  omnicodeRelayConsumerLogger = logger;
  if (omnicodeRelayConsumerTimer) {
    return;
  }
  omnicodeRelayConsumerTimer = setInterval(() => {
    const consumerLogger = omnicodeRelayConsumerLogger;
    if (!consumerLogger) {
      return;
    }
    let hasRemainingFiles = false;
    try {
      hasRemainingFiles = consumeOmnicodeOAuthCallbackRelayFiles(consumerLogger);
    } catch (error) {
      consumerLogger.warn("[deep-link] OAuth 跨实例投递消费 tick 异常", { error });
    }
    if (oauthStateToWindow.size === 0 && !hasRemainingFiles) {
      const timer = omnicodeRelayConsumerTimer;
      omnicodeRelayConsumerTimer = null;
      if (timer) {
        clearInterval(timer);
      }
    }
  }, 1_000);
  omnicodeRelayConsumerTimer.unref?.();
}

/**
 * 失败态恢复入口的粘贴 URL 归一化（spec §任务1）：官方 handleDeepLink 只识别
 * zcode://oauth/callback 形状；外部浏览器回调可能落在本地回环端口的 http 形状。
 * 这里把 http://localhost:1455/auth/callback?… 重写为 zcode://oauth/callback?…
 * （仅保留 query），其余形状原样返回交给 handleDeepLink 自行校验。
 */
export function normalizePastedOmnicodeCallbackUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed === "") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (isOAuthCallbackUrl(parsed)) {
    return trimmed;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1") {
    return null;
  }
  if (parsed.port !== "1455") {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  if (path !== "/auth/callback") {
    return null;
  }
  const normalized = new URL("zcode://oauth/callback");
  for (const [key, value] of parsed.searchParams) {
    normalized.searchParams.append(key, value);
  }
  return normalized.toString();
}

export function isValidLocalWorkspaceDirectory(path: string): boolean {
  if (!path || path.includes("\0") || isNetworkWorkspacePath(path) || !isAbsolute(path)) {
    return false;
  }

  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isNetworkWorkspacePath(path: string): boolean {
  // 仅当原路径以 // 或 \\ 开头时规范化后才会以 \\ 开头；
  // 单 / 的 Unix 绝对路径不会被误判为 UNC 网络路径。
  const normalized = path.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\") || /^\\\\\?\\UNC\\/iu.test(normalized);
}

export function resolveExternalWorkspaceOpenDialogCopy(
  locale: Locale,
): ExternalWorkspaceOpenDialogCopy {
  // TODO(i18n): 新增 Locale 时把这里收敛成完整 Record<Locale, ...>，
  // 避免未覆盖语言静默回退英文。
  if (locale === "zh-CN") {
    return {
      buttons: ["打开文件夹", "取消"],
      title: "打开外部 ZCode 链接？",
      message: "是否在 ZCode 中打开此文件夹？",
      detail: (path) => `${path}\n\n只打开你信任来源的文件夹。项目设置可能影响 agent runtime。`,
    };
  }

  return {
    buttons: ["Open folder", "Cancel"],
    title: "Open external ZCode link?",
    message: "Open this folder in ZCode?",
    detail: (path) =>
      `${path}\n\nOnly open folders from sources you trust. Project settings may affect the agent runtime.`,
  };
}

export function confirmExternalWorkspaceOpen(
  path: string,
  logger: { warn: (...args: unknown[]) => void },
  parentWindow: BrowserWindow | null,
  copy: ExternalWorkspaceOpenDialogCopy = resolveExternalWorkspaceOpenDialogCopy("en-US"),
): boolean {
  const options = {
    type: "warning" as const,
    buttons: copy.buttons,
    defaultId: 1,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail(path),
    noLink: true,
  };
  const response = parentWindow
    ? dialog.showMessageBoxSync(parentWindow, options)
    : dialog.showMessageBoxSync(options);
  const confirmed = response === 0;
  if (!confirmed) {
    logger.warn("[deep-link] 用户取消打开外部链接工作区", { path });
  }
  return confirmed;
}

export function handleOpenWorkspacePath(
  path: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: {
    allowWithoutReadyWindow?: boolean;
    resolveApplicationWindow?: () => BrowserWindow | null;
  } = {},
): boolean {
  if (!isValidLocalWorkspaceDirectory(path)) {
    logger.warn("[deep-link] 打开工作区路径无效，已忽略", { path });
    return false;
  }

  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  if (targetWindow) {
    const targetWebContentsId = targetWindow.webContents.id;
    if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
      pendingOpenWorkspaceRequest = {
        path,
        targetWebContentsId,
      };
      focusDeepLinkTargetWindow(targetWindow);
      // 冷启动 argv deep link 会在主窗口创建后、renderer 注册
      // onOpenWorkspacePath 之前到达。此时直接 webContents.send 会丢 IPC，
      // 必须等 renderer 主动上报 ready 后再投递目录路径。
      logger.warn("[deep-link] 工作区打开请求命中未就绪窗口，先缓存等待 renderer ready", {
        windowId: targetWebContentsId,
        path,
      });
      return true;
    }

    targetWindow.webContents.send(PlatformChannels.OpenWorkspacePath, path);
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] 工作区打开请求路由成功", {
      windowId: targetWebContentsId,
      path,
    });
    return true;
  }

  if (!options.allowWithoutReadyWindow) {
    logger.warn("[deep-link] 工作区打开请求暂未命中窗口，已忽略", { path });
    return false;
  }

  pendingOpenWorkspaceRequest = { path };
  logger.warn("[deep-link] 工作区打开请求暂未命中窗口，先缓存等待 renderer ready", { path });
  return false;
}

export function handleDeepLink(
  url: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: DeepLinkWorkspaceGateOptions = {},
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn("[deep-link] 无法解析 URL:", url);
    return false;
  }

  if (isWorkspaceOpenUrl(parsedUrl)) {
    const workspacePath = extractWorkspaceOpenPath(parsedUrl);
    if (!workspacePath) {
      logger.warn("[deep-link] 工作区打开请求缺少 path，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }

    if (isNetworkWorkspacePath(workspacePath)) {
      // Windows UNC 路径在 statSync 校验阶段就会触发 SMB 认证。
      // deep link 是外部输入，必须在任何文件系统探测前拒绝网络路径。
      logger.warn("[deep-link] 网络工作区路径已拒绝", { path: workspacePath });
      return false;
    }

    if (options.canOpenWorkspace && !options.canOpenWorkspace(workspacePath)) {
      // 强制升级是进程级 gate，workspace deep link 不能先进入缓存/投递路径。
      logger.warn("[deep-link] 工作区打开请求被当前启动 gate 阻止", { path: workspacePath });
      options.onWorkspaceOpenBlocked?.(workspacePath);
      return true;
    }

    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    // zcode://workspace/open 来自浏览器/IM 等外部应用，不能等同于用户在
    // ZCode 内部选择目录；确认必须发生在 statSync 之前，避免项目配置被静默信任。
    if (
      !confirmExternalWorkspaceOpen(workspacePath, logger, targetWindow, options.confirmationCopy)
    ) {
      return true;
    }

    return handleOpenWorkspacePath(workspacePath, logger, {
      allowWithoutReadyWindow: true,
      resolveApplicationWindow: options.resolveApplicationWindow,
    });
  }

  if (isPaymentCallbackUrl(parsedUrl)) {
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      targetWindow.webContents.send(PlatformChannels.PaymentCallback, url);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] 支付回调路由成功", {
        windowId: targetWindow.webContents.id,
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return true;
    }

    pendingPaymentDeepLinkUrl = url;
    logger.warn("[deep-link] 支付回调暂未命中窗口，先缓存等待 renderer ready", {
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  if (isShareImportUrl(parsedUrl)) {
    const shareCode = extractShareImportCode(parsedUrl);
    if (!shareCode) {
      logger.warn("[deep-link] share import code 无效，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }
    const payload = { shareCode };
    // share 分支也必须走 resolveApplicationWindow——聚焦兜底
    // getAllWindows()[0] 会命中 CUA indicator 等辅助窗口；且 pending 队列必须绑定目标窗口，
    // 否则多窗口时导入会投递给先 ready 的 renderer，写入错误 workspace 的 .zcode-share。
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      if (!rendererReadyWebContentsIds.has(targetWindow.webContents.id)) {
        enqueuePendingShareImport(payload, targetWindow.webContents.id);
        focusDeepLinkTargetWindow(targetWindow);
        logger.info("[deep-link] share import 等待 renderer ready", {
          windowId: targetWindow.webContents.id,
        });
        return true;
      }
      targetWindow.webContents.send(PlatformChannels.ShareImport, payload);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] share import 路由成功", {
        windowId: targetWindow.webContents.id,
      });
      return true;
    }
    enqueuePendingShareImport(payload);
    logger.info("[deep-link] share import 等待主窗口");
    return false;
  }

  if (!isOAuthCallbackUrl(parsedUrl)) {
    return false;
  }

  const state = parsedUrl.searchParams.get("state");
  if (!state) {
    logger.warn("[deep-link] OAuth 回调缺少 state，忽略此次回调", {
      protocol: parsedUrl.protocol,
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  const routeTarget = oauthStateToWindow.get(state);
  const targetWindow = routeTarget
    ? BrowserWindow.getAllWindows().find((window) => window.webContents.id === routeTarget.windowId)
    : null;
  const shouldCompleteOAuthRoute = hasOAuthAuthorizationCode(parsedUrl);

  if (targetWindow) {
    targetWindow.webContents.send(PlatformChannels.OAuthCallback, url);
    if (shouldCompleteOAuthRoute) {
      oauthStateToWindow.delete(state);
    }
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] OAuth 回调路由成功", {
      state,
      windowId: targetWindow.webContents.id,
      provider: routeTarget?.provider,
      completed: shouldCompleteOAuthRoute,
    });
    return true;
  }

  // [OmniCode] 跨实例改道（spec §任务2，最后兜底）：OS 级 zcode:// 注册是全局单点，
  // 回调可能落到未发起本次登录的 Profile 实例。state 不在 oauthStateToWindow 说明
  // 发起方是另一实例/控制台——写入跨实例投递文件，由发起方实例在自己 1s 消费
  // tick（startOmnicodeOAuthCallbackRelayConsumer）里走官方 handleDeepLink 路由。
  // 正常路径（内置窗口拦截 + 同实例路由）不进入此分支。
  if (!routeTarget && isOmnicodeProfileInstanceEnv()) {
    if (writeOmnicodeOAuthCallbackRelay(state, url, logger)) {
      return true;
    }
  }

  pendingDeepLinkUrl = url;
  logger.warn("[deep-link] OAuth 回调未命中目标窗口，先缓存等待 renderer ready", {
    state,
    hasRouteTarget: Boolean(routeTarget),
  });
  return false;
}

export function registerDeepLinkProtocol(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: { iconPath?: string } = {},
) {
  const scheme = "zcode";

  // 外部 URL 必须位于 -- 后；否则 Windows 引号拆分可把 URL 内容变成 Electron 启动参数。
  // Inspector 早于应用 JS 和单实例锁启动，不能依赖后续 handleDeepLink 校验拦截。
  if (process.defaultApp && process.argv.length >= 2) {
    const entry = resolve(process.argv[1]!);
    const args = process.platform === "win32" ? [entry, "--"] : [entry];
    const ok = app.setAsDefaultProtocolClient(scheme, process.execPath, args);
    if (!ok) {
      logger.warn("[deep-link] 注册协议失败（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    } else {
      logger.info("[deep-link] 注册协议成功（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    }
    return;
  }

  const ok =
    process.platform === "win32"
      ? app.setAsDefaultProtocolClient(scheme, process.execPath, ["--"])
      : app.setAsDefaultProtocolClient(scheme);
  if (!ok) {
    logger.warn("[deep-link] 注册协议失败", { scheme });
  } else {
    logger.info("[deep-link] 注册协议成功", { scheme });
  }

  if (process.platform === "linux" && app.isPackaged) {
    registerLinuxDeepLinkProtocol({
      executablePath: process.execPath,
      homeDir: app.getPath("home"),
      productName: app.name,
      iconSourcePath: options.iconPath,
      env: process.env,
      argv: process.argv,
      logger,
    });
  }
}

export function registerOAuthState(windowId: number, registration: OAuthStateRegistration): void {
  oauthStateToWindow.set(registration.state, {
    windowId,
    provider: registration.provider,
  });

  setTimeout(() => oauthStateToWindow.delete(registration.state), 5 * 60 * 1000);
}

export function deliverPendingDeepLink(webContents: WebContents): boolean {
  rendererReadyWebContentsIds.add(webContents.id);

  const hasPendingOAuthCallback = pendingDeepLinkUrl != null;
  // pending share import 绑定目标窗口后，只投递给目标窗口（或冷启动时未绑定目标的
  // 条目）；非目标窗口 ready 时保留条目，否则导入会写进错误窗口的 workspace。
  const undeliveredShareImports: typeof pendingShareImports = [];
  for (const pending of pendingShareImports.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.ShareImport, { shareCode: pending.shareCode });
    } else {
      undeliveredShareImports.push(pending);
    }
  }
  pendingShareImports.push(...undeliveredShareImports);
  if (hasPendingOAuthCallback) {
    webContents.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl);
    pendingDeepLinkUrl = null;
  }
  if (pendingPaymentDeepLinkUrl) {
    webContents.send(PlatformChannels.PaymentCallback, pendingPaymentDeepLinkUrl);
    pendingPaymentDeepLinkUrl = null;
  }
  if (
    pendingOpenWorkspaceRequest &&
    (pendingOpenWorkspaceRequest.targetWebContentsId == null ||
      pendingOpenWorkspaceRequest.targetWebContentsId === webContents.id)
  ) {
    webContents.send(PlatformChannels.OpenWorkspacePath, pendingOpenWorkspaceRequest.path);
    pendingOpenWorkspaceRequest = null;
  }
  return hasPendingOAuthCallback;
}

export function clearOAuthRoutesForWindow(windowId: number): void {
  rendererReadyWebContentsIds.delete(windowId);
  if (pendingOpenWorkspaceRequest?.targetWebContentsId === windowId) {
    pendingOpenWorkspaceRequest = null;
  }
  // pending share import 绑定目标窗口后，目标窗口关闭必须同步清理，
  // 否则队列条目永不过期，可能投递给后续 ready 的其他窗口（错误 workspace）。
  for (let index = pendingShareImports.length - 1; index >= 0; index -= 1) {
    if (pendingShareImports[index]!.targetWebContentsId === windowId) {
      pendingShareImports.splice(index, 1);
    }
  }

  for (const [state, routeTarget] of oauthStateToWindow) {
    if (routeTarget.windowId === windowId) {
      oauthStateToWindow.delete(state);
    }
  }
}

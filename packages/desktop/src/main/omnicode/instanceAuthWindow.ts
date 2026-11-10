// [OmniCode] 实例专属授权窗口（M1.5）：登录、授权、zcode:// 回调全程封闭在实例自己的
// 浏览器窗口内，不再落到系统默认浏览器。spec: docs/omnicode/instance-login-browser.md。
//
// 安全边界：
// - 持久分区 persist:omnicode-auth-<profileId>（数据落实例自己的 electron-userdata/Partitions/）；
// - contextIsolation/sandbox 开启、nodeIntegration 关闭；
// - zcode:// 回调经依赖注入的 onZcodeCallback（官方 handleDeepLink）校验 state 并路由，
//   本模块不解析不存储任何 OAuth 状态；非 https 导航与一切弹窗全部拒绝；
// - 300s 超时销毁（renderer 侧官方轮询超时自行收口登录 UI）。
// 依赖注入设计：本模块属于 managed 模块 omnicode-profile-runtime，不直接导入 desktop
// 内部实现（handleDeepLink 由调用方注入），避免跨模块依赖违规。
import { BrowserWindow } from "electron";
import { isOmnicodeProfileId } from "@zcode/shared";

export interface OmnicodeInstanceAuthWindowLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface OpenOmnicodeInstanceAuthWindowInput {
  url: string;
  profileId: string;
  logger: OmnicodeInstanceAuthWindowLogger;
  /** zcode:// 回调处理（官方 handleDeepLink）；返回 true 表示回调已被官方链路接收。 */
  onZcodeCallback: (callbackUrl: string) => boolean;
}

const WINDOW_WIDTH = 920;
const WINDOW_HEIGHT = 720;
const WINDOW_MIN_WIDTH = 640;
const WINDOW_MIN_HEIGHT = 560;
/** 与官方 OAuth 登录会话有效期一致（300s）。 */
const AUTH_WINDOW_TIMEOUT_MS = 300_000;

let currentWindow: BrowserWindow | null = null;
let currentTimeout: NodeJS.Timeout | null = null;

function destroyCurrent(reason: string): void {
  if (currentTimeout) {
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }
  if (currentWindow && !currentWindow.isDestroyed()) {
    currentWindow.destroy();
    currentWindow = null;
  }
  if (reason) {
    // 保留日志钩子；正常关闭与超时都走这里。
  }
}

export function openOmnicodeInstanceAuthWindow(input: OpenOmnicodeInstanceAuthWindowInput): {
  ok: boolean;
} {
  const { url, logger, onZcodeCallback } = input;
  const profileId = input.profileId.trim();
  if (!isOmnicodeProfileId(profileId)) {
    logger.warn("[omnicode-auth-window] 非法 profileId，拒绝打开授权窗口");
    return { ok: false };
  }

  // 同一实例同时只允许一个授权窗口：新调用销毁旧窗口（与 Cockpit 行为一致）
  destroyCurrent("");

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: "OmniCode 实例授权",
    center: true,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `persist:omnicode-auth-${profileId}`,
    },
  });
  currentWindow = win;

  currentTimeout = setTimeout(() => {
    logger.warn("[omnicode-auth-window] 授权超时（300s），窗口已关闭");
    destroyCurrent("timeout");
  }, AUTH_WINDOW_TIMEOUT_MS);
  currentTimeout.unref?.();

  const finish = (): void => {
    destroyCurrent("done");
  };

  const handleZcodeCallback = (candidateUrl: string): boolean => {
    if (!candidateUrl.startsWith("zcode:")) return false;
    const accepted = onZcodeCallback(candidateUrl);
    logger.info(
      accepted
        ? "[omnicode-auth-window] 已拦截 zcode:// 回调并交由官方链路处理，关闭授权窗口"
        : "[omnicode-auth-window] zcode:// 回调未被官方链路接收（state 不匹配或已过期）",
    );
    finish();
    return true;
  };

  // 主导航与重定向两条路径都拦：zcode:// 一律 preventDefault（阻止系统浏览器/OS handler 接管）
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (handleZcodeCallback(targetUrl)) {
      event.preventDefault();
    }
  });
  win.webContents.on("will-redirect", (event, targetUrl) => {
    if (handleZcodeCallback(targetUrl)) {
      event.preventDefault();
    }
  });
  // 一切弹窗全拒（v0 限制：强依赖弹窗的第三方登录入口不可用，见 spec 已知限制）
  win.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn(`[omnicode-auth-window] 已拒绝授权窗口内的弹窗请求: ${url}`);
    return { action: "deny" };
  });
  win.webContents.on("render-process-gone", () => {
    destroyCurrent("render-gone");
  });
  win.on("closed", () => {
    destroyCurrent("closed");
  });

  void win.loadURL(url);
  logger.info(`[omnicode-auth-window] 已打开实例专属授权窗口: profileId=${profileId}`);
  return { ok: true };
}

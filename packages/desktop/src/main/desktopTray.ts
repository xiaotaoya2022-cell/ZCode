import { app, Menu, Tray, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  formatDesktopMenuMessage,
  getDesktopMenuMessage,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";

let desktopTray: Tray | null = null;
let rebuildDesktopTrayContextMenu: (() => void) | null = null;

export function resolveDesktopTrayIconPath(platform: NodeJS.Platform = process.platform) {
  // Linux 托盘只接受 PNG（.ico 不会渲染）；打包态 icon.png 已由 extraResources 无条件放入
  // resources 目录（electron-builder.config.js），Windows 继续用独立托盘 .ico 避免高 DPI 模糊。
  if (platform === "linux") {
    return app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build/icon.png");
  }
  return app.isPackaged
    ? join(process.resourcesPath, "tray_icon.ico")
    : join(import.meta.dirname, "../../build/icon.ico");
}

export function createDesktopTray(options: {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  showCurrentWindow: () => Promise<void> | void;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  quitApp: () => void;
  logger: { warn: (...args: unknown[]) => void };
  /**
   * [OmniCode] 批次2.5 X3：实例快捷菜单区提供者（仅 omnicode 管理器主进程注入；
   * 返回空数组=无实例区，官方 flavor 零影响。spec: docs/omnicode/console-extras.md §X3）。
   */
  buildOmnicodeSection?: () => MenuItemConstructorOptions[];
  /**
   * [OmniCode] 实例元数据批次：omnicode 管理器托盘 tooltip 的运行实例数提供者（动态 N）。
   * 仅管理器主进程注入（index.ts 与 buildOmnicodeSection 同一 flavor 门控）；官方 flavor /
   * omnicode 实例进程不注入 → tooltip 与「打开」文案保持官方分支原样（红线：官方零改动；
   * 实例窗口保持 ZCode 语义）。omnicode 管理器 tooltip = `OmniCode · N 个实例运行中`，
   * 「打开」文案 = 「打开 OmniCode」。
   */
  omnicodeRunningCount?: () => number;
}) {
  const platform = options.platform ?? process.platform;
  // Linux 驻留能力由 createCloseToTrayCapabilityMonitor 探测决定（spec：
  // docs/desktop/linux-close-to-tray.md）；这里只挡平台，能力不过关时调用方不应传入 linux。
  if (platform !== "win32" && platform !== "linux") {
    return null;
  }

  if (desktopTray) {
    return desktopTray;
  }

  try {
    desktopTray = new Tray(resolveDesktopTrayIconPath(platform));
  } catch (error) {
    options.logger.warn("[desktop-tray] failed to create tray icon", error);
    return null;
  }

  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuMessage(options.getLocale(), id);
  const showTrayWindow = () => {
    void Promise.resolve(options.showCurrentWindow()).catch((error) => {
      options.logger.warn("[desktop-tray] failed to show current window", error);
    });
  };
  const executeTrayCommand = (command: DesktopCommandId) => {
    void Promise.resolve(options.showCurrentWindow())
      .then(() => options.executeDesktopCommand(command))
      .catch((error) => {
        options.logger.warn(`[desktop-tray] failed to execute tray command ${command}`, error);
      });
  };
  const rebuildContextMenu = () => {
    // [OmniCode] 实例元数据批次：tooltip 品牌名——omnicode 管理器（omnicodeRunningCount
    // option 注入且 flavor=omnicode）为 `OmniCode · N 个实例运行中`（N 动态，重建时实时
    // 取数；启动/停止/改名链路经 updateWindowsDesktopTrayMenu 触发重建即刷新）；其余
    //（官方 flavor 与 omnicode 实例进程）保持官方 "ZCode" 原样。
    const isOmnicodeManagerTray =
      ZCODE_PRODUCT_FLAVOR === "omnicode" && typeof options.omnicodeRunningCount === "function";
    desktopTray?.setToolTip(
      isOmnicodeManagerTray
        ? formatDesktopMenuMessage(options.getLocale(), desktopMenuMessageIds.trayTooltipOmniCodeRunning, {
            count: options.omnicodeRunningCount!(),
          })
        : getLabel(desktopMenuMessageIds.trayTooltip),
    );
    // [OmniCode] 批次2.5 X3：实例快捷菜单区（运行实例/启动全部/停止全部）插在「打开」
    // 之后；提供者返回空数组时完全无痕（官方 flavor 不注入）。
    const omnicodeSection = options.buildOmnicodeSection?.() ?? [];
    desktopTray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          // [OmniCode] 实例元数据批次：omnicode 管理器托盘菜单残留纯 "ZCode" 文案清理
          // ——「打开 ZCode」→「打开 OmniCode」；仅管理器分支（官方与实例进程原样）。
          label: isOmnicodeManagerTray
            ? getLabel(desktopMenuMessageIds.trayOpenOmniCode)
            : getLabel(desktopMenuMessageIds.trayOpenZCode),
          click: showTrayWindow,
        },
        ...(omnicodeSection.length > 0
          ? [{ type: "separator" as const }, ...omnicodeSection]
          : []),
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          click: () => executeTrayCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          click: () => executeTrayCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" },
        // 更新入口跟随产品身份：Preview（含生产后端的 Preview）禁用更新器，托盘也不能露出入口。
        ...(ZCODE_PRODUCT_FLAVOR === "production"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                click: () => executeTrayCommand(DesktopCommandIds.CheckForUpdates),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpAbout),
          click: () => executeTrayCommand(DesktopCommandIds.ShowAbout),
        },
        {
          // 托盘只提供日志诊断入口，避免右键菜单暴露清除全部数据操作；复用应用菜单导出命令。
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => executeTrayCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.trayQuit),
          click: () => options.quitApp(),
        },
      ]),
    );
  };

  rebuildDesktopTrayContextMenu = rebuildContextMenu;
  desktopTray.on("click", showTrayWindow);
  desktopTray.on("double-click", showTrayWindow);
  rebuildContextMenu();

  return desktopTray;
}

export function updateWindowsDesktopTrayMenu() {
  rebuildDesktopTrayContextMenu?.();
}

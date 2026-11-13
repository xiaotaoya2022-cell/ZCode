// [OmniCode] 批次2.5 X3：托盘实例快捷菜单（spec: docs/omnicode/console-extras.md §X3）。
//
// 不新建第二个 Tray——扩展现有 desktopTray：createDesktopTray 注入可选 buildOmnicodeSection
//（仅 omnicode 管理器主进程），返回实例区菜单项。菜单结构 = 运行实例区（点击=聚焦该实例：
// 显示管理器主窗口 + 桥 focus 命令拉起实例窗口 + 广播 focusRequested 让网格滚动定位卡片）
// + 启动全部/停止全部；「打开控制台/退出」沿用既有托盘项（退出走既有 quitApp →
// prepareAppQuit 屏障，屏障内已 await releaseOmnicodeEmbedForQuit，无新增退出路径）。
//
// 动态重建：instanceManager 运行态变化订阅 → 刷新实例名缓存（profile.json，异步）→
// updateWindowsDesktopTrayMenu()（500ms 去抖吸收 launch/stop 风暴）。
//
// 依赖说明：import desktop 主树 desktopTray 与 instanceBridgeClient import
// desktopWindowSize 同款（omnicode-profile-runtime 已声明 desktop 依赖，module.ts/policy 同步）。
import type { MenuItemConstructorOptions } from "electron";
import { updateWindowsDesktopTrayMenu } from "../desktopTray.js";
import {
  broadcastOmnicodeInstanceEvent,
  sendOmnicodeInstanceCommand,
} from "./instanceBridgeServer.js";
import {
  launchAllOmnicodeProfiles,
  listOmnicodeRunningInstances,
  stopAllOmnicodeInstances,
  subscribeOmnicodeRunningStateChanges,
} from "./instanceManager.js";
import { listOmnicodeProfiles } from "./profileRuntime.js";

/** 去抖窗口：launch/stop 风暴下每次状态变化只重建一次菜单。 */
const TRAY_REBUILD_DEBOUNCE_MS = 500;

// ─── 菜单模型（纯函数，单测登记 engineering-test-files.json） ───

export interface OmnicodeTrayInstanceEntry {
  profileId: string;
  name: string;
}

/**
 * 托盘实例区菜单模型（序列化纯函数）：每运行实例一项（label=状态点+实例名——● 前缀
 * 让菜单文本自带运行态语义）+ 启动全部（无停止实例时禁用）/ 停止全部（无运行实例时
 * 禁用）。isZh 由装配方按 locale 传入（与 instanceManager 工作区路由 deps.isZh 同约定：
 * main 侧无 i18n 机制，双语文案在此内联）。
 */
export function buildOmnicodeTraySectionModel(input: {
  instances: readonly OmnicodeTrayInstanceEntry[];
  profileCount: number;
  isZh: boolean;
}): {
  instanceItems: { profileId: string; label: string }[];
  launchAllLabel: string;
  launchAllEnabled: boolean;
  stopAllLabel: string;
  stopAllEnabled: boolean;
} {
  return {
    instanceItems: input.instances.map((entry) => ({
      profileId: entry.profileId,
      label: `● ${entry.name}`,
    })),
    launchAllLabel: input.isZh ? "启动全部" : "Launch all",
    launchAllEnabled: input.instances.length < input.profileCount,
    stopAllLabel: input.isZh ? "停止全部" : "Stop all",
    stopAllEnabled: input.instances.length > 0,
  };
}

// ─── 装配（模块态：名称缓存 + 订阅去抖重建） ───

const nameByProfileId = new Map<string, string>();
let rebuildTimer: NodeJS.Timeout | null = null;
let showConsoleWindow: (() => void) | null = null;
let isZhReader: (() => boolean) | null = null;
let wired = false;

async function refreshNameCache(): Promise<void> {
  try {
    const profiles = await listOmnicodeProfiles();
    nameByProfileId.clear();
    for (const profile of profiles) nameByProfileId.set(profile.id, profile.name);
  } catch {
    // 名称缓存刷新失败保留旧值（菜单项以 profileId 兜底显示）
  }
}

function currentTrayInstances(): OmnicodeTrayInstanceEntry[] {
  return listOmnicodeRunningInstances().map((entry) => ({
    profileId: entry.profileId,
    name: nameByProfileId.get(entry.profileId) ?? entry.profileId,
  }));
}

function focusInstanceFromTray(profileId: string): void {
  // 聚焦链路（spec §X3）：显示管理器主窗口 + 桥 focus 拉起实例窗口（与卡片「聚焦」
  // 菜单同一链路）+ 广播 focusRequested（renderer 网格滚动定位并短暂高亮对应卡片）。
  showConsoleWindow?.();
  broadcastOmnicodeInstanceEvent({ profileId, type: "focusRequested" });
  sendOmnicodeInstanceCommand(profileId, { type: "focus" });
}

/**
 * desktopTray 的 buildOmnicodeSection 提供者（main/index.ts 注入托盘 options；同步读
 * 缓存——Electron Menu 模板构建不 await）。托盘创建早于 IPC 装配时缓存为空/wired=false，
 * 返回空数组（既有菜单不受影响），setupOmnicodeConsoleTray 后首次重建即填充。
 */
export function buildOmnicodeTrayMenuSection(): MenuItemConstructorOptions[] {
  if (!wired) return [];
  const model = buildOmnicodeTraySectionModel({
    instances: currentTrayInstances(),
    profileCount: Math.max(nameByProfileId.size, 1),
    isZh: isZhReader?.() === true,
  });
  const items: MenuItemConstructorOptions[] = [];
  if (model.instanceItems.length > 0) {
    for (const item of model.instanceItems) {
      items.push({
        label: item.label,
        click: () => focusInstanceFromTray(item.profileId),
      });
    }
    items.push({ type: "separator" });
  }
  items.push(
    {
      label: model.launchAllLabel,
      enabled: model.launchAllEnabled,
      click: () => {
        void launchAllOmnicodeProfiles().catch((error: unknown) => {
          console.warn("[omnicode] 托盘「启动全部」失败:", error);
        });
      },
    },
    {
      label: model.stopAllLabel,
      enabled: model.stopAllEnabled,
      click: () => {
        void stopAllOmnicodeInstances().catch((error: unknown) => {
          console.warn("[omnicode] 托盘「停止全部」失败:", error);
        });
      },
    },
    { type: "separator" },
  );
  return items;
}

/**
 * 装配（desktopProfileIpc 管理器分支调用一次）：注入依赖（显示主窗口 / locale 判定——
 * zh-CN 视为中文，与 instanceManager 工作区路由同判据）、刷新名称缓存、订阅运行态变化
 * 去抖重建托盘菜单。幂等。
 */
export function setupOmnicodeConsoleTray(deps: {
  showConsoleWindow: () => void;
  isZh: () => boolean;
}): void {
  if (wired) return;
  wired = true;
  showConsoleWindow = deps.showConsoleWindow;
  isZhReader = deps.isZh;
  void refreshNameCache().then(() => {
    updateWindowsDesktopTrayMenu();
  });
  subscribeOmnicodeRunningStateChanges(() => {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      // 先刷名称（新增实例的托盘项要显示名字而非 profileId）再重建
      void refreshNameCache().then(() => {
        updateWindowsDesktopTrayMenu();
      });
    }, TRAY_REBUILD_DEBOUNCE_MS);
    rebuildTimer.unref?.();
  });
}

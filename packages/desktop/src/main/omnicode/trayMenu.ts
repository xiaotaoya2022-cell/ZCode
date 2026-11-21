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
// [OmniCode] 实例元数据批次：
// - 排序：运行实例区与网格/设置分区列表共用 sortOmnicodeInstances（shared 纯函数）——
//   排序态（sortMode/customOrder）随名称缓存一并刷新（console-ui.json，异步读缓存后
//   同步构建菜单）；改名触发独立重建（refreshOmnicodeTrayNameCache）。
// - 托盘 tooltip：omnicode 管理器为 `OmniCode · N 个实例运行中`（N=运行数，动态；
//   getOmnicodeTrayRunningCount 由 desktopTray 消费）；实例进程不注入 → 官方 "ZCode"
//   原样（架构语义：实例=ZCode）。
//
// 依赖说明：import desktop 主树 desktopTray 与 instanceBridgeClient import
// desktopWindowSize 同款（omnicode-profile-runtime 已声明 desktop 依赖，module.ts/policy 同步）。
import type { MenuItemConstructorOptions } from "electron";
import {
  sortOmnicodeInstances,
  type OmnicodeInstanceSortMode,
} from "@zcode/shared";
import { updateWindowsDesktopTrayMenu } from "../desktopTray.js";
import {
  broadcastOmnicodeInstanceEvent,
  sendOmnicodeInstanceCommand,
} from "./instanceBridgeServer.js";
import {
  arrangeOmnicodeInstances,
  launchAllOmnicodeProfiles,
  listOmnicodeRunningInstances,
  restoreOmnicodeInstances,
  stopAllOmnicodeInstances,
  subscribeOmnicodeRunningStateChanges,
} from "./instanceManager.js";
import { listOmnicodeProfiles } from "./profileRuntime.js";
import { readOmnicodeConsoleUiState } from "./consoleUiState.js";

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
 * [OmniCode] 实例元数据批次：instances 已由调用方按 sortOmnicodeInstances 排序
 *（sortOmnicodeTrayInstances 同序传递），本模型保持给定顺序。
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
  // [OmniCode] 新功能批次（2026-11-21 审计会话）：托盘快捷编排标签（平铺/还原全部
  // ——与网格工具栏同款 instanceManager 动作；仅未停靠运行实例参与）
  arrangeAllLabel: string;
  restoreAllLabel: string;
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
    arrangeAllLabel: input.isZh ? "平铺全部窗口" : "Arrange all windows",
    restoreAllLabel: input.isZh ? "还原窗口位置" : "Restore window positions",
  };
}

// ─── 装配（模块态：名称/排序缓存 + 订阅去抖重建） ───

interface OmnicodeTrayProfileMeta {
  id: string;
  name: string;
  seq?: number;
  createdAt: string;
}

const profileMetaByProfileId = new Map<string, OmnicodeTrayProfileMeta>();
let cachedSortMode: OmnicodeInstanceSortMode = "seq";
let cachedCustomOrder: string[] = [];
let rebuildTimer: NodeJS.Timeout | null = null;
let showConsoleWindow: (() => void) | null = null;
let isZhReader: (() => boolean) | null = null;
let wired = false;

async function refreshMetaCache(): Promise<void> {
  try {
    const profiles = await listOmnicodeProfiles();
    profileMetaByProfileId.clear();
    for (const profile of profiles) {
      profileMetaByProfileId.set(profile.id, {
        id: profile.id,
        name: profile.name,
        ...(profile.seq !== undefined ? { seq: profile.seq } : {}),
        createdAt: profile.createdAt,
      });
    }
  } catch {
    // 名称缓存刷新失败保留旧值（菜单项以 profileId 兜底显示）
  }
  try {
    const state = await readOmnicodeConsoleUiState();
    cachedSortMode = state.sortMode ?? "seq";
    cachedCustomOrder = state.customOrder ?? [];
  } catch {
    // 排序态读取失败保留旧值（与名称缓存同策略，菜单重建不阻断）
  }
}

/**
 * [OmniCode] 实例元数据批次：托盘运行实例区排序（与网格/设置分区列表共用 shared
 * sortOmnicodeInstances——三处一致红线）。条目带 seq/createdAt（缓存元数据），
 * custom 模式按 cachedCustomOrder，缺省项按 seq 兜底排尾。
 */
function sortedTrayInstances(): OmnicodeTrayInstanceEntry[] {
  const entries = listOmnicodeRunningInstances().map((entry) => {
    const meta = profileMetaByProfileId.get(entry.profileId);
    return {
      id: entry.profileId,
      name: meta?.name ?? entry.profileId,
      ...(meta?.seq !== undefined ? { seq: meta.seq } : {}),
      createdAt: meta?.createdAt ?? "",
    };
  });
  return sortOmnicodeInstances(entries, {
    mode: cachedSortMode,
    customOrder: cachedCustomOrder,
  }).map((entry) => ({ profileId: entry.id, name: entry.name }));
}

function currentTrayInstances(): OmnicodeTrayInstanceEntry[] {
  return sortedTrayInstances().map((entry) => ({
    profileId: entry.profileId,
    name: entry.name,
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
    // [R1 P2-3] profileCount 直接用名称缓存条目数（不再 max(...,1)）：0 profile 时
    // 「启动全部」禁用（0<0 不成立）、「停止全部」因无运行实例同样禁用——与菜单既有
    // "无操作对象即禁用"语义一致。取舍：名称缓存刷新失败保留旧值（refreshMetaCache
    // catch 语义），极端情况下计数可能滞后一轮重建，接受（下次成功刷新即对齐）。
    profileCount: profileMetaByProfileId.size,
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
    // [OmniCode] 新功能批次：托盘快捷编排（平铺/还原；无未停靠运行实例时 arrange 侧
    // 置灰、restore 保持可点——restore 语义是"编排后回基线"，有无目标由实例侧判定）
    {
      label: model.arrangeAllLabel,
      enabled: model.stopAllEnabled,
      click: () => {
        if (arrangeOmnicodeInstances().delivered.length === 0) {
          console.warn("[omnicode] 托盘「平铺全部」无未停靠运行实例可投递");
        }
      },
    },
    {
      label: model.restoreAllLabel,
      click: () => {
        if (restoreOmnicodeInstances().delivered.length === 0) {
          console.warn("[omnicode] 托盘「还原窗口」无未停靠运行实例可投递");
        }
      },
    },
    { type: "separator" },
  );
  return items;
}

/**
 * [OmniCode] 实例元数据批次：托盘 tooltip 的运行实例数提供者（desktopTray 消费——
 * omnicode 管理器 tooltip = `OmniCode · N 个实例运行中`，N 动态）。未装配（实例进程/
 * 官方 flavor 不注入本 option）返回 0；desktopTray 侧仅在 omnicode flavor 且 option
 * 存在时替换官方 tooltip（官方分支原样，红线）。
 */
export function getOmnicodeTrayRunningCount(): number {
  return listOmnicodeRunningInstances().length;
}

/**
 * [OmniCode] 实例元数据批次：改名涟漪②——托盘名称缓存刷新 + 菜单重建（改名不影响
 * 运行态，运行态订阅链路不会触发）。fire-and-forget：刷新失败保留旧名（下次任一
 * 运行态变化重建即收敛）。排序态/实例名（settings 列表与网格共享同一 profile.json）
 * 亦经此入口对齐。
 */
export function refreshOmnicodeTrayNameCache(): void {
  if (!wired) return;
  void refreshMetaCache().then(() => {
    updateWindowsDesktopTrayMenu();
  });
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
  void refreshMetaCache().then(() => {
    updateWindowsDesktopTrayMenu();
  });
  subscribeOmnicodeRunningStateChanges(() => {
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      // 先刷名称（新增实例的托盘项要显示名字而非 profileId）再重建
      void refreshMetaCache().then(() => {
        updateWindowsDesktopTrayMenu();
      });
    }, TRAY_REBUILD_DEBOUNCE_MS);
    rebuildTimer.unref?.();
  });
}

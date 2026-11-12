// [OmniCode] Profile 多实例 IPC（spec: docs/omnicode/profile-runtime.md）。
// 入参校验在 omnicode 模块内完成（白名单正则 + 目录校验），本文件只做装配与摘要合并。
// 批次2 B2-1（T3 嵌套封死）：Profile IPC + 桥服务 + reconcile 仅在「非 omnicode 实例」
// 进程装配——实例进程内不再注册管理面（其实例 renderer 的 ConsoleHome 入口已被
// Root 收紧移除，这里的守卫封死"实例内再 spawn 实例"的最后一层）。官方 flavor
// （production/preview）行为保持既有不变（继续注册）。
import { ipcMain, shell } from "electron";
import {
  isOmnicodeProfileInstanceEnv,
  PlatformChannels,
  ZCODE_PRODUCT_FLAVOR,
  type OmnicodeConsoleUiState,
  type OmnicodeConsoleUiStatePatch,
  type OmnicodeProfileSummaryInfo,
} from "@zcode/shared";
import {
  adoptOmnicodeConsoleAsProfile,
  arrangeOmnicodeInstances,
  cloneOmnicodeProfile,
  createOmnicodeProfile,
  ensureOmnicodeInstanceBridgeServerStarted,
  getOmnicodeConsoleDataBaseDir,
  getOmnicodeProfileDir,
  hasOmnicodeConsoleCredentials,
  isOmnicodeDataBaseDirAdopted,
  launchOmnicodeProfile,
  listOmnicodeProfiles,
  listOmnicodeRunningInstances,
  reconcileOmnicodeRunningInstances,
  removeOmnicodeProfile,
  resolveOmnicodeConsoleAdoptionAvailable,
  restoreOmnicodeInstances,
  sendOmnicodeInstanceCommand,
  startOmnicodeCredentialBackupScheduler,
  stopOmnicodeProfile,
} from "./omnicode/contract.js";
import {
  applyOmnicodeConsoleEmbedLayout,
  applyOmnicodeConsoleModeChange,
  applyOmnicodePreviewEnabled,
  applyOmnicodePreviewState,
  notifyOmnicodeInstanceConnected,
  notifyOmnicodeInstanceDisconnected,
  notifyOmnicodeInstanceHello,
  readOmnicodeConsoleUiState,
  setupOmnicodeConsoleEmbedding,
  writeOmnicodeConsoleUiState,
} from "./omnicode/consoleEmbedding.js";
import {
  mergeOmnicodeConsoleUiState,
  resolveOmnicodeConsoleModeTransition,
} from "./omnicode/consoleUiState.js";
import { setOmnicodeInstanceBridgeManagerHooks } from "./omnicode/instanceBridgeServer.js";
import { assertValidProfileId } from "./omnicode/contract.js";

export function registerDesktopOmnicodeProfileIpcHandlers(): void {
  // [OmniCode] 批次2 B2-1（T3）：omnicode 实例进程不装配管理面（桥 server、reconcile、
  // Profile IPC、全量凭据备份调度）。实例只跑桥 client（index.ts 侧按身份装配）与
  // 自身数据根的备份调度。
  if (ZCODE_PRODUCT_FLAVOR === "omnicode" && isOmnicodeProfileInstanceEnv()) {
    console.info("[omnicode] 实例进程跳过 Profile IPC/桥服务装配（嵌套管理器封死）");
    return;
  }
  // M2：桥接服务随 IPC 装配启动（doLaunch 前必须就绪）
  void ensureOmnicodeInstanceBridgeServerStarted();
  // 批次1 P0-3：控制台（重）启动时扫进程表重建实例运行态（异步不阻塞 IPC 注册；
  // 扫描失败保留现状——instanceReconcile 的"失败≠无实例"语义）
  void reconcileOmnicodeRunningInstances();
  // [OmniCode] 凭据自动备份调度器（每小时 + 装配即跑一次；best-effort）
  startOmnicodeCredentialBackupScheduler();

  ipcMain.handle(PlatformChannels.OmnicodeProfileList, async () => {
    const profiles = await listOmnicodeProfiles();
    const pidByProfileId = new Map(
      listOmnicodeRunningInstances().map((entry) => [entry.profileId, entry.pid]),
    );
    const infos: OmnicodeProfileSummaryInfo[] = profiles.map((profile) => {
      const pid = pidByProfileId.get(profile.id);
      return {
        ...profile,
        running: pid !== undefined,
        ...(pid !== undefined ? { pid } : {}),
      };
    });
    return { profiles: infos };
  });

  ipcMain.handle(PlatformChannels.OmnicodeProfileCreate, async (_event, input: { name: string; notes?: string }) => {
    const profile = await createOmnicodeProfile(input.name, input.notes);
    return { profile: { ...profile, running: false } };
  });

  ipcMain.handle(PlatformChannels.OmnicodeProfileRemove, async (_event, input: { id: string }) => {
    await removeOmnicodeProfile(input.id);
    return { ok: true };
  });

  ipcMain.handle(PlatformChannels.OmnicodeProfileClone, async (_event, input: { id: string; name: string }) => {
    const profile = await cloneOmnicodeProfile(input.id, input.name);
    return { profile: { ...profile, running: false } };
  });

  // P1-4「启动=重启」：已运行实例先走三段式优雅停再启动（不再是幂等返回现有 pid）。
  // 启动确认失败/优雅停失败（秒退、pid 残留）以 reject 传播 → renderer invoke reject
  // → UI toast 透出（spec §接口 launch）。
  ipcMain.handle(PlatformChannels.OmnicodeProfileLaunch, async (_event, input: { id: string }) => {
    const pid = await launchOmnicodeProfile(input.id);
    return { pid };
  });

  ipcMain.handle(PlatformChannels.OmnicodeProfileStop, async (_event, input: { id: string }) => {
    await stopOmnicodeProfile(input.id);
    return { ok: true };
  });

  ipcMain.handle(PlatformChannels.OmnicodeProfileFocus, async (_event, input: { id: string }) => {
    // M2 放大编排 v0：桥接 focus 命令（实例 show+focus 主窗口）；未连接返回未生效
    const delivered = sendOmnicodeInstanceCommand(input.id, { type: "focus" });
    return { ok: delivered };
  });

  // M2 v1 平铺编排：全部运行中实例窗口 setBounds 到主屏网格（spec §实时视窗）
  ipcMain.handle(PlatformChannels.OmnicodeProfileArrange, async () => {
    return arrangeOmnicodeInstances();
  });

  // M2 v1 还原：实例按自身编排前基线回位
  ipcMain.handle(PlatformChannels.OmnicodeProfileRestore, async () => {
    return restoreOmnicodeInstances();
  });

  // [OmniCode] 批次2 B2-1（T5）：旧控制台收养 IPC（同守卫内装配——实例进程已在函数
  // 顶部整体 return，不会注册收养面）
  registerDesktopOmnicodeConsoleAdoptionIpcHandlers();
  // [OmniCode] 批次2 B2-3：控制台网格/内嵌/预览 IPC + 桥管理钩子（spec §批次2 D9）
  registerDesktopOmnicodeConsoleViewportIpcHandlers();
  setOmnicodeInstanceBridgeManagerHooks({
    onInstanceConnected: (profileId) => notifyOmnicodeInstanceConnected(profileId),
    onInstanceDisconnected: (profileId) => notifyOmnicodeInstanceDisconnected(profileId),
    onInstanceHello: (profileId, hwndHex) => notifyOmnicodeInstanceHello(profileId, hwndHex),
  });
  // 装配时初始化持久化模式（窗口引用由 index.ts 在主窗口创建后补挂）
  void setupOmnicodeConsoleEmbedding();
}

/**
 * [OmniCode] 批次2 B2-3：控制台视窗 IPC（仅管理器装配，spec §批次2 D9）。
 * - UiStateGet/Set：内嵌/桌面模式 + 实时预览开关（console-ui.json 持久化；模式切换
 *   触发 owned 编排/解除）。
 * - EmbedLayout：renderer 卡片画面区客户区矩形上报（换算/下发在 consoleEmbedding）。
 * - PreviewState：总开关 + 视口内卡片集合 → 桥订阅对账。
 * - RevealDataDir：系统文件管理器打开实例数据目录。
 */
function registerDesktopOmnicodeConsoleViewportIpcHandlers(): void {
  ipcMain.handle(PlatformChannels.OmnicodeConsoleUiStateGet, async (): Promise<OmnicodeConsoleUiState> => {
    return readOmnicodeConsoleUiState();
  });

  ipcMain.handle(
    PlatformChannels.OmnicodeConsoleUiStateSet,
    async (_event, patch: OmnicodeConsoleUiStatePatch): Promise<OmnicodeConsoleUiState> => {
      const current = await readOmnicodeConsoleUiState();
      const merged = mergeOmnicodeConsoleUiState(current, patch);
      await writeOmnicodeConsoleUiState(merged);
      if (resolveOmnicodeConsoleModeTransition(current.mode, merged.mode) !== "none") {
        await applyOmnicodeConsoleModeChange(merged.mode);
      }
      if (current.previewEnabled !== merged.previewEnabled) {
        // 保留 renderer 最近上报的可见集合，只翻总开关（清零会丢订阅直到下一拍上报）
        applyOmnicodePreviewEnabled(merged.previewEnabled);
      }
      return merged;
    },
  );

  ipcMain.handle(PlatformChannels.OmnicodeConsoleEmbedLayout, async (_event, input: unknown) => {
    applyOmnicodeConsoleEmbedLayout(normalizeEmbedLayoutInput(input));
    return { ok: true };
  });

  ipcMain.handle(PlatformChannels.OmnicodeConsolePreviewState, async (_event, input: unknown) => {
    const normalized = normalizePreviewStateInput(input);
    applyOmnicodePreviewState(normalized);
    // 预览开关语义 = UI 状态的一部分（总开关持久化到 console-ui.json）
    const current = await readOmnicodeConsoleUiState();
    if (current.previewEnabled !== normalized.previewEnabled) {
      await writeOmnicodeConsoleUiState({ ...current, previewEnabled: normalized.previewEnabled });
    }
    return { ok: true };
  });

  ipcMain.handle(PlatformChannels.OmnicodeProfileRevealDataDir, async (_event, input: { id: string }) => {
    try {
      assertValidProfileId(input?.id);
    } catch {
      return { ok: false };
    }
    await shell.openPath(getOmnicodeProfileDir(input.id));
    return { ok: true };
  });
}

/** EmbedLayout 入参防御性归一（renderer 来源，畸形字段丢弃而非抛错）。 */
function normalizeEmbedLayoutInput(
  input: unknown,
): { viewportWidth: number; viewportHeight: number; rects: { profileId: string; x: number; y: number; width: number; height: number }[] } {
  const raw = (input ?? {}) as {
    viewportWidth?: unknown;
    viewportHeight?: unknown;
    rects?: unknown;
  };
  const rects: { profileId: string; x: number; y: number; width: number; height: number }[] = [];
  if (Array.isArray(raw.rects)) {
    for (const rect of raw.rects) {
      if (!rect || typeof rect !== "object") continue;
      const candidate = rect as Record<string, unknown>;
      if (
        typeof candidate.profileId !== "string" ||
        typeof candidate.x !== "number" ||
        typeof candidate.y !== "number" ||
        typeof candidate.width !== "number" ||
        typeof candidate.height !== "number"
      ) {
        continue;
      }
      rects.push({
        profileId: candidate.profileId,
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
      });
    }
  }
  return {
    viewportWidth: typeof raw.viewportWidth === "number" ? raw.viewportWidth : 0,
    viewportHeight: typeof raw.viewportHeight === "number" ? raw.viewportHeight : 0,
    rects,
  };
}

/** PreviewState 入参防御性归一。 */
function normalizePreviewStateInput(input: unknown): { previewEnabled: boolean; visibleProfileIds: string[] } {
  const raw = (input ?? {}) as { previewEnabled?: unknown; visibleProfileIds?: unknown };
  return {
    previewEnabled: raw.previewEnabled === true,
    visibleProfileIds: Array.isArray(raw.visibleProfileIds)
      ? raw.visibleProfileIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

// [OmniCode] 批次2 B2-1（T5）：旧控制台收养 IPC（spec §批次2：旧控制台数据收养）。
// 仅当旧数据根存在凭据文件且尚无 profile 指向它时可收养（零拷贝：新 profile 的
// dataBaseDirOverride 指向旧根，credential-secret 随目录走天然可解密旧凭据）。
function registerDesktopOmnicodeConsoleAdoptionIpcHandlers(): void {
  ipcMain.handle(PlatformChannels.OmnicodeConsoleAdoptionCheck, async () => {
    const consoleDir = getOmnicodeConsoleDataBaseDir();
    const available = resolveOmnicodeConsoleAdoptionAvailable(
      hasOmnicodeConsoleCredentials(consoleDir),
      (await isOmnicodeDataBaseDirAdopted(consoleDir)) ? [consoleDir] : [],
    );
    return { available };
  });

  ipcMain.handle(
    PlatformChannels.OmnicodeConsoleAdopt,
    async (_event, input: { name: string }) => {
      const profile = await adoptOmnicodeConsoleAsProfile(
        typeof input?.name === "string" ? input.name : "实例-收养",
        getOmnicodeConsoleDataBaseDir(),
      );
      return { profile: { ...profile, running: false } };
    },
  );
}

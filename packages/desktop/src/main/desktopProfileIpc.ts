// [OmniCode] Profile 多实例 IPC（spec: docs/omnicode/profile-runtime.md）。
// 入参校验在 omnicode 模块内完成（白名单正则 + 目录校验），本文件只做装配与摘要合并。
// 批次2 B2-1（T3 嵌套封死）：Profile IPC + 桥服务 + reconcile 仅在「非 omnicode 实例」
// 进程装配——实例进程内不再注册管理面（其实例 renderer 的 ConsoleHome 入口已被
// Root 收紧移除，这里的守卫封死"实例内再 spawn 实例"的最后一层）。官方 flavor
// （production/preview）行为保持既有不变（继续注册）。
import { ipcMain } from "electron";
import {
  isOmnicodeProfileInstanceEnv,
  PlatformChannels,
  ZCODE_PRODUCT_FLAVOR,
  type OmnicodeProfileSummaryInfo,
} from "@zcode/shared";
import {
  adoptOmnicodeConsoleAsProfile,
  arrangeOmnicodeInstances,
  cloneOmnicodeProfile,
  createOmnicodeProfile,
  ensureOmnicodeInstanceBridgeServerStarted,
  getOmnicodeConsoleDataBaseDir,
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

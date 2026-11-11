// [OmniCode] Profile 多实例 IPC（spec: docs/omnicode/profile-runtime.md）。
// 入参校验在 omnicode 模块内完成（白名单正则 + 目录校验），本文件只做装配与摘要合并。
import { ipcMain } from "electron";
import { PlatformChannels, type OmnicodeProfileSummaryInfo } from "@zcode/shared";
import {
  arrangeOmnicodeInstances,
  cloneOmnicodeProfile,
  createOmnicodeProfile,
  ensureOmnicodeInstanceBridgeServerStarted,
  launchOmnicodeProfile,
  listOmnicodeProfiles,
  listOmnicodeRunningInstances,
  reconcileOmnicodeRunningInstances,
  removeOmnicodeProfile,
  restoreOmnicodeInstances,
  sendOmnicodeInstanceCommand,
  startOmnicodeCredentialBackupScheduler,
  stopOmnicodeProfile,
} from "./omnicode/contract.js";

export function registerDesktopOmnicodeProfileIpcHandlers(): void {
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
}

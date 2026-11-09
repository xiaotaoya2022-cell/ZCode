// [OmniCode] Profile 多实例 IPC（spec: docs/omnicode/profile-runtime.md）。
// 入参校验在 omnicode 模块内完成（白名单正则 + 目录校验），本文件只做装配与摘要合并。
import { ipcMain } from "electron";
import { PlatformChannels, type OmnicodeProfileSummaryInfo } from "@zcode/shared";
import {
  cleanupStaleHandoff,
  cloneOmnicodeProfile,
  createOmnicodeProfile,
  ensureOmnicodeInstanceBridgeServerStarted,
  launchOmnicodeProfile,
  listOmnicodeProfiles,
  listOmnicodeRunningInstances,
  removeOmnicodeProfile,
  sendOmnicodeInstanceCommand,
  stopOmnicodeProfile,
} from "./omnicode/contract.js";

export function registerDesktopOmnicodeProfileIpcHandlers(): void {
  // 控制台启动：清理崩溃残留的 handoff（spec §接口 launch 附注）
  cleanupStaleHandoff();
  // M2：桥接服务随 IPC 装配启动（doLaunch 前必须就绪）
  void ensureOmnicodeInstanceBridgeServerStarted();

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
}

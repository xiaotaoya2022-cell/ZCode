// [OmniCode] 模式二 R3：附加账号目录 / 槽位 的实例 IPC 面（spec:
// docs/omnicode/multi-account-sessions.md §6/§7）。
//
// 仅 omnicode 实例进程装配（main/index.ts isOmnicodeProfileInstanceEnv 分支）——管理器/
// 官方 flavor 的 renderer 桥面不含这两个方法（preload 实例门控），消费面缺席即天然禁用，
// 官方零改动铁律。载荷均为**元数据 only**（无凭据红线）：
// - 目录列表：附加账号元数据（accountId/sourceProfileId/family/displayName）；
// - 槽位用量：调度器 running/上限快照（main → Host parentPort 转问，Host 调度器计数）。
import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { getOmnicodeAccountDirectoryList } from "./accountDirectoryClient.js";
import { requestOmnicodeAccountSlotsFromHost } from "./accountSlotsQuery.js";

/** 注册实例身份的账号目录/槽位 IPC（幂等不必要：进程级一次性装配）。 */
export function registerOmnicodeAccountDirectoryIpcHandlers(): void {
  ipcMain.handle(PlatformChannels.OmnicodeAccountDirectoryListGet, async () => {
    const entries = await getOmnicodeAccountDirectoryList();
    return entries.length > 0
      ? { ok: true, accounts: entries }
      : { ok: false, error: "omnicode_account_directory_unavailable" };
  });
  ipcMain.handle(PlatformChannels.OmnicodeAccountSlotsGet, async () => {
    return await requestOmnicodeAccountSlotsFromHost();
  });
}

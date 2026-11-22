// [OmniCode] Profile 多实例 IPC（spec: docs/omnicode/profile-runtime.md）。
// 入参校验在 omnicode 模块内完成（白名单正则 + 目录校验），本文件只做装配与摘要合并。
// 批次2 B2-1（T3 嵌套封死）：Profile IPC + 桥服务 + reconcile 仅在「非 omnicode 实例」
// 进程装配——实例进程内不再注册管理面（其实例 renderer 的 ConsoleHome 入口已被
// Root 收紧移除，这里的守卫封死"实例内再 spawn 实例"的最后一层）。官方 flavor
// （production/preview）行为保持既有不变（继续注册）。
import { ipcMain, shell, BrowserWindow } from "electron";
import {
  isOmnicodeProfileInstanceEnv,
  PlatformChannels,
  ZCODE_PRODUCT_FLAVOR,
  type OmnicodeAccountClaimEventPayload,
  type OmnicodeConsoleUiState,
  type OmnicodeConsoleUiStatePatch,
  type OmnicodeProfileSummaryInfo,
} from "@zcode/shared";
import {
  adoptOmnicodeConsoleAsProfile,
  arrangeOmnicodeInstances,
  cloneOmnicodeProfile,
  createOmnicodeProfile,
  createOmnicodeSharedAssetsCache,
  ensureOmnicodeInstanceBridgeServerStarted,
  getOmnicodeConsoleDataBaseDir,
  getOmnicodeProfileDir,
  getOmnicodeConnectedInstanceProfileIds,
  resolveOmnicodeAssetsCacheRoot,
  bindOmnicodeGlobalPrefsSourceInstanceId,
  handleOmnicodeGlobalPrefsReportFromInstance,
  hasOmnicodeConsoleCredentials,
  isOmnicodeDataBaseDirAdopted,
  launchOmnicodeProfile,
  listOmnicodeProfiles,
  listOmnicodeRunningInstances,
  pushOmnicodeGlobalPrefsSnapshotToInstance,
  reconcileOmnicodeRunningInstances,
  readOmnicodeProcessMemoryMBs,
  removeOmnicodeProfile,
  renameOmnicodeProfile,
  resolveOmnicodeConsoleAdoptionAvailable,
  restoreOmnicodeInstances,
  sendOmnicodeInstanceCommand,
  sendOmnicodeInstanceRename,
  startOmnicodeCredentialBackupScheduler,
  stopOmnicodeProfile,
} from "./omnicode/contract.js";
import {
  applyOmnicodeConsoleDockStateChange,
  applyOmnicodeConsoleEmbedLayout,
  applyOmnicodePreviewEnabled,
  applyOmnicodePreviewState,
  getOmnicodeConsoleEmbedScale,
  notifyOmnicodeInstanceConnected,
  notifyOmnicodeInstanceDisconnected,
  notifyOmnicodeInstanceHello,
  readOmnicodeConsoleUiState,
  setupOmnicodeConsoleEmbedding,
  writeOmnicodeConsoleUiState,
} from "./omnicode/consoleEmbedding.js";
import { mergeOmnicodeConsoleUiState } from "./omnicode/consoleUiState.js";
// [OmniCode] 模式二 R2（spec: docs/omnicode/multi-account-sessions.md §5）：管理器侧
// 附加账号解密代理（桥钩子消费；管理器唯一解密权威，材料内存现取不落盘不进日志）。
import {
  listOmnicodeBridgeAccounts,
  resolveOmnicodeBridgeAccountMaterial,
} from "./omnicode/accountDirectory.js";
// [OmniCode] 丙1 远程聚合 R3（spec: docs/omnicode/remote-aggregation.md §4/§5/§8-R3）：
// 跨实例桥转发装配（目录查询/转投 + 上行钩子消费；经 contract 面与 takeover 同款约定）。
import {
  handleOmnicodeRemoteWorkspaceInstanceConnected,
  handleOmnicodeRemoteWorkspaceInstanceDisconnected,
  handleOmnicodeRemoteWorkspaceListUplink,
  setupOmnicodeRemoteForwardHost,
} from "./omnicode/contract.js";
import type { OmnicodeRemoteForwardHostDeps } from "./omnicode/remoteForwardHost.js";
// [OmniCode] 丙1 远程聚合 R4（spec: docs/omnicode/remote-aggregation.md §6/§7/§8-R4）：
// 跨账号聚合开关（globalPrefs 键体系侧车层 + 账号族快照名单）+ 宿主退出 failover
// 提示对账（断连钩子 → 管理器 toast 广播 + remoteHostAnnounce epoch+1 下发）。
import {
  getOmnicodeRemoteCrossAccountPref,
  handleOmnicodeRemoteAggregateInstanceDisconnected,
  listOmnicodeCrossAccountProfileIds,
  refreshOmnicodeAccountFamilyForProfile,
  seedOmnicodeAccountFamilyOwnKey,
  seedOmnicodeRemoteCrossAccountPrefFromSidecar,
} from "./omnicode/contract.js";
// [OmniCode] 实例元数据批次：改名/排序态变化触发托盘名称缓存刷新 + 菜单重建（直接从
// 实现文件导入，与 consoleUiState 同款约定——经 contract.ts 不含 trayMenu 导出）。
import { refreshOmnicodeTrayNameCache } from "./omnicode/trayMenu.js";
import {
  broadcastOmnicodeInstanceEvent,
  setOmnicodeInstanceBridgeManagerHooks,
} from "./omnicode/instanceBridgeServer.js";
// [OmniCode] D12 接管流：管理器协调器（观察者→持有者转投 + 回执路由；spec §批次3 D12）
import {
  handleOmnicodeTakeoverCancelFromInstance,
  handleOmnicodeTakeoverInstanceDisconnected,
  handleOmnicodeTakeoverReplyFromInstance,
  handleOmnicodeTakeoverRequestFromInstance,
  setupOmnicodeTakeoverCoordinator,
  type OmnicodeTakeoverLockOwnerView,
} from "./omnicode/takeoverCoordinator.js";
import { listWorkspaceLocks, readWorkspaceLockOwner } from "@zcode/services/node";
// [OmniCode] 新功能批次（2026-11-21 审计会话）：管理器维护面（锁总览/凭据备份/会话库体检）
import { registerDesktopOmnicodeConsoleMaintenanceIpcHandlers } from "./omnicode/consoleMaintenance.js";
import { readOmnicodeLoginHealths } from "./omnicode/loginHealth.js";
import { readConsoleRootOsMigrationMarker } from "./omnicode/consoleCredentialOsMigration.js";
import { applyOmnicodePerfPanelState } from "./omnicode/perfMonitor.js";
import { getOmnicodeAccountDashboardSnapshot } from "./omnicode/accountDashboard.js";
import { startOmnicodeAccountClaimRun } from "./omnicode/claimRunner.js";
import { detectOmnicodeClaimableAccounts } from "./omnicode/accountDetection.js";
import { createOmnicodeClaimAutoPollDeps, startOmnicodeClaimAutoPoll } from "./omnicode/claimAutoPoll.js";
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
    // [OmniCode] B2 评审修复（P2-11②）：运行实例内存占用（Windows tasklist 单次查询；
    // 失败/非 Windows 返回 undefined → memoryMB 缺省，控制台底栏不显示合计）
    const memoryByPid = await readOmnicodeProcessMemoryMBs([...pidByProfileId.values()]);
    // [OmniCode] 批次2.5 X2：登录态健康度（管理器直读凭据快照 expiresAt 分级；
    // 任何读失败=unknown 静默，spec: docs/omnicode/console-extras.md §X2）
    const loginHealthByProfileId = await readOmnicodeLoginHealths(profiles);
    const infos: OmnicodeProfileSummaryInfo[] = profiles.map((profile) => {
      const pid = pidByProfileId.get(profile.id);
      return {
        ...profile,
        running: pid !== undefined,
        ...(pid !== undefined ? { pid } : {}),
        ...(pid !== undefined && memoryByPid?.has(pid)
          ? { memoryMB: memoryByPid.get(pid) }
          : {}),
        loginHealth: loginHealthByProfileId.get(profile.id) ?? { status: "unknown" },
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
    // [OmniCode] 批次3 终审修复（P2-⑤）：清理 console-ui dockedByProfileId 残留键
    //（删实例后覆盖键不再有意义——键为时间戳+随机无碰撞，dockAll 亦会清空，此处只是
    // 存档卫生）。best-effort：清理失败不阻断删除主流程（残留键按缺省语义解析）。
    try {
      const state = await readOmnicodeConsoleUiState();
      if (Object.prototype.hasOwnProperty.call(state.dockedByProfileId, input.id)) {
        const { [input.id]: _removedOverride, ...restOverrides } = state.dockedByProfileId;
        await writeOmnicodeConsoleUiState({ ...state, dockedByProfileId: restOverrides });
      }
    } catch (error) {
      console.warn("[omnicode] 删实例清理 dockedByProfileId 残留键失败（不阻断）:", error);
    }
    return { ok: true };
  });

  ipcMain.handle(PlatformChannels.OmnicodeProfileClone, async (_event, input: { id: string; name: string }) => {
    const profile = await cloneOmnicodeProfile(input.id, input.name);
    return { profile: { ...profile, running: false } };
  });

  // [OmniCode] 实例元数据批次：重命名实例（profileId 稳定性红线：id/凭据/数据根/锁/
  // dock 覆盖表全部按旧 id 工作）。涟漪同步：①网格/看板卡与设置列表走 List 数据链
  // （renderer 刷新后 name 直通）②托盘菜单名称缓存刷新 + 重建③运行中实例窗口标题
  // 热更新（桥 rename 命令：win.setTitle + renderer document.title 广播）④锁占用者名
  // ——锁获取/心跳时由实例 Host 读最新 profile.json（readLatestOmnicodeProfileDisplayName），
  // 无需经桥，此处不额外触发。
  ipcMain.handle(PlatformChannels.OmnicodeProfileRename, async (_event, input: { id: string; name: string }) => {
    const profile = await renameOmnicodeProfile(input.id, input.name);
    sendOmnicodeInstanceRename(input.id, profile.name);
    refreshOmnicodeTrayNameCache();
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
  // [OmniCode] 批次3：登录态看板数据快照 + 赛博鸡蛋领取执行（数据层，spec:
  // F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2/§3）
  registerDesktopOmnicodeAccountIpcHandlers();
  // [OmniCode] 新功能批次（2026-11-21 审计会话）：管理器维护面 IPC（锁总览/凭据备份/会话库）
  registerDesktopOmnicodeConsoleMaintenanceIpcHandlers({ listWorkspaceLocks });
  // [OmniCode] 批次4 单点下沉（spec: docs/omnicode/omnicode-shared-services.md §G3.4）：
  // 管理器共享资产缓存仅 omnicode flavor 装配（官方 flavor 零改动——钩子缺席时桥服务
  // 回结构化错误，实例回退直连）。缓存根懒建：只在首个请求时创建目录。
  const omnicodeSharedAssetsCache =
    ZCODE_PRODUCT_FLAVOR === "omnicode"
      ? createOmnicodeSharedAssetsCache({ cacheRoot: resolveOmnicodeAssetsCacheRoot() })
      : null;
  setOmnicodeInstanceBridgeManagerHooks({
    onInstanceConnected: (profileId) => {
      notifyOmnicodeInstanceConnected(profileId);
      // [OmniCode] 批次4 全局偏好层：连接即推当前全局层快照（theme 主交付面 +
      // 长断连实例的收敛兜底；fire-and-forget，spec: docs/omnicode/global-preferences.md）。
      void pushOmnicodeGlobalPrefsSnapshotToInstance(profileId);
      // [OmniCode] 丙1 远程聚合 R3：连接即目录查询（门控内聚在 remoteForwardHost——
      // 开关关闭零查询；实例上行 Report 为另一路收敛来源，spec §5 目录双保险）。
      handleOmnicodeRemoteWorkspaceInstanceConnected(profileId);
      // [OmniCode] 丙1 远程聚合 R4：连接即刷新该实例账号族快照（跨账号聚合名单
      // 事实源；事件驱动零轮询，读失败归未知=同账号保守归类，spec §7 默认关）。
      void refreshOmnicodeAccountFamilyForProfile(profileId);
    },
    onInstanceDisconnected: (profileId) => {
      notifyOmnicodeInstanceDisconnected(profileId);
      // [OmniCode] D12 接管流：断连对账——持有者断开 = holder-offline 即时回观察者；
      // 观察者断开 = 标记取消（持有者回执到达时静默丢弃）。
      handleOmnicodeTakeoverInstanceDisconnected(profileId);
      // [OmniCode] 丙1 远程聚合 R3：断连摘除该实例的聚合条目并重推（spec §6 对账）。
      handleOmnicodeRemoteWorkspaceInstanceDisconnected(profileId);
      // [OmniCode] 丙1 远程聚合 R4 failover：断连者 = 登记宿主 → 管理器 toast 提示 +
      // remoteHostAnnounce(epoch+1) 广播剩余实例刷新目录视图（自动转移为二期，spec §6；
      // 门控关/未登记宿主 = 零行为——R3 拓扑缺省宿主是管理器进程本进程，不误报）。
      handleOmnicodeRemoteAggregateInstanceDisconnected(profileId);
    },
    onInstanceHello: (profileId, hwndHex) => notifyOmnicodeInstanceHello(profileId, hwndHex),
    // [OmniCode] 批次4：实例上行全局偏好（载荷已在桥服务侧消毒；协调器内二次消毒 +
    // 管理器写全局层 + state:* 热应用 + 下行广播，spec: docs/omnicode/global-preferences.md）。
    // sourceInstanceId 绑定认证身份：钩子首参 = 桥握手已验 profileIdParam，真身覆盖
    // 客户端自报值（伪造他人 id 会让目标实例误判回声、漏收该次同步）。
    onOmnicodeGlobalPrefsReport: (profileId, prefs, sourceInstanceId) => {
      void handleOmnicodeGlobalPrefsReportFromInstance(
        prefs,
        bindOmnicodeGlobalPrefsSourceInstanceId(profileId, sourceInstanceId),
      );
    },
    // [OmniCode] 批次4 单点下沉：实例共享资产取回 → 管理器缓存解析（结构化失败由
    // 缓存模块返回，不抛越钩子边界；实例侧按 ok=false 回退直连）。
    ...(omnicodeSharedAssetsCache
      ? {
          onSharedAssetFetchRequest: (profileId: string, request: unknown) =>
            omnicodeSharedAssetsCache.resolve(request),
        }
      : {}),
    // [OmniCode] 模式二 R2：实例附加账号材料取回 → 管理器解密代理（仅 omnicode flavor
    // 装配；钩子缺席时桥服务回结构化错误，实例 Host 回落 local 文件来源提供者）。
    // 首参 profileId = 桥握手已验连接真身，代理据此排除请求方自身的主账号材料。
    ...(ZCODE_PRODUCT_FLAVOR === "omnicode"
      ? {
          onAccountMaterialRequest: (
            profileId: string,
            request: { accountId: string },
          ) =>
            resolveOmnicodeBridgeAccountMaterial({
              accountId: request.accountId,
              requesterProfileId: profileId,
            }),
          // [OmniCode] 模式二 R3（spec: docs/omnicode/multi-account-sessions.md §7）：实例
          // 附加账号目录元数据查询 → 管理器目录枚举。**元数据 only**：逐 profile 枚举后
          // 裁剪为 accountId/sourceProfileId/family/displayName——deviceMid 与任何凭据
          // 材料永不越过本边界（红线）。仅 omnicode flavor 装配（钩子缺席=官方零改动）。
          onAccountDirectoryListRequest: async (profileId: string) => {
            try {
              const entries = await listOmnicodeBridgeAccounts({ excludeProfileId: profileId });
              return {
                ok: true,
                accounts: entries.map((entry) => ({
                  accountId: entry.accountId,
                  sourceProfileId: entry.sourceProfileId,
                  family: entry.family,
                  displayName: entry.displayName,
                })),
              };
            } catch {
              return { ok: false, error: "account_directory_unavailable" };
            }
          },
        }
      : {}),
    // [OmniCode] D12 接管流：观察者→持有者转投 + 回执路由（身份绑定认证在桥服务侧
    // 完成——钩子首参 profileId 是桥握手已验连接真身，协调器不信任载荷自报身份）。
    onTakeoverRequestFromInstance: (profileId, message) => {
      void handleOmnicodeTakeoverRequestFromInstance(profileId, message);
    },
    onTakeoverReplyFromInstance: (profileId, message) =>
      handleOmnicodeTakeoverReplyFromInstance(profileId, message),
    onTakeoverCancelFromInstance: (profileId, message) =>
      handleOmnicodeTakeoverCancelFromInstance(profileId, message),
    // [OmniCode] 丙1 远程聚合 R3：实例 workspace-list 目录上行（Result 应答 / Report
    // 报告；载荷已在桥服务侧按 shared union 校验——null=校验失败静默丢弃。钩子面照常
    // 挂载，remoteForwardHost 单例缺席（官方 flavor）时 handle* 全部 no-op）。
    onOmnicodeRemoteWorkspaceListUplink: (profileId, message) => {
      handleOmnicodeRemoteWorkspaceListUplink(profileId, message);
    },
  });
  // [OmniCode] 丙1 远程聚合 R3：跨实例转发核心装配（仅 omnicode flavor——官方 flavor
  // 单例缺席，handle* 全 no-op。桥命令直发 + 显示名经 Profile 注册表解析防伪造，
  // takeoverCoordinator 同款依赖形态）。
  if (ZCODE_PRODUCT_FLAVOR === "omnicode") {
    const forwardDeps: OmnicodeRemoteForwardHostDeps = {
      sendCommand: (profileId, command) => sendOmnicodeInstanceCommand(profileId, command),
      getConnectedProfileIds: () => getOmnicodeConnectedInstanceProfileIds(),
      resolveProfileDisplayName: async (profileId) => {
        try {
          const profiles = await listOmnicodeProfiles();
          return profiles.find((profile) => profile.id === profileId)?.name ?? null;
        } catch {
          return null;
        }
      },
      // [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关接线（spec §7 默认关）。开关读取端 =
      // globalPrefs 键体系缓存（omnicodeRemoteCrossAccount：管理器侧车事实源 +
      // applyGlobalPrefs 下发，实例侧内存缓存——目录过滤权威在管理器，只有宿主同时
      // 持有宿主账号与各实例账号族事实）；名单 = accountFamily 账号族快照（未知身份
      // 保守归类同账号——保持 R3 缺省聚合行为不变）。
      readCrossAccountAggregation: () => getOmnicodeRemoteCrossAccountPref(),
      listCrossAccountProfileIds: () => listOmnicodeCrossAccountProfileIds(),
      // [OmniCode] 丙1 远程聚合 R4 failover：宿主退出 → 管理器 toast 提示链（D11
      // openedToast 同款机制：main 广播 OmnicodeInstanceEvent remoteHostExited 变体 →
      // 管理器 renderer toast，i18n 五语）。仅管理器进程窗口可收到（广播源 = 本桥服务）。
      onAggregateHostExit: (profileId) => {
        broadcastOmnicodeInstanceEvent({ profileId, type: "remoteHostExited" });
      },
    };
    setupOmnicodeRemoteForwardHost(forwardDeps);
    // [OmniCode] 丙1 远程聚合 R4：装配即 seed（跨账号开关侧车缓存 + 管理器自身账号族
    // 键；fire-and-forget，读失败保持缺省关/同账号——事件驱动收敛，不阻断装配）。
    void seedOmnicodeRemoteCrossAccountPrefFromSidecar();
    void seedOmnicodeAccountFamilyOwnKey();
  }
  // [OmniCode] D12 接管流协调器装配（桥命令直发 + 锁直读 workspaceLocks 只读原语——
  // 锁核心语义零改动；显示名解析经 Profile 注册表 listOmnicodeProfiles，防伪造）。
  // 审计 R1 遗留 1 收口：协调器仅 omnicode flavor 装配（官方 flavor 无桥消息，死装配
  // 无害但求洁净；实例进程已在函数顶部整体 return）。钩子面照常挂载——internals 缺席
  // 时 handleOmnicodeTakeover* 全部 no-op，官方零改动语义不变。
  if (ZCODE_PRODUCT_FLAVOR === "omnicode") {
    setupOmnicodeTakeoverCoordinator({
      readLockOwner: (workspacePath): OmnicodeTakeoverLockOwnerView | undefined => {
        // 读失败上抛（审计 R1 P2-3）：协调器"读失败→holder-offline"分支负责收口；此前
        // catch 吞成 undefined 会让协调器误判"无主锁→直接 accepted"，回执语义失真。
        const owner = readWorkspaceLockOwner(workspacePath);
        return owner
          ? {
              profileId: owner.profileId,
              ...(owner.displayName ? { displayName: owner.displayName } : {}),
            }
          : undefined;
      },
      getConnectedProfileIds: () => getOmnicodeConnectedInstanceProfileIds(),
      sendCommand: (profileId, command) => sendOmnicodeInstanceCommand(profileId, command),
      resolveProfileDisplayName: async (profileId) => {
        try {
          const profiles = await listOmnicodeProfiles();
          return profiles.find((profile) => profile.id === profileId)?.name ?? null;
        } catch {
          return null;
        }
      },
    });
  }

  // 装配时初始化持久化模式（窗口引用由 index.ts 在主窗口创建后补挂）
  void setupOmnicodeConsoleEmbedding();
}

/**
 * [OmniCode] 批次2 B2-3：控制台视窗 IPC（仅管理器装配，spec §批次2 D9）。
 * [OmniCode] 批次3 停靠重构：UiStateSet 携带每实例停靠态（dockAll/dockInstance/dockDefault
 * ——console-ui.json 持久化；dock 字段变化触发 owned 编排/解除，见 consoleEmbedding）。
 * - EmbedLayout：renderer 卡片画面区客户区矩形上报（换算/下发在 consoleEmbedding）；
 *   响应携带本轮 CSS→DIP 纵向换算比例（renderer resize 手柄下限钳制依据）。
 * - PreviewState：总开关 + 视口内卡片集合 → 桥订阅对账。
 * - RevealDataDir：系统文件管理器打开实例数据目录。
 * - PerfState：性能面板采样开关（批次2.5 X1，spec: docs/omnicode/console-extras.md §X1）。
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
      // [OmniCode] 批次3 停靠重构：patch 携带 dock 字段才触发编排（per-instance diff
      // 在 consoleEmbedding 内完成——toDock/toUndock 相对镜像判定，幂等）。
      const dockTouched =
        patch?.dockAll === true ||
        patch?.dockAll === false ||
        patch?.dockInstance !== undefined ||
        typeof patch?.dockDefault === "boolean";
      if (dockTouched) {
        await applyOmnicodeConsoleDockStateChange({
          dockDefault: merged.dockDefault,
          dockedByProfileId: merged.dockedByProfileId,
        });
      }
      if (current.previewEnabled !== merged.previewEnabled) {
        // 保留 renderer 最近上报的可见集合，只翻总开关（清零会丢订阅直到下一拍上报）
        applyOmnicodePreviewEnabled(merged.previewEnabled);
      }
      // [OmniCode] 实例元数据批次：排序态变化（sortMode/customOrder）同步托盘菜单顺序
      //（三处一致：托盘与网格/设置列表共用同一排序函数与同一持久化态）。
      // 审计 R2 复核 P3：停靠态（dockDefault/dockedByProfileId）变化同样触发托盘缓存刷新
      // ——「平铺全部」enabled 依赖未停靠运行计数，切换停靠后及时收敛（不再等下一次运行态事件）。
      if (
        current.sortMode !== merged.sortMode ||
        JSON.stringify(current.customOrder ?? []) !== JSON.stringify(merged.customOrder ?? []) ||
        current.dockDefault !== merged.dockDefault ||
        JSON.stringify(current.dockedByProfileId ?? {}) !== JSON.stringify(merged.dockedByProfileId ?? {})
      ) {
        refreshOmnicodeTrayNameCache();
      }
      return merged;
    },
  );

  ipcMain.handle(PlatformChannels.OmnicodeConsoleEmbedLayout, async (_event, input: unknown) => {
    applyOmnicodeConsoleEmbedLayout(normalizeEmbedLayoutInput(input));
    return { ok: true, scale: getOmnicodeConsoleEmbedScale() };
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

  // [OmniCode] 批次2.5 X1：性能面板采样开关（面板开=main 周期采样并广播 OmnicodePerfEvent；
  // 降级语义/生命周期见 spec: docs/omnicode/console-extras.md §X1 与 perfMonitor.ts 注释）
  ipcMain.handle(PlatformChannels.OmnicodePerfState, async (_event, input: unknown) => {
    const normalized = (input ?? {}) as { enabled?: unknown };
    applyOmnicodePerfPanelState(normalized.enabled === true);
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
        // [OmniCode] B2 评审修复（P2-11①）：main 侧无 i18n 机制，畸形入参的兜底名改为
        // 语言无关的 "instance-adopted"（正常路径 renderer 始终传本地化名称，不走此值）
        typeof input?.name === "string" ? input.name : "instance-adopted",
        getOmnicodeConsoleDataBaseDir(),
      );
      return { profile: { ...profile, running: false } };
    },
  );
}

/**
 * [OmniCode] 批次3：登录态看板 / 赛博鸡蛋 IPC（仅管理器装配；数据层，spec:
 * F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2/§3）。
 * - AccountSnapshotGet：看板快照（凭据快照 + billing/balance；main 侧 30min TTL 缓存，
 *   force=true 绕过强刷）。永不 reject（单账号失败归 entry 级原因键）。
 * - AccountClaimRun：启动逐张领取（mode: manual/auto 共用节奏器；启动即回 runId，
 *   进度/结算经 OmnicodeAccountClaimEvent 全窗口广播）。
 * - AccountDetectGet：赛博鸡蛋检测（逐账号 preview，main 侧汇聚；UI 批次入口——
 *   管理器启动一次/手动触发）。
 * - 自动领取轮询：autoClaimEnabled（console-ui.json）开启时 main 侧 30min 一拍，
 *   检测到可领账号 → claimRunner(mode auto)；共享节奏器，UI 无绕过路径。
 * 红线：token/设备号不进任何载荷/日志（billing 客户端只在请求头内使用一次）。
 */
function registerDesktopOmnicodeAccountIpcHandlers(): void {
  // 领取进度事件广播（main → renderer 全窗口；与 perfMonitor 同模式）
  const broadcastOmnicodeAccountClaimEvent = (payload: OmnicodeAccountClaimEventPayload): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlatformChannels.OmnicodeAccountClaimEvent, payload);
      }
    }
  };

  ipcMain.handle(
    PlatformChannels.OmnicodeAccountSnapshotGet,
    async (_event, input: unknown) => {
      // 防御性归一：force 仅接受显式布尔；畸形入参按普通拉取处理（不抛穿）
      const force = (input ?? {}) instanceof Object && (input as { force?: unknown }).force === true;
      return getOmnicodeAccountDashboardSnapshot({ force });
    },
  );

  ipcMain.handle(
    PlatformChannels.OmnicodeAccountClaimRun,
    async (_event, input: unknown) => {
      const mode = (input ?? {}) instanceof Object && (input as { mode?: unknown }).mode === "auto"
        ? ("auto" as const)
        : ("manual" as const);
      return startOmnicodeAccountClaimRun({
        mode,
        broadcast: broadcastOmnicodeAccountClaimEvent,
      });
    },
  );

  // [OmniCode] 批次3 UI 批次：赛博鸡蛋检测（逐账号 preview，main 侧汇聚 + 邮箱脱敏）
  ipcMain.handle(PlatformChannels.OmnicodeAccountDetectGet, async () =>
    detectOmnicodeClaimableAccounts(),
  );

  // [OmniCode] omni.5 真机修复（F2-5）：console 根 os: 旧密文迁移状态（unrecoverable
  // 标记 → 管理器 UI 明确重登引导；null=无标记）。任何读取异常按无标记降级。
  ipcMain.handle(PlatformChannels.OmnicodeConsoleCredentialStateGet, async () =>
    readConsoleRootOsMigrationMarker(getOmnicodeConsoleDataBaseDir()),
  );

  // 自动领取 30min 轮询（开关每次 tick 重读 console-ui；关闭态零网络请求）
  startOmnicodeClaimAutoPoll(createOmnicodeClaimAutoPollDeps(broadcastOmnicodeAccountClaimEvent));
}

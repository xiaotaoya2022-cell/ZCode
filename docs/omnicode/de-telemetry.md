# OmniCode 去遥测设计

> 状态：2026-11-10 M4a 实现 ｜ 2026-11-28 修订：放行两条设备级心跳（用户拍板"修"）｜ 上位：方案报告 §5.2 ｜ 参照：jidzhang/ZCode（Safe ZCode）SAFE-ZCODE.md
> 总开关：`packages/shared/src/env.ts` 的 `OMNICODE_TELEMETRY_DISABLED = true`（恒真；保留表达式便于未来分级放行）。

## 目标口径

软件默认安静，该联网时才联网：**行为遥测全零**（任何进程、任何时机都不外发使用行为数据），功能请求（登录、发消息、模型调用）不受影响。

## 2026-11-28 修订：设备级心跳放行（例外清单）

**放行范围（仅此两条，官方客户端每日本来就会发的最小事件）**：

| 事件 | 频率 | 内容边界 |
|---|---|---|
| `app_launch` | 每次应用启动一条 | 只有"这个设备这次启动了应用"（ui_mode 标注） |
| `app_daily_active` | 每天首启一条（`lastDailyActiveDate` 跨进程去重） | 只有"这个设备今天开过应用" |

- **为什么放行**：官方鸡蛋（免费额度）投放按设备活跃度定向，`POST /api/v1/event/report` 是唯一资格信号（端点已从官方安装包 asar 取证）。去遥测把端点置空后实例成为"哑巴设备"——投放永远不发生，鸡蛋功能对 OmniCode 实例整体失效（真机实证：VM 官方客户端有投放入口、同时间 OmniCode 实例没有）。
- **实现**：`telemetryCore.ts` `OMNICODE_HEARTBEAT_ENDPOINT` 专用通道 + `sendReport(endpointOverride?)`；两心跳入口传专用端点，行为埋点（reportEvent）走缺省空端点继续全禁。
- **红线不变**：`send_btn` / `message_completion` / `agent_step` / `session_create` 等一切行为埋点仍零外发；ARMS/autoUpdater/crash 上报处置不变。

## 通道清单与处置

| 通道 | 位置 | 处置 | 语义 |
|---|---|---|---|
| ARMS RUM（阿里云） | `packages/desktop/src/main/appARMSBootstrap.ts` | `enable: … && !OMNICODE_TELEMETRY_DISABLED`，`autoInject` 同步禁用 | SDK 即使被配端点也永不启用；Browser SDK 不注入任何 renderer |
| 数仓事件（zcode.z.ai `/event/report`） | `packages/services/src/telemetry/telemetryCore.ts` | `REPORT_ENDPOINT` 强制置空；**例外：`app_launch`/`app_daily_active` 走 `OMNICODE_HEARTBEAT_ENDPOINT` 放行** | 行为埋点（reportEvent）空端点闸门短路整条链；两心跳真实发送成功后才写 `lastDailyActiveDate`（2026-11-28 起恢复真实语义，此前本地假写） |
| 自动更新 | `packages/desktop/src/main/index.ts` → `initAutoUpdater` | `enabled: false` | electron-updater 实例不配置；日常包永不自更；发版只走 OmniCode Releases |
| Crash 上报 | `desktopCrashCapture.ts` | 保持 `uploadToServer: false` | 官方默认已是本地归档，无外发 |
| deviceMid（`X-Device-Mid`） | `desktopDeviceMid.ts` / `telemetryCore` | **保留** | 随机设备 UUID，不参与登录鉴权；随心跳与业务请求头外发 |

## 未做（后续分级）

- **7 类启动请求全停**（更新检查/升级提醒/灰度开关/帮助链接/模型列表/插件市场/远端小图标）：其中模型列表、插件市场是功能性数据，需逐项做本地回退才不破坏 UX；留到 M4c 单独逐项处理。
- ARMS preload 桥（`installArmsRumBridgeIpcForward`）转发的是空批次（init 禁用后 SDK 无采集），保留代码以减小 diff；如需彻底剔除在 M4c 一并处理。

## 验证方法

1. 启动魔改版，本机抓包（或 `desktopNetworkTelemetry` 日志）确认：无 `arms-gw` 域名；`/event/report` POST 仅限 app_launch/app_daily_active 两条心跳；
2. `git grep OMNICODE_TELEMETRY_DISABLED` 覆盖全部三个闸门；
3. 官方版同机对照抓包作差集。

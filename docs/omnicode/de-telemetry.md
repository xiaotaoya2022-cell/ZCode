# OmniCode 去遥测设计

> 状态：2026-11-10 M4a 实现 ｜ 上位：方案报告 §5.2 ｜ 参照：jidzhang/ZCode（Safe ZCode）SAFE-ZCODE.md
> 总开关：`packages/shared/src/env.ts` 的 `OMNICODE_TELEMETRY_DISABLED = true`（恒真；保留表达式便于未来分级放行）。

## 目标口径

软件默认安静，该联网时才联网：**遥测全零**（任何进程、任何时机都不外发使用数据），功能请求（登录、发消息、模型调用）不受影响。

## 通道清单与处置

| 通道 | 位置 | 处置 | 语义 |
|---|---|---|---|
| ARMS RUM（阿里云） | `packages/desktop/src/main/appARMSBootstrap.ts` | `enable: … && !OMNICODE_TELEMETRY_DISABLED`，`autoInject` 同步禁用 | SDK 即使被配端点也永不启用；Browser SDK 不注入任何 renderer |
| 数仓事件（zcode.z.ai `/event/report`） | `packages/services/src/telemetry/telemetryCore.ts` | `REPORT_ENDPOINT` 强制置空 | `sendReport` 入口的空端点闸门短路整条 reportEvent 链（含鉴权读取与重试） |
| 自动更新 | `packages/desktop/src/main/index.ts` → `initAutoUpdater` | `enabled: false` | electron-updater 实例不配置；日常包永不自更；发版只走 OmniCode Releases |
| Crash 上报 | `desktopCrashCapture.ts` | 保持 `uploadToServer: false` | 官方默认已是本地归档，无外发 |
| deviceMid（`X-Device-Mid`） | `desktopDeviceMid.ts` / `telemetryCore` | **保留** | 随机设备 UUID，不参与登录鉴权；数仓通道停用后仅剩业务请求头用途，删除有接口兼容风险 |

## 未做（后续分级）

- **7 类启动请求全停**（更新检查/升级提醒/灰度开关/帮助链接/模型列表/插件市场/远端小图标）：其中模型列表、插件市场是功能性数据，需逐项做本地回退才不破坏 UX；留到 M4c 单独逐项处理。
- ARMS preload 桥（`installArmsRumBridgeIpcForward`）转发的是空批次（init 禁用后 SDK 无采集），保留代码以减小 diff；如需彻底剔除在 M4c 一并处理。

## 验证方法

1. 启动魔改版，本机抓包（或 `desktopNetworkTelemetry` 日志）确认：无 `arms-gw` 域名、无 `/event/report` POST；
2. `git grep OMNICODE_TELEMETRY_DISABLED` 覆盖全部三个闸门；
3. 官方版同机对照抓包作差集。

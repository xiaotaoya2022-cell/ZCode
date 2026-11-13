# 控制台附加能力（批次 2.5，X1-X4）

> spec-first 事实源：本文件定义 X1 性能监控面板 / X2 登录态健康度徽标 / X3 托盘实例快捷菜单 /
> X4 控制台轻美化的数据源、降级语义与菜单行为。设计来源 `F:\OmniCode\docs\batch2\BATCH3-EXTRAS-PLAN.md`。
> 红线：全部改动限于**管理器侧**（main 新模块 + ConsoleHome/UI 层 + i18n + shared 契约），
> 不改实例侧运行链路/锁/身份；不改实例桥协议（X3 的 `focusRequested` 是 main→renderer 事件
> 广播通道的新载荷值，非桥协议）。

## X1. 性能监控面板

### 数据源与取舍

- **跨进程内存**：复用 P2-11② 的 tasklist CSV 单次快照管线（`readOmnicodeProcessMemoryMBs`），
  扩展为周期采样（间隔 5s，`PERF_SAMPLE_INTERVAL_MS`）。
- **CPU**：tasklist 不提供 CPU 占用列 → **内存先行，CPU 显示 `—`**（已知限制，见下）。
  评估过 `Get-Process` CPU 时间差分与 `Win32_PerfFormattedData_PerfProc_Process`，均可实现但
  引入第二条子进程管线与核数归一化误差，v1 不做（记录于纪要）。
- **官方 processResourceSampleSources 复用评估**：不采用。该注册表的 source 采样的是**本进程**
  各角色（chromium/renderer heap/cli）的进程内指标，不是按外部 pid 的跨进程采样——实例是
  独立进程树，管理器无法从这些 source 拿到实例数据；tasklist 管线已是现存跨进程事实源。

### 采样生命周期（仅面板打开时采样）

- renderer 上报 `OmnicodePerfState {enabled}`（面板开关 = console-ui.json 持久化的
  `perfPanelOpen`，语义与 PreviewState 同构）；`enabled=true` 即启动采样 timer（unref），
  `enabled=false` 停止。重新 enable 会重置失败计数并立即采一轮（给降级后的重试留出口）。
- 每轮 tick：取 `listOmnicodeRunningInstances()` 的 pid 集合 → 单次 tasklist → 按实例广播
  `OmnicodePerfEvent {type:"sample", samples:[{profileId,memoryMB}]}`；**零运行实例时广播空
  samples**（面板显示"无运行实例"，不 spawn tasklist）。
- **降级语义（任一环节不可得整面板隐藏，绝不空转）**：
  - 非 win32 平台：首次 enable 即广播 `{type:"unavailable", reason:"platform"}` 并不启动 timer；
  - tasklist 查询失败（`readOmnicodeProcessMemoryMBs` 返回 undefined）连续 ≥2 次（阈值
    `PERF_DEGRADE_FAILURE_THRESHOLD`）：广播 `{type:"unavailable", reason:"probe"}`、停 timer；
  - renderer 收到 unavailable 即隐藏「性能」入口（面板 UI 整体不可见，不空转重试）。
    用户下次显式开关面板（或重启后 `perfPanelOpen=true`）会重新走一次 enable 全流程。
- tick 决策纯函数 `resolveOmnicodePerfTickAction({enabled, platform, runningCount,
  consecutiveFailures})` → `"sample" | "empty" | "degrade" | "stop"`（单测锁定）。

### UI

- 控制台工具行「性能」按钮（Activity 图标）→ 右侧抽屉面板；每实例一行（名称 + 当前 MB +
  纯 SVG spark 曲线）+ 顶部全局合计。spark 数据 = renderer 侧环形缓冲（容量 60 点 × 5s ≈
  近 5 分钟），环形缓冲与 sparkline 路径计算为纯函数（`packages/ui/src/console/perfSpark.ts`，
  单测锁定；面板中途打开时曲线从空开始累积，接受）。
- 面板开关记忆：`console-ui.json` 新增可选字段 `perfPanelOpen`（缺省=关；旧档无该字段自然
  回退关闭）。CPU 列显示 `—`。

## X2. 登录态健康度徽标

### 数据路径决策：管理器直读（方案 a）

- 管理器 main 进程与实例**同源代码**，直接 import 底层解密件：读 profile 数据根
  （`dataBaseDirOverride ?? profileDir`）下 `.zcode/v2/credentials.json`（明文 JSON，值为密文）
  与 `.zcode/v2/credential-secret`（密钥文件），经
  `createSystemCredentialCipher({ filePath, env: { ZCODE_CREDENTIAL_SECRET } })` 解密
  `oauth:<provider>:expires_at` 值。env 注入密钥时 cipher 的 `getKey` 走 `source="env"` 短路
  （`systemCredentialCipher.ts` getManagedSecret 先于 keyring 路径），**不触发 OS keyring、
  不触发文件锁、不产生任何写入**——与"绝不走会触发迁移/写入的 repo 高层操作"约束一致
  （不走 oauthCredentialRepo / credentialService 的任何读写 API）。
- 方案 b（桥上报）不需要：解密依赖在管理器进程可用（desktop 已有
  `@zcode/shared/credential-security` 导入先例）。
- 兼容面：`enc:v2:env:` 与 legacy `enc:v1:` 均可解（legacy 候选密钥表含注入密钥）；
  收养根的 `enc:v2:os:` 旧密文 source 不匹配 → 解密抛错 → 未知态（如实降级）。

### 分级语义（纯函数 `resolveOmnicodeLoginHealth`，单测锁定）

- 取 `oauth:active_provider` 指向 provider 的 expiresAt；active 缺失/非法时取全部已知 provider
  （zai / zai_cn / bigmodel）有效 expiresAt 的最大值；全无 → `unknown`（未登录或读不到）。
- `expired`：now ≥ expiresAt；`expiring`：剩余 ≤7 天（按毫秒差值 ceil 成天数，边界=7 天整属
  expiring）；`healthy`：其余，附 `daysRemaining`/`expiresAt`。
- **任何读失败 = 未知态静默**（文件缺失/JSON 损坏/密钥缺失/解密失败均不告警不阻塞列表）。

### 呈现

- Profile 列表 IPC（`OmnicodeProfileList`）每项附 `loginHealth?: {status, daysRemaining?,
  expiresAt?}`（shared 契约可选字段，官方 flavor 不填充不受影响）。
- 卡片徽标：● 健康（剩 N 天，绿）/ ⚠ 即将到期（黄）/ ✕ 已过期（红）/ ○ 未知（灰），
  `title` 提示精确剩余时间（天+小时）；i18n 中英。**停止实例但登录态健康 = 黄色调**
  （"仅剩登录态"语义：实例没跑，登录态还活着）。

## X3. 托盘实例快捷菜单

- **扩展现有 desktopTray**（不新建第二个 Tray）：`createDesktopTray` 新增可选
  `buildOmnicodeSection`（仅 omnicode 管理器主进程注入），插在「打开」与既有菜单项之间。
- 菜单结构：运行实例区（每实例一项，label=状态点+实例名，点击=**聚焦该实例**）+
  「启动全部」（有停止实例才可用）/「停止全部」（有运行实例才可用）+ 既有「打开/退出」
  （退出走既有 quitApp → markExplicitQuit → prepareAppQuit 屏障，屏障内已 await
  `releaseOmnicodeEmbedForQuit`，无新增退出路径）。菜单模型纯函数
  `buildOmnicodeTraySectionModel`（单测锁定）。
- **聚焦链路**：托盘点击实例项 = 显示管理器主窗口 + 桥 `focus` 命令（拉起实例窗口，与卡片
  「聚焦」菜单同一链路）+ 广播 `OmnicodeInstanceEvent {type:"focusRequested"}` → renderer
  网格把对应卡片 `scrollIntoView` 并短暂高亮。该事件值是 main→renderer 广播通道的**追加
  载荷值**，管理器专属广播（实例进程无此 IPC handler 面），不改实例桥协议。
- **动态重建**：instanceManager 运行态变化（launch 确认/exit/error/stop/reconcile/批量操作）
  通知订阅者 → 刷新实例名缓存（profile.json）→ `updateWindowsDesktopTrayMenu()` 重建
  （500ms 去抖吸收 launch/stop 风暴）。
- 启动全部/停止全部：instanceManager 新增 `launchAllOmnicodeProfiles` / `stopAllOmnicodeInstances`
  （逐实例复用现有 launch 串行链与三段式优雅停；并行发起、allSettled 收口，失败仅告警）。

## X4. 控制台前端轻美化

- 0 实例空状态：纯 CSS/SVG 小插画（堆叠卡片+播放符）+ 既有 i18n 文案 + 「创建第一个实例」
  按钮（复用既有 `console.emptyCreate`）。
- hover 过渡统一：卡片 `transition` 统一时长/曲线；状态色语义统一：运行=绿点、停止=灰点、
  登录徽标色见 X2（停止+健康=黄）。只动样式层与空状态，不动布局逻辑与数据流；只用现有
  shadcn/ui token 与 Tailwind 类，不引入依赖。

## 已知限制（如实记录）

1. X1 CPU 列 v1 为 `—`（内存先行）；采样为 tasklist 快照，与任务管理器的瞬时值有秒级偏差。
2. X1 曲线在面板打开期间从空累积（renderer 侧环形缓冲不跨会话持久化）。
3. X2 收养根的 `enc:v2:os:` 旧密文无法在管理器侧解密（source 不匹配）→ 未知态；该根实例
   重新登录一次后即为 env 密文，恢复可见。
4. X3 托盘实例项点击的"聚焦卡片"依赖管理器窗口存活；主窗口销毁期间点击只显示/重建主窗口。
5. X3/X4 与 X1 面板均未做 GUI 运行时实测（本环境无显示），归 omni.4 发版前人工验收清单。

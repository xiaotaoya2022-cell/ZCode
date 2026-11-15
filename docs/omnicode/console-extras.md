# 控制台附加能力（批次 2.5，X1-X4 + 批次 3，X5-X6）

> spec-first 事实源：本文件定义 X1 性能监控面板 / X2 登录态健康度徽标 / X3 托盘实例快捷菜单 /
> X4 控制台轻美化 / X5 账号看板 / X6 赛博鸡蛋一键领取的数据源、降级语义与菜单行为。
> 设计来源 `F:\OmniCode\docs\batch2\BATCH3-EXTRAS-PLAN.md`（X1-X4）、
> `F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md` §2/§3（X5-X6）。
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

### 采样生命周期（仅面板打开且有人可见时采样）

- renderer 上报 `OmnicodePerfState {enabled}`（面板开关 = console-ui.json 持久化的
  `perfPanelOpen`，语义与 PreviewState 同构）；`enabled=true` 即启动采样 timer（unref），
  `enabled=false` 停止。重新 enable 会重置失败计数并立即采一轮（给降级后的重试留出口）。
  renderer 上报 effect 带 cleanup：组件卸载/开关切换时兜底补发 `enabled=false`，窗口销毁
  或离开控制台页不留采样尾巴（R1 P1-1）。
- **窗口可见性自愈（R1 P1-1）**：主窗口默认 hide-to-tray，隐藏后 renderer 存活但无人可见——
  main 侧每轮 tick 检查可见窗口数（`BrowserWindow.isVisible()`，最小化仍算可见），全部隐藏
  时本轮 **pause-invisible**：不 spawn tasklist、不广播、失败计数不推进，仅保留 unref timer
  等下一 tick 复查；窗口重新 show 后**自动恢复采样**（无需 renderer 重发 enable）。停采的是
  子进程与广播，不是 tick 心跳（无观察者时空 tick 成本 ≈ 一次 setTimeout 回调）。
- **退出收尾（R1 P1-1）**：`shutdownOmnicodePerfSampler()`（幂等）接入 main `prepareAppQuit`
  屏障（与 `releaseOmnicodeEmbedForQuit` 同屏障模式），退出时停采并复位 panelEnabled。
- 每轮 tick：取 `listOmnicodeRunningInstances()` 的 pid 集合 → 单次 tasklist → 按实例广播
  `OmnicodePerfEvent {type:"sample", samples:[{profileId,memoryMB}]}`；**零运行实例时广播空
  samples**（面板显示"无运行实例"，不 spawn tasklist）；上一轮 tasklist 未返回时本轮跳过
  （sampling 防并发，不叠加 spawn）。
- **降级语义（任一环节不可得整面板降级，绝不空转）**：
  - 非 win32 平台：首次 enable 即广播 `{type:"unavailable", reason:"platform"}` 并不启动 timer；
  - tasklist 查询失败（`readOmnicodeProcessMemoryMBs` 返回 undefined）连续 ≥2 次（阈值
    `PERF_DEGRADE_FAILURE_THRESHOLD`）：广播 `{type:"unavailable", reason:"probe"}`、停 timer；
  - renderer 收到 unavailable 即本地关闭面板并 toast，但**「性能」入口保留可点击**（R1 P2-1）：
    显式点击 = 一次重探（重发 enabled=true → main 重置失败计数立即采一轮）；再失败再次收到
    unavailable 广播回落，一次点击只重探一次，**无自动循环重试**。重启后
    `perfPanelOpen=true`（持久化值未被降级翻转）同样自动走一次 enable 全流程。
- tick 决策纯函数 `resolveOmnicodePerfTickAction({enabled, platform, runningCount,
  consecutiveFailures, visibleWindowCount})` →
  `"sample" | "empty" | "pause-invisible" | "degrade-platform" | "degrade-probe" | "stop"`
  （分支序 stop > platform > pause-invisible > probe > empty > sample，单测锁定）。

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
- **密钥文件空白/长度语义与实例侧 canonical 对齐（R1 P2-2）**：跟随实例侧
  `systemCredentialCipher.resolveManagedSecret` ——原样读取**不 trim**，按
  `Buffer.byteLength` 判界（32..4096 字节）。手工编辑过的密钥文件带尾随空白时，
  实例照常用含空白的原始字节解密，管理器侧同字节判定/解密，两侧结论不分叉。
- **文件读有界防御（R1 P2-6）**：node 同步 IO 语义下无真超时可用，读前 `stat` 校验
  常规文件且不超上限（`credential-secret` ≤4096 字节；`credentials.json` ≤256 KiB，
  真实快照为 KB 量级）——越界/读失败一律归 unknown 静默，Profile 列表不被病态大文件
  拖长；`credentials.json` 必须为 JSON **对象**（数组等其它合法 JSON 同样归 unknown）。

### 分级语义（纯函数 `resolveOmnicodeLoginHealth`，单测锁定）

- 取 `oauth:active_provider` 指向 provider 的 expiresAt；active 缺失/非法时取全部已知 provider
  （zai / zai_cn / bigmodel）有效 expiresAt 的最大值；全无 → `unknown`（未登录或读不到）。
- `expired`：now ≥ expiresAt；`expiring`：剩余 ≤7 天（按毫秒差值 ceil 成天数，边界=7 天整属
  expiring）；`healthy`：其余，附 `daysRemaining`/`expiresAt`。
- **任何读失败 = 未知态静默**（文件缺失/JSON 损坏/密钥缺失/解密失败均不告警不阻塞列表）。

### 呈现

- Profile 列表 IPC（`OmnicodeProfileList`）每项附 `loginHealth?: {status, daysRemaining?,
  expiresAt?}`（shared 契约可选字段；填充方为管理器进程的列表 handler（与 flavor 无关走同一
  代码），官方 flavor 无 omnicode profile（列表为空）故实际不出现，R1 P2-5 勘误对齐）。
- 卡片徽标：● 健康（剩 N 天，绿）/ ⚠ 即将到期（黄）/ ✕ 已过期（红）/ ○ 未知（灰），
  `title` 提示精确剩余时间（天+小时）；i18n 中英。**停止实例但登录态健康 = 黄色调**
  （"仅剩登录态"语义：实例没跑，登录态还活着）。

## X3. 托盘实例快捷菜单

- **扩展现有 desktopTray**（不新建第二个 Tray）：`createDesktopTray` 新增可选
  `buildOmnicodeSection`（仅 omnicode 管理器主进程注入），插在「打开」与既有菜单项之间。
- 菜单结构：运行实例区（每实例一项，label=状态点+实例名，点击=**聚焦该实例**）+
  「启动全部」（有停止实例才可用；**0 profile 时禁用**，R1 P2-3——判据为名称缓存条目数，
  不再 max(...,1) 兜底）/「停止全部」（有运行实例才可用）+ 既有「打开/退出」
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

## X5. 账号看板（批次 3，登录态/账号管理第二视图）

### 视图与入口

- ConsoleHome 头部加「账号看板」切换钮（图标循环切换，网格↔看板二视图）。**视图态存
  内存不落盘**：管理器主语义 = 实例管理中枢（批次2a 方案 A——首屏永远是网格），看板是
  瞬时检视面，重启回落网格；避免 console-ui.json 加字段/迁移，重启语义可预期。
- 看板视图挂载时整体卸载实例网格。网格卸载收尾上报**空 embedLayout 矩形集 + 清空预览
  订阅**（main dispatchEmbedLayout 对「不在上报集中」的 owned 窗口走 P2-9 隐藏语义），
  避免看板视图下停靠窗口悬停残留；切回网格时挂载 effect 重新上报即恢复贴合。

### 数据源与刷新节奏（数据层复用，UI 零直接网络）

- 数据 = `OmnicodeAccountSnapshotGet`（凭据快照 × billing/balance；main 30min TTL 缓存，
  force 绕过强刷）。挂载拉一次；「全部刷新」= force 强刷。
- 汇总条（总数/健康/临期/异常/未知 + 最后刷新时间）：分档计数与 X2 徽标**同一口径**
  （Profile 列表 loginHealth，纯函数 `resolveOmnicodeLoginHealthCounts` 单测锁定）；
  不重实现分级（唯一口径在 main `readOmnicodeLoginHealths`）。
- 卡片字段 = Cockpit 口径（套餐名/额度分桶求和/重置时间/套餐到期/最后刷新）+ OmniCode
  增强：登录健康度四态徽标（**复用 X2 LoginHealthBadge 组件**，不重写）、实例归属与
  运行态点。余量分档配色沿用 Cockpit：<10% 红、<30% 黄、<60% 中性、其余蓝。
- 异常卡引导优先于数字：missing_jwt=未登录、skipped_no_device_mid=缺设备号（红线：绝不
  代生成）、failed=查询失败（原因键文案显示 + 打开实例引导）、unknown=旧密文/读不到。
- 「刷新」单卡钮的取舍：数据层只有整表快照一个杠杆——单卡刷新也是 force 整表强刷
  （本卡转刷新态、其余卡静默更新），频率红线由 TTL + main 串行编排兜住。
- 平台方法缺席（官方 flavor / 旧 preload）：整视图降级为不可用提示，不报错。

## X6. 赛博鸡蛋一键领取（批次 3，左下浮层）

### 检测（门票叠数据源）

- 检测 = 对每个可用账号调 preview（走既有 billingClient，实例不必在运行——凭据在盘上），
  main 侧逐 profile 串行后经 `aggregateOmnicodeClaimDetection` 汇聚（纯函数，单测锁定），
  邮箱在 main 侧脱敏（`maskOmnicodeAccountEmail`）后才进 IPC 载荷。
- 触发节奏（红线，无循环重试）：管理器启动一次（浮层挂载拉取）+ 设置分区「手动检测一次」
  + 自动领取开启时 main 侧 30min 轮询（`claimAutoPoll`，每 tick 重读 console-ui 的
  autoClaimEnabled——开关翻转即时生效；关闭态零网络请求）。
- 新通道 `OmnicodeAccountDetectGet`（request→response）；自动领取的结果经既有
  `OmnicodeAccountClaimEvent` 全窗口广播到达 renderer（runId 区分 manual/auto run）。

### 浮层交互（对标演示稿 02 节）

- 无蛋/无票空闲态**整个浮层不渲染**（左下角干净无痕）；有可领账号 = 门票叠（每账号一张，
  4 个错落位钳制 + ×N 角标，hover 散开见各账号——纯 CSS transform，纯函数
  `buildOmnicodeTicketStackLayout` 单测锁定）。
- 点击门票叠 → `OmnicodeAccountClaimRun(mode manual)`：订阅 ClaimEvent 播逐张动效
  （当前张飞出→「账号 +到账额度」chip + 顶部「领取中 x/N」），随时「跳过动画」
  （停动效等待真实结果，到齐即结算）；右键菜单「静默全部领取」= 同 mode manual 不播动效。
  结束态「今日已领取 N 份额度·合计 +X」（纯函数 `summarizeOmnicodeClaimSettlement`
  单测锁定；全部缺省数值时合计不编造 0）。
- 自动领取（mode auto）：领取中不打扰（无动效，逐张静默清票）；完成后左下角结算徽章
  「今日已自动领取 N 份」，点开明细 = console-ui claimHistory 的今日 auto 条目
  （`summarizeOmnicodeAutoSettlementFromHistory` 单测锁定——自动领取可能发生在管理器
  窗口关闭期间，挂载时按历史补徽章）。
- 领取历史列表落在设置「自动化」分区（见下）。

### 设置「自动化」分区（omnicodeAutomation，desktop-only）

- settingsPageConfig 新分区 + 管理器白名单追加（与 omnicodeProfiles desktop-only 同构）。
- 内容：自动领取总开关（读写 console-ui `autoClaimEnabled`；开关旁说明文案——检测到每日
  免费额度时以低风控节奏自动领取，各账号用自己的凭据与设备号）+「手动检测一次」（走
  DetectGet，toast 汇报 N 可领）+ 领取历史列表（时间/账号/plan/结果/额度，FIFO 50）。

### 红线（不变）

- token/设备号不进任何 IPC 载荷/日志；管理器绝不生成/共享设备号；领取节奏全部在
  main 数据层（claimPacer 300-1500ms 抖动 + 连发保护），UI 无绕过路径；1001-1005
  terminal 失败码显示原因、不自动重试。

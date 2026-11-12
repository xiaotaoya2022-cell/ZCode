# OmniCode Profile Runtime（原生多开与实例隔离）

> 状态：2026-11-10 M1 实现依据 ｜ 2026-11-12 修订：身份通道改 argv/env 直传（D6，handoff 退役）＋启动确认/串行链真串行/启动=重启/三段式优雅停 ｜ 上位设计：《ZCode 原生魔改版架构与实现方案报告》§2（OmniCode 仓 docs/）
> 适用：`packages/desktop` 桌面端。本文是行为改动的 spec 事实源；实现与本文冲突时，先改本文。

## 目标与边界

**目标**：在源码层替代第三方多开工具——一个魔改端作为**控制台（Console）**，管理多个相互隔离的 **Profile 实例**（每个实例是完整的 ZCode 桌面进程，独立凭据/会话/Chromium 存储），重启不掉线。

**M1 边界（本文覆盖）**：
- Profile 注册表（创建/列表/克隆/删除）
- 实例编排（启动/停止/状态查询）
- `--omnicode-profile=<id>` argv 身份注入
- 设置页「OmniCode 多开」管理 UI + IPC

**明确延后（不在 M1）**：`zcode://` 回调按实例路由（M1.5）、OAuth 刷新链路（M1.5）、实时视窗网格（M2）、`--omnicode-console` 独立控制台模式窗口（M2，M1 用设置页承担管理职能）。

## 目录与数据模型

```
~/.omnicode/                       ← OmniCode 自有数据根（与 ~/.zcode 完全分离）
  console.json                     ← 控制台设置（profileRoot 覆盖等）
  profiles/
    <profileId>/
      profile.json                 ← 身份事实源（唯一）
      .zcode/v2/…                  ← 该实例全部业务数据（凭据/会话/sqlite/logs/setting.json）
      electron-userdata/           ← Chromium userData
      electron-session/            ← Chromium sessionData
      logs/instance-boot.log       ← 实例启动诊断日志（stdout/stderr 追加落盘）
```

- `profileId`：`p` + 时间戳+随机后缀（ASCII、目录名安全、不可变）。`displayName` 用户可改。
- `profile.json` 字段：`{ id, name, createdAt, notes? }`
- 环境变量 `OMNICODE_PROFILE_ROOT` 可覆盖 profiles 根目录（开发/测试用）。
- **setting.json 按实例隔离**（2026-11-12 修订）：身份注入含 `ZCODE_DESKTOP_HOME_DIR=<profileDir>`，`settingService.resolveUserHomeDir` 优先读该 env → 实例的 `~/.zcode/v2/setting.json` 落 `<profileDir>/.zcode/v2/setting.json`（官方 lastActiveWorkspace 等 settings 不再跨实例/与官方安装版串流；同一 env 同时驱动实例侧 `app.setPath("home")`，home 级默认目录同源隔离。AGENTS.md 定位只认 `HOME/USERPROFILE`，保持全局共享）。

## 产品规则

1. **身份注入五件套**（2026-11-12 D6 修订：身份通道 = 控制台 spawn 时 argv + env 一次性同步注入，无跨进程文件握手。argv `--omnicode-profile=<profileId>` 是主身份来源；spawn env 同时注入数据根/存储/桥接回连信息；实例 bootstrap 在**最早导入点**用 argv 自派生重赋值同一组 env（双保险、产出一致）。旧 handoff 文件机制已退役——原因：一次性文件存在"读取即删 vs 退出登录 relaunch 原样重放旗标"与"非原子写 vs 读后删"两类竞态，relaunch 后身份丢失变裸进程；spawn 参数面是原子的，无此窗口。profileId 经白名单正则校验后可进命令行——形态受控、无敏感语义，不违反输入白名单规则 8）：
   - `ZCODE_DESKTOP_APPLICATION_NAME=OmniCode-<profileId>`（决定单实例锁归属与托盘/任务栏身份；bootstrap 派生）
   - `ZCODE_DESKTOP_USER_DATA_DIR=<profileDir>/electron-userdata`
   - `ZCODE_DESKTOP_SESSION_DATA_DIR=<profileDir>/electron-session`
   - `ZCODE_DATA_BASE_DIR=<profileDir>`（凭据/会话/sqlite 全部落 profile 内）
   - `ZCODE_DESKTOP_HOME_DIR=<profileDir>`（settingService resolveUserHomeDir / `app.setPath("home")` 的 home 概念 → setting.json 按实例隔离，见 §目录与数据模型；AGENTS.md 定位只认 `HOME/USERPROFILE`，保持全局共享）
   - 桥接回连：`OMNICODE_BRIDGE_PORT` / `OMNICODE_BRIDGE_TOKEN`（spawn env 注入；console 侧白名单校验 port 为正整数、token 为 32 位 hex，实例侧 `startOmnicodeInstanceBridgeClient` 独立校验）
   - （不注入 `ZCODE_CREDENTIAL_SECRET`：数据目录隔离已保证凭据隔离与持久——官方 fallback 密钥派生绑定 `homedir:username`，多开不触碰 homedir 即天然稳定；per-profile 密钥需打通 host env 继承链，收益为纵深防御，延后至 M1.5 评估）
   - **快速失败**：带身份旗标（`--omnicode-profile` / 已退役的 `--omnicode-handoff`）但解析不出合法 profileId 的实例进程必须 `process.exit(1)`（裸进程会与主实例共用 userData → 抢单实例锁 + 数据根回落，比显式失败危险）。relaunch 场景由 `buildOmnicodeInstanceRelaunchArgs()` 从 `OMNICODE_PROFILE_ID` env 显式重建 `["--omnicode-profile=<id>"]`（dev 态含 appPath），实例身份跨退出登录续接。
2. **禁止注入** `HOME`/`USERPROFILE`（会改变官方 fallback 凭据密钥派生 → 掉线根因，见上位报告 §2.2）。
3. **实例与控制台互不抢锁**：实例 userData 各自独立；控制台以 `--omnicode-console` 启动时将应用身份设为 `OmniCode Console`（与官方安装版、Profile 实例三者 userData 互斥）。开发态沿用 `ZCode Dev`。
4. **生命周期**（2026-11-12 修订）：
   - **启动** = `child_process.spawn` argv 数组直传：`[appPath(dev), "--omnicode-profile=<id>"]`（packaged 用 `process.execPath`，开发态 electron.exe + appPath，appPath 是 dev 态首参），身份 env 随 spawn 原子注入（见规则 1）。
   - **启动确认**（P0-2）：spawn 后进入 ~750ms 稳定窗口——窗口内未退出即确认成功；窗口内 `exit`/spawn 错误 → 快速失败并抛带原因的 Error（IPC reject → UI toast 透出，不再静默裸奔）。实例 stdout/stderr 管道追加落 `<profileDir>/logs/instance-boot.log`（fail-safe，写入失败仅告警）。
   - **启动=重启**（P1-4）：对已运行实例的 launch 语义改为"先优雅停再启动"，不再是幂等返回现有 pid；停止目标在串行链内实时取，避免并发 stop 竞态。
   - **停止** = 三段式优雅停（P1-7，pid 驱动，不依赖 child 句柄）：Windows `taskkill /PID <pid> /T`（不带 /F = WM_CLOSE 优雅）→ 轮询存活（tasklist /FI，超 ~2s）→ `taskkill /PID <pid> /T /F` 强杀 → 复查 → 仍残留抛错带 pid；unix SIGTERM → 轮询 → SIGKILL。pid 存活探测 Windows 用 tasklist 查 OS 进程表（比 `process.kill(pid,0)` 可靠：后者会因本进程仍持有已退出子进程句柄而误报存活），查询失败按"存活"保守处理（宁可误报残留，不可谎报已停）。
5. **删除保护**：实例运行中禁止删除/克隆该 Profile；先停止。
6. **凭据自愈边界**：实例读取凭据解密失败时，先尝试「当前密钥重加密」不成立则**备份后保留现场并提示重新登录**，禁止静默清空（官方 `clearCorruptOAuthSession` 行为的收口，实现于 M1-5）。
7. 状态唯一所有者：**运行状态**归控制台主进程 `InstanceRegistry`（内存态，进程重启即重建，不持久化"运行中"）；**Profile 定义**归 `profile.json` 文件（唯一持久化事实）。UI 不持有可被当作事实的状态。
8. **输入白名单**：所有来自 renderer 的 `profileId` 在参与 spawn/execFile 参数构造前必须通过白名单正则（`^p[0-9a-z]{8,20}$`，兼作目录穿越防护）；spawn/execFile 一律 argv 数组直传、禁用 shell 拼接；动态文件名一律"普通拼接 + resolve 路径围栏"（禁用模板字符串拼接进 join）。身份经 D6 通道传递时（argv `--omnicode-profile=<id>` + env 注入），profileId 必须先过该白名单——形态受控（生成器产物）、无敏感语义，故允许进命令行；bridge port/token 亦经白名单校验（正整数 / 32 位 hex）后才注入。

## 工作区共享（决策 D2：双向）

```
~/.omnicode/shared/workspaces.json    ← 全实例共享工作区注册表（Host 维护）
```

- **回流（实例 → 共享表）**：Host 项目库任何变更（`publishProjectChange` 漏斗）后，把本地项目根（与投影同源派生：`projects.filter(!deleted).flatMap(roots)`）幂等合并进共享表。
- **分发（共享表 → 实例）**：Host 装配时把共享表缺失项经 `projectService.saveProject` 写入本实例项目库——**必须走项目库**：`recentProjects` 是 SQLite 项目库的投影（上限 10 条），直接改 setting.json 会被投影重算覆盖。
- 并发：读-合并-临时文件-原子替换；写入前重读收窄丢失窗口，极端并发由下次变更收敛（最终一致）。

## 工作区互斥锁（决策 D1：灰显；D3：工作区级）

- **事故依据（2026-11-10 实测，外部修复方已验证机理）**：同一会话在两个实例同时打开干活。会话消息存于共享 SQLite（如 `~/.zcode/cli/db/db.sqlite`），`kept` 可见链只由"当前干活的实例"维护：实例 A 先开、持续写入；实例 B 后开，拿到的是打开那一刻的快照（kept=305），故 B 视图"聊天记录少了很多"；用户在 B 发消息，B 的 agent 正常写入，但两实例写入交错、kept 无人更新 → 异常固化。修复 = 备份后按时间序把 296 条新消息追加进 kept（305→601，零缺失零幻引），且修复后必须**关掉所有开着该会话的实例**再重开（否则内存旧 kept 会覆盖修复）。**结论：官方没有跨进程的会话写锁**（修复方原话），单写者假设被多实例打破；工作区目录内的 `sess_*.zcode-session` 与共享 DB 双层都是单写者资源。锁按工作区路径划分（D3）。M1 不提供"强制打开"逃生门（后果是数据损坏）；M2 提供"接管模式"（A 主动释放 → B 获取）。
- **锁文件**：`${sharedRoot}/workspace-locks/<hash>.json`（hash = 规范化+小写路径的 sha256 前 16 位，Windows 大小写不敏感）；内容 `{workspacePath, profileId, pid, acquiredAt, heartbeatAt}`。
- **获取**：fs `wx` 旗标（CREATE_NEW 原子语义），判负方读锁文件获得占用方信息。
- **心跳**：持有方每 10s 对集合内全部锁续期；**自愈**：心跳超 30s 或 pid 已死 → 无主锁，读取时懒清理，永不死锁。pid = Host 进程 pid（窗口关闭 → Host 退出 → 锁自愈）。心跳失败（锁文件丢失/被接管）转入竞争集合，下一拍重取；竞争集合（打开但被其他实例占用）也在心跳期重试，对方实例退出后自动接管。
- **呈现（D1）**：其他实例的工作区列表读到锁 → **变灰 + 提示"被实例X占用"**；同 profileId（含同实例多窗口）不互斥，保持官方单实例语义。
- **锁下沉（强制点）**：Host 侧 `projectService.saveProject(reuseExistingRoot)` 是全部目录打开入口（对话框 / 拖拽 / 项目根行 / 系统右键 / 快捷键）的原子必经点——renderer 各入口先经它登记项目、失败即整体中止，不会进入 `activateOrSetWorkspace`/`addTab`，拒绝发生在进入前、无半打开状态。在该点 `readWorkspaceLockOwner` 查锁：被**其他实例**（profileId 不同）占用 → 抛结构化错误（错误码 `omnicode.workspace-locked-by-other` + owner 信息，沿 RPC passthrough 到 renderer）；同 profileId 幂等放行。主实例（控制台）profileId 兜底 `"default"` 参与锁。Host 内部共享表分发合并调用走原始服务绕过该守卫（登记进项目库不是"打开工作区"）。UI 灰显降级为体验优化，强制力在 Host。
- **锁粒度集合化**：本实例**当前打开的全部本地工作区**都持锁，不再只跟 `lastActiveWorkspace` 单活动 tab 走（实例开 W1+W2 两 tab、切到 W2 时 W1 不再裸奔）。事实源 = AppSettings 新字段 `openLocalWorkspaces: string[]`（persisting 窗口的 `useTabPersistence` 在 tab 集合变化时全量重写，独立于活动 tab——活动 tab 为远程时仍持续维护）；Host 锁协调器按"新集合 vs 已持锁集合"对账 diff：新增获取、消失释放。获取判负不阻断（强制点兜底），该工作区在装饰链中 `ownedBySelf=false` 即灰显。`lastActiveWorkspace` 字段保留不动（官方语义）；旧 renderer 未写新字段时协调器退回单活动工作区行为（向后兼容）。**挂点**：`observableSettingService.onDidUpdate` 且 patch 含 `openLocalWorkspaces` → 集合对账；实例关闭/进程退出清理自己持有的全部锁。**初始锁保守**：装配时只取 `lastActiveWorkspace` 单活动工作区（与集合化之前一致），全集锁等待 persisting 窗口首次写回后对账补齐——避免 restoreSession=false 的窗口 Host（如更新状态窗）把上一生命周期残留快照整集合误锁。

## 并发与竞态（全部裁决权交给 OS 原子原语）

| 竞态 | 机制 |
|---|---|
| 两实例同时点开同一工作区 | 锁获取 = `wx`（CREATE_NEW），无"先读后写"间隙；判负方转灰显 |
| 同 Profile 双击"启动" | launch 单飞（per-profile in-flight Promise 去重）+ 全局启动串行链，屏障 = 上一实例**启动确认完成**（成功或失败都 settle 后才进下一次 doLaunch——2026-11-12 修订，原 handoff 消费屏障是毫秒级假串行，已随 D6 退役） |
| 退出登录 relaunch 与实例身份 | 实例 relaunch 显式传 `args: ["--omnicode-profile=<id>"]`（dev 态含 appPath，由 `buildOmnicodeInstanceRelaunchArgs()` 从 env 重建）；身份只经 argv/env 通道，无文件读删竞态 |
| 实例内双击工作区项 | renderer 激活态去重；同实例重复上锁幂等 |
| 两实例同时回写共享注册表 | 读-合并-原子替换 + 写入前重读，最终一致 |
| 占用者假死 >30s 后醒来重上锁 | 重上锁仍是原子创建：锁被接手则判负弹提示，宁可不打开也不双开 |

## 实时视窗（M2）

**v0（已落地）**：实例回连桥——127.0.0.1 WS + token 握手（port/token 经 spawn env 随身份一次性注入，2026-11-12 D6 修订），1.4fps `capturePage` 缩略图回传，设置页「多开实例」网格实时画面 + focus 放大（v0=真窗口聚焦）。命令通道 `sendOmnicodeInstanceCommand`（show/hide/focus/quit/subscribeThumbnails/unsubscribeThumbnails/restore）。

**v1 平铺编排（M2 v1，本节定稿）**：设置页一键把全部运行中实例窗口平铺到主屏网格，一键还原编排前位置。

- **编排范围（D5）**：仅实例窗口，控制台主窗口不动（控制台是管理入口，编排动作不应打乱用户当前视线）；v1 单主屏 `screen.getPrimaryDisplay().workArea`（自动排除任务栏），多屏编排 v2。
- **布局算法**：n 实例 → `cols = ceil(√n)`、`rows = ceil(n / cols)`，workArea 均分格子（格间 8px 间距），实例按启动时间升序排位（先启动在前）。
- **还原语义**：实例侧收到 `arrange` 时保存当前 bounds 为还原基线；`restoreBounds` 命令按基线 `setBounds`。连续两次编排后再还原 = 回到「最近一次编排前」位置（基线被第二次 arrange 覆盖——记录为 v1 已知语义）。
- **状态处理**：arrange 时实例先 `restore`（最小化）/`unmaximize`（最大化）再 `setBounds`，规避 Windows 最大化态下 setBounds 行为异常。
- **投递语义**：未连接实例不投递（与 focus 同形），返回实际投递数量；fire-and-forget 不等实例确认，结果以缩略图网格实时画面为准。
- **安全边界**：arrange 目标矩形由父进程计算（来源仅 workArea），实例侧校验 x/y/width/height 为有限非负整数且 width≥200 / height≥150，拒绝畸形矩形。

验收：3 实例运行 → 平铺 → 三窗口均分主屏网格且不遮控制台 → 还原 → 回到编排前位置；最小化实例参与编排后被唤起并归位。

## 决策记录（2026-11-10，用户已确认）

- **D1** 锁呈现 = 灰显 + 占用提示（否决隐藏：避免"项目去哪了"困惑）。
- **D2** 共享方向 = 双向（实例新增自动回流共享池）。
- **D3** 锁粒度 = 工作区级（事故验证）。
- **D4** 延后 M1.5：`zcode://` 按实例路由、OAuth 刷新链路、per-profile 加密密钥、远程工作区锁。
- **D5**（M2 v1）平铺编排范围 = 仅实例窗口（控制台不动）；v1 单主屏，多屏 v2。
- **D6**（2026-11-12，用户批准）：废除一次性 handoff 文件，实例身份改 **argv `--omnicode-profile=<id>` + spawn env 一次性同步注入**。理由：①handoff 读取即删后，退出登录触发 `app.relaunch()` 原样重放 `--omnicode-handoff`，文件已删 → 实例身份丢失变裸进程（与主实例同 userData → 抢单实例锁聚焦主实例窗口 + 数据根回落 + 登录走系统浏览器）；②launchChain 串行是假的（只串到 spawn 返回毫秒级）且 handoff 非原子写/读后删非原子 → 实例身份可互换；③身份失败静默裸奔（stdio:"ignore" 吞日志）。修复配套：启动确认（~750ms 稳定窗口 + exit 事件快速失败）、stdio 落盘 `<profileDir>/logs/instance-boot.log`、串行链屏障改为"启动确认完成"、launch 改"启动=重启"、停止改 pid 驱动三段式优雅停（不依赖 child 句柄）、带身份旗标但身份非法的实例进程 `process.exit(1)` 快速失败、relaunch 经 `buildOmnicodeInstanceRelaunchArgs()` 显式续接身份。安全性论证：profileId 过白名单正则（生成器形态、无敏感语义、目录穿越防护），spawn 参数面原子注入无文件读写窗口，攻击面小于文件握手；env 补入 `ZCODE_DESKTOP_HOME_DIR` 使 setting.json 按实例隔离（Cockpit env 清单对齐）。

## 接口

### IPC（channel 前缀 `omnicode:profile:`）

| 方法 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `list` | – | `ProfileSummary[]`（id/name/createdAt/运行状态/pid） | 列表 |
| `create` | `{name, notes?}` | `ProfileSummary` | 建 Profile + 生成 secret |
| `remove` | `{id}` | `{ok}` | 运行中拒绝（错误码 `PROFILE_RUNNING`） |
| `clone` | `{id, name}` | `ProfileSummary` | 目录级非覆盖复制（运行中拒绝）；不复制 electron-userdata（Chromium 存储不可复制语义，新实例重新登录） |
| `launch` | `{id}` | `{pid}` | **启动=重启**（2026-11-12 D6）：spawn 后带 ~750ms 启动确认，已运行实例先三段式优雅停再启动；确认失败/秒退以 reject 透出（UI toast） |
| `stop` | `{id}` | `{ok}` | 三段式优雅停（见规则 4）：优雅（WM_CLOSE/SIGTERM，~2s）→ 强杀 → 复查，残留抛错带 pid |

### argv

- `--omnicode-profile=<profileId>`：实例身份注入（见规则 1；控制台 spawn 与 relaunch 均显式携带）。
- `--omnicode-console`：控制台身份（M2 起承载视窗网格；M1 仅设置应用身份）。
- 二者互斥，同时出现以 profile 为准并在日志告警。
- ~~`--omnicode-handoff`~~：**已退役**（2026-11-12 D6）。新实例 bootstrap 检测到该旗标且无合法 profileId 时 `process.exit(1)` 快速失败（拦截旧版控制台与新版实例混部场景）。

## 验收场景

1. 控制台 create「工作A」→ launch → 出现独立窗口；再 create「工作B」→ launch → **两实例并存**，各锁互不冲突。
2. 实例 A 登录账号甲 → 停止 → 重启 → **仍登录**（凭据解密成功、业务 token 未过期场景下不掉线）。
3. 实例 A 与实例 B 各自 `~/.omnicode/profiles/<id>/.zcode/v2/credentials.json` 内容不同；一方登出不影响另一方。
4. clone A→C：C 首启为全新登录态（无 userata 拷贝）；C 与 A 同时运行无冲突。
5. 运行中 remove A → 报 `PROFILE_RUNNING`；stop 后 remove 成功且目录移入回收站语义（Windows 直接 rm 前二次确认在 UI 层）。
6. 控制台自身与官方安装版 ZCode 同屏运行，互不触发对方单实例锁。
7. `pnpm typecheck` / `pnpm lint` 通过；`pnpm architecture:check --changed` 0 新增违规。

## 已知延后与风险

- per-profile 凭据密钥（纵深防御）：见产品规则 1 附注。
- `zcode://` OS 注册仍是全局单点：M1 期间实例内 OAuth 登录建议使用控制台所在实例或延至 M1.5 路由方案。（记录于 M1.5 todo）
- dev 态实例 = `node_modules/electron/dist/electron.exe` 拉起，窗口标题与正式版无差异，靠 `OmniCode-<profileId>` 应用名与日志 pid 区分。
- （2026-11-12 已由三段式优雅停收口，原"直接 /T /F"建议废止）`closeToTrayOnWindows=true` 的实例在第一段 WM_CLOSE 会转为隐藏而非退出 → 第二段超时后自动 `/T /F` 强杀，停机语义闭环。

## 批次2：进程模式与身份（D7，2026-11-12 B2-1）

同一可执行体的互斥双模式（判据唯一化，纯函数见 `packages/shared/src/omnicodeAuth.ts`）：

- **管理器模式** = `ZCODE_PRODUCT_FLAVOR === "omnicode" ∧ env 无 OMNICODE_PROFILE_ID`（`isOmnicodeManagerProcess`）。渲染 ConsoleHome（唯一屏）；不恢复会话、不预热 agent、不跑 cron 调度器、不装工作区锁协调器（host 侧按 `OMNICODE_CONSOLE_MODE=1` 跳过，env 经 buildHostProcessEnv 继承）、退出确认换为"有 N 个实例正在运行…实例将独立存活"的原生框。**保留每窗 local Host 进程**——renderer 的 DatabaseStartupAdmission（main.tsx）以 host 的 ServicePort+startup state 为挂载前置，完全跳过会让管理器卡在启动 loading（设计 §2.2"不起 host"在 renderer 启动契约下的落地修正，见 B2-1-NOTES 决策记录）。
- **实例模式** = argv `--omnicode-profile=<id>`（仅管理器可 spawn）。完整 ZCode 会话栈，永不渲染 ConsoleHome；启动时自带数据根的凭据备份调度（`startOmnicodeInstanceSelfCredentialBackupScheduler`，管理器关闭后独立存活的兜底）。
- 官方 flavor（production/preview）恒不落入两种模式——本批全部改动以 flavor 判据为前置，官方行为零影响。

**renderer 身份通道**：preload 暴露 `omnicodeInstanceId: string | null`（env 快照，非 IPC）与 `omnicodeInstanceTitle`（"ZCode [实例名]"，profileBootstrap 注入 env，renderer 入口据此设 document.title）。Root.tsx 早返回条件收紧为 `flavor==="omnicode" && omnicodeInstanceId==null`——实例窗口恢复官方渲染路径（工作台/欢迎登录屏），这是"点击启动实例打开了另一个管理器"根因（批次2a 只判编译期 flavor）的修复。

**嵌套管理器封死（三层）**：① `registerDesktopOmnicodeProfileIpcHandlers` 在 omnicode 实例进程整体跳过（桥 server、reconcile、Profile IPC、全量凭据备份调度都不装配；官方 flavor 保持装配不变）；② 实例 preload 按 identity 裁剪 contextBridge 面（profile 管理 API 不暴露，`submitOmnicodeCallback` 保留——实例自身的 OAuth 恢复通道）；③ 实例 renderer 的设置页 Profile 分区不渲染（`ProfileMultiInstanceSection` early-return）。

**控制台工作区路由（缺陷6 收口）**：桥协议新增 `openWorkspace {path}` 命令（管理器 → 实例；实例侧经官方 `OpenWorkspacePath` 通道走自身打开流程，过 saveProject 锁守卫=尊重工作区锁）。管理器收到"打开工作区"（second-instance 参数 / zcode:// 深链 / 冷启动 argv，统一入口 `openOmnicodeManagerWorkspace`：网络路径早拒 + 目录校验 + 外部来源确认与官方同规）：恰一实例直转；多实例原生选择框（按钮列实例名）；零实例原生引导"新建并打开"——新建 profile 后以 `--omnicode-open-workspace=<path>` argv 启动，实例 bootstrap 搬运到 `OMNICODE_OPEN_WORKSPACE` env，whenReady 后经官方 handleOpenWorkspacePath 队列投递。OAuth 回调维持既有投递文件中继，不动。

**旧控制台数据收养（保登录态）**：profile 记录新增可选 `dataBaseDirOverride`——`.zcode` 数据根（凭据/会话库/setting.json/credential-secret）指向旧 `~/.omnicode/console` 目录，**零拷贝**；electron-userdata/session 仍用 profile 自身目录（auth 分区重建即可）。双端同源：instanceManager.doLaunch 的 spawn env 与 profileBootstrap 的自派生 env 都读同一 profile.json。收养入口：ConsoleHome 列表区一行「将原主实例收养为实例（保留登录与历史）」，仅当旧根存在 credentials.json 且无 profile 已指向（重复收养=两实例写同一会话库，拒绝）；名称自增避让（`实例-收养`/`实例-收养 2`…）。UI 状态与处理函数为可复用导出（`useOmnicodeConsoleAdoption`，B2-3 重做控制台时直接复用）。克隆不携带 override（克隆体已有自身 .zcode 拷贝，共享 override 会复刻串流事故）。

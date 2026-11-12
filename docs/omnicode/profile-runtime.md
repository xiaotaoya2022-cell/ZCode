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

## 批次2 B2-2：工作区锁全入口强制 + 只读观察者模式（D8，2026-11-12）

### 锁强制语义（全入口）

- **守卫门控**：saveProject 打开锁守卫与 `attachWorkspaceLockCoordinator` 仅在 **omnicode flavor ∧ 非管理器模式** 生效（`ZCODE_PRODUCT_FLAVOR === "omnicode" && OMNICODE_CONSOLE_MODE !== "1"`，node.ts）。官方 flavor（production/preview）本批起**不再查锁**——批次1 官方侧随环境共享锁目录的查锁行为收窄为 omnicode 专属（官方构建零影响铁律）；管理器不打开工作区（B2-1 D7 语义保持，双保险）。
- **saveProject 全形态**：守卫从 `reuseExistingRoot ∧ 单根` 扩展为**全部带本地 roots 的形态**（本地 = 无 hostId 或 hostId==="local"；多根/项目编辑器新建/加根均覆盖）——roots 任一目录被他实例持有即整体抛 `omnicode.workspace-locked-by-other`（进入前拒绝、无半打开）。无 roots 的元数据更新（置顶/改名）不拦；远程 hostId 不锁（M1 范围）。
- **入口核对表**（全部收敛到 saveProject 守卫或 restore 预检）：
  - 目录对话框 / Ctrl+O / 拖拽 / 项目根行 / 系统右键 / recent → renderer `handleSelectProject` → `saveProject(reuseExistingRoot)` → 守卫；
  - 项目编辑器（新建项目/加根，多根形态）→ `saveProject(roots)` → 守卫（本批新增覆盖）；
  - deep-link / second-instance `OpenWorkspacePath` → `handleSelectProject` → 守卫；
  - B2-1 桥 `openWorkspace` 命令 → 实例侧官方 `OpenWorkspacePath` 通道 → `handleSelectProject` → 守卫；
  - 管理器路由的 `--omnicode-open-workspace` 冷启动 → 官方 handleOpenWorkspacePath 队列 → 同上；
  - **restoreSession（本批补齐的缺口）**：恢复不经 saveProject——Root 的 `restorePersistedSession` 包装层先查锁（数据源 = 既有 `readTree` 的 `omnicodeWorkspaceLocks` 装饰，`ownedBySelf` 以 Host env 身份判定），被他实例持有的本地工作区从恢复集合剔除（lastActiveWorkspace 置 null / lastWorkspaceSession 过滤）+ Toast 拒绝；预检失败 **fail-open**（退回旧"恢复+灰显"软语义，不能因预检故障导致全部工作区打不开）。不新增 RPC 方法（IProjectService 已满 12 方法上限，架构门禁）。
- **协调器语义不变**：锁获取仍由 `openLocalWorkspaces` 集合对账驱动（新增获取/消失释放/10s 心跳/pid 自愈）；获取判负仍转竞争集合重试（不阻断打开流程本身——阻断在 saveProject 守卫完成），关 tab/切会话锁随集合释放。

### 只读观察者模式（用户拍板"子代理式观察者"）

- **入口**：锁冲突对话框（`handleSelectProject` 捕获结构化错误后，omnicode 实例内弹确认框）提供「只读打开」；官方 flavor / 管理器保持纯 toast 拒绝。
- **观察者 → 可写升级（B2 评审修复 P1-1）**：锁释放后同一工作区再走正常打开（saveProject 守卫放行）时，`handleSelectProject` 成功分支先调 `tabStore.clearOmnicodeObserver(path)` 清除观察者标记再 addTab——否则 merge 语义（`options?.omnicodeObserver ?? tab.omnicodeObserver`）会让 tab 永远保持只读，且该工作区因观察者标记不进 `openLocalWorkspaces` 锁集合（第三实例可再打开 = 双开）。清除后锁集合采集（useTabPersistence 300ms debounce 写回）恢复包含该工作区。
- **标记传递链路**：`tabStore` 工作区 tab 记录字段 `omnicodeObserver?: { holderProfileId: string; holderDisplayName?: string }`（addTab options 注入；**不持久化**——`buildPersistedWorkspaceSessionEntries` / `buildRemoteWorkspacePersistPatch`（lastActiveWorkspace）/ `collectOpenLocalWorkspacePaths`（锁集合事实源）三处均排除观察者 tab，重启后由 restore 预检重新裁决）。观察者打开不调 saveProject（被占用工作区必然已在共享注册表/本实例项目库中）、不走 `activateOrSetWorkspace`（纯查看，留在当前窗口）。
- **受限面（诚实清单）**：观察者 tab 经 `isWorkspaceReadOnly` 进入官方 readOnly 链路（`workspaceReadOnlyReason` → SessionPane `readOnly`），由此获得：①会话输入禁用（composer 不渲染，原输入区显示观察者原因）②agent 命令 / 重试 / 编辑 / 副屏会话 / 文件拖入会话全部禁用 ③新建任务、Git 面板、终端等入口按官方 readOnly IfWritable 拦截 ④文件树本身为只读导航树（open/reveal/copy/另存副本导出，**无新建/重命名/删除/上传操作可禁**——官方桌面 UI 不存在这些操作，如实记录而非虚构禁用面）。
- **退出语义**：关闭观察者 tab = 纯查看退出，不触碰任何锁（观察者从未持锁、不在锁集合）。
- **持有者展示实例名（B2 评审修复，兑现 C5）**：锁文件携带 `displayName`（实例名）——profileBootstrap 注入 `OMNICODE_PROFILE_NAME` env（与 `OMNICODE_INSTANCE_TITLE` 同源于 profile.json；spawn env 双保险），锁协调器获取锁时写入锁文件；锁查询返回的 owner / readTree 装饰 / `workspace-locked-by-other` 结构化错误 data 均携带。横幅 / 锁冲突对话框 / toast / task-row 灰显 / restore 拒绝全部插值实例名（displayName 优先），老锁文件无该字段回退 profileId（兼容）。
- **横幅**：SessionPane 顶部常驻琥珀色横幅「观察者模式（只读）— 该工作区正被 <实例名> 使用」（i18n en/zh，`omnicode.observer.*`）。
- **官方 flavor 混部告知层（B2 评审修复 P1-4）**：官方 ZCode 不查锁不拦截（官方零影响铁律），但打开工作区成功后以 readTree 的 `omnicodeWorkspaceLocks` 装饰做一次**只读查询**——若该工作区正被 OmniCode 实例持有则 Toast 告知并发写入风险（查询失败静默；纯官方环境无共享锁目录，天然零打扰）。边界：告知不改任何官方行为，锁的强制语义仍只在 omnicode 实例内成立。

### 已知缺口（如实记录，不虚报全只读）

1. ~~**持有者展示为 profileId**~~（B2 评审修复已兑现 C5）：锁文件现携带 displayName（实例名），横幅/对话框/toast/task-row 灰显均展示实例名；老锁文件（无 displayName）回退 profileId。ConsoleHome 锁卡片显示实例名归 B2-3。
2. **观察者的会话列表/任务行仍可点击查看**（读路径）；官方 readOnly 只封写路径——查看是观察者模式的目的，非缺口；但 task-row 的"addToChat"（文件加入会话草稿）在 composer 隐藏后属死按钮，未单独禁用（本地草稿写，不触碰工作区 FS）。
3. **外部编辑器写**：文件树"用编辑器打开/系统文件管理器"在外部进程写工作区文件——应用内锁无法约束外部进程（与批次1 相同边界）。
4. **restore 预检路径归一**：Host 锁条目存 resolve 后路径，renderer 以大小写不敏感+去尾分隔符宽松归一比对；跨盘符大小写差异漏筛时退化为旧"恢复+灰显"软语义（fail-open，不产生双开硬拒绝缺口——灰显 tab 本身不可进入）。
5. **persistSession 窗口期（批次1 已知，保持）**：恢复完成到 renderer 首次写回 `openLocalWorkspaces` 之间，协调器只持 lastActiveWorkspace 单活动锁；全集锁待首次写回补齐（单测锁定该现状语义）。
6. **task-row 灰显项不提供观察者入口**（点击保持拒绝+提示）；观察者入口只在打开流（对话框/拖拽/recent/deep-link/桥）的锁冲突对话框。

## 批次2 B2-3：控制台网格 + 内嵌/桌面双模式 + 预览升级（D9，2026-11-13）

上位设计：BATCH2-DESIGN.md §4。本节是内嵌语义、生命周期红线与状态落盘的行为事实源。

### 内嵌模式语义（owned-window）

- **机制**：运行实例窗口经 Win32 `SetWindowLongPtr(GWL_HWNDPARENT, consoleHwnd)` 成为管理器窗口的 owned window（自动置顶于管理器、随管理器最小化/恢复）+ `skipTaskbar(true)` + 冻结 resizable/最低尺寸（内嵌下限 160×96，低于 arrange 的 200×150——格子由网格 minmax 与真实宽高比决定，21:9 卡片画面区高度会低于 150px）。
- **owned 登记以 PowerShell 成功为准（B2 评审修复 P1-3）**：`ownInstances` 登记移到 `runSetWindowOwner` 成功之后（返回布尔）；失败不登记 ownedProfileIds（下轮 own/dispatch 自动重试）并给该实例补发 `releaseEmbed`（实例可能已进入内嵌约束，补发保持桌面态+任务栏可见，窗口不"失踪"于网格）。候选过滤/登记决策为纯函数（`resolveOmnicodeOwnCandidates` / `resolveOmnicodeOwnedRegistrationOutcome`）。
- **模式切换串行化（B2 评审修复 P2-6）**：切换请求经队列串行执行（并发双击时各自以最新 embedMode 重判，最终收敛到最后一次用户意图）；切换过渡期（`switchingMode`，解除 owned 的 await 窗口）dispatchEmbedLayout/ownInstances 入口短路——尾随节流 timer 不再以 embedded 态重下发布局/重登记 owned。
- **内嵌卡片比例冻结（B2 评审修复 P2-7）**：内嵌模式下卡片画面区 aspect 冻结为进入内嵌后首帧比例——帧尺寸→卡片高→embedLayout 矩形→实例窗口尺寸→下一帧尺寸是闭环，动态比例会微抖；桌面模式恢复动态（真窗口不贴卡片，无环）。
- **桥连接唯一性（B2 评审修复 P2-10）**：一个 profileId 同时只允许一条连接（后连踢前连）；被顶替的旧连接 close 不触发 disconnected 通知（只有当前登记连接的 close 才代表实例真正断开），避免假断开清掉内嵌/订阅簿记。
- **owned 设置/解除 = 一次性 PowerShell**（`-NoProfile -NonInteractive -Command`，argv 数组直传、禁 shell 拼接）：Add-Type P/Invoke `SetWindowLongPtr`；全部 HWND 经 `^0x[0-9a-f]{1,16}$` 白名单后才可进字面量（`[Convert]::ToInt64('<hex>',16)`）。不长驻任何脚本进程；单次批处理硬超时 5s，失败仅告警（重复设置幂等无害）。
- **HWND 获取**：实例桥新增 `hello` 消息（实例侧 1s 轮询主窗口 `getNativeWindowHandle`，变化即上报；管理器兜底命令 `requestWindowHandle` 强制重报）。
- **布局跟随**：renderer 上报卡片画面区矩形（**窗口客户区 CSS 像素** + 视口尺寸，rAF+~60ms 节流；管理器窗口 move/resize 再兜一层同规格节流）→ main 经 `contentBounds/viewport` 比例换算屏幕 DIP（对任意 zoomFactor 成立，换算收口在 main）→ 桥命令 `embedLayout {rects[]}`（全量矩形广播，实例按自身 profileId 滤出并独立校验——最低规格内联在 `embedLayoutMath`，双端共用纯函数）。卡片顶条约 28-32px 留给管理器自绘控制钮（实例窗口贴画面区，不含顶条）。
- **视口外内嵌实例临时隐藏**（owned 窗口无裁剪，悬在管理器外会遮挡桌面）：布局里消失 → `hide`；回到布局 → `embedLayout` 自带 show。
- **解除**：`releaseEmbed` 桥命令（恢复 resizable/桌面最低尺寸/skipTaskbar(false) + 回内嵌前基线 bounds）+ PowerShell `GWLP=[IntPtr]::Zero`。切桌面模式、arrange 编排前均先解除（内嵌态不参与平铺——「平铺到屏幕」为桌面模式专属，内嵌下禁用置灰）。
- **放大语义**：双击卡片 = 该实例独占网格区（其余卡片不渲染），embedLayout 跟随新矩形；ESC/返回钮 = 回网格。非内嵌态的放大 = 桌面模式点击卡片聚焦真窗口（桥 `focus`）。

### 生命周期红线（退出屏障）

Win32 owned window 随 owner 销毁——管理器窗口直接销毁会**连带杀死内嵌实例**。因此：

- 管理器 `prepareAppQuit` 屏障内 `await releaseOmnicodeEmbedForQuit()`：先于窗口销毁解除全部 owned（PowerShell 批处理 + releaseEmbed），幂等、总预算 4s，超时放行退出。
- 切桌面模式同样先解除（`applyOmnicodeConsoleModeChange`）。
- **管理器崩溃/被强杀无法收尾 → 内嵌实例被连坐销毁**，记录为已知限制（无 GUI 环境未做运行时实测）。
- 实例侧正常 stop（三段式优雅停）不受内嵌态影响：实例进程退出即窗口销毁，管理器收到桥 disconnected 清簿记。

### 预览管线升级（{w,h} 帧协议 + 视口订阅）

- 桥 `thumbnail` 帧可选附 `width/height`（实例侧 capturePage 同刻 `getContentSize`，DIP）——卡片按真实宽高比 letterbox（修"显示不完整"）；缺省回退默认比例（旧实例兼容）。
- **订阅状态化**：管理器侧期望订阅 = `previewEnabled ∧ 卡片在视口内`（renderer IntersectionObserver 上报可见集合；`resolveOmnicodePreviewSubscriptions` 纯函数决策 + 与桥实际态 diff 后增减 `subscribeThumbnails/unsubscribeThumbnails`）。总开关关闭 = 全部退订，卡片停留最后一帧灰暗化 + 角标（不再是"连上即订阅"的粗放行为）。
- **连接/断开即时对账（B2 评审修复 P1-2 兑现）**：`notifyOmnicodeInstanceConnected/Disconnected` 路径末尾 `reconcilePreviewSubscriptions()`——连接不再隐含订阅；v0"连上即订阅"收窄为**官方 flavor 专属**（`shouldAutoSubscribeThumbnailsOnConnect`：官方进程无订阅编排且实际无实例回连，零影响保持），omnicode 管理器完全按 总开关∧可见 对账（预览关时实例连接不产生订阅，且会补发退订纠正 v0 残余状态）。
- **卡片帧清理（B2 评审修复 P2-8）**：实例断开（disconnected 事件）即清该实例最后一帧——已停止实例卡片显示停止占位（▶启动），不残留旧帧伪装"还有画面"；profiles 列表刷新时兜底清全部非 running 实例的帧。
- 实例侧最小化/隐藏跳帧策略保持（隐藏窗口停留最后一帧）。

### console-ui.json 状态落盘

- 管理器数据根 `console-ui.json`（原子写 + 损坏回退默认 `{mode:"embedded", previewEnabled:true}`；**不写** `.zcode/v2/setting.json`——收养后该树归实例，管理器只写自己的管理数据）。字段 patch 合并为纯函数（未知/非法字段丢弃，落盘值永远收敛合法形态）。
- mode 为全局开关（切换对全部运行实例即时生效：进内嵌 = owned 全部已连接实例并等待布局；进桌面 = 先解除全部）。预览总开关同为持久化状态。

### 内嵌/桌面双模式语义（UI 呈现）

- **内嵌**：卡片画面区 = 真窗口贴合区（不可见缩略图被真窗口覆盖；顶条控制钮管理实例）；点击画面区即交互真窗口。
- **桌面**：实例窗口独立在桌面（有任务栏）；卡片显示实时缩略图 + 高斯模糊遮罩（`backdrop-filter: blur` + `pointer-events:none`）+「桌面模式·点击聚焦真窗口」提示；点击卡片 = 桥 `focus`。
- 模式切换 IPC 返回后的 UI 状态即时生效；持久化保证重启回到上次模式。

### 已知限制（如实记录）

1. 内嵌 owned 关系仅 Windows（非 win32 平台 owned 设置 no-op，内嵌模式退化为"窗口不跟随"——本产品当前仅 win 发版）。
2. 管理器崩溃未解除 owned → 内嵌实例连坐销毁（上述红线只覆盖正常退出路径）。
3. 多显示器/高 DPI 缩放差异下的换算精度依赖 `contentBounds/viewport` 比例假设（单显示器 100%/200% 缩放推演正确；未做全 DPI 矩阵实测）。
4. 内嵌实例的 alt-tab/任务栏入口消失（skipTaskbar），只能经管理器卡片管理——切桌面模式或停止实例恢复。

### B2 评审修复补充记录（P2 杂项与决策）

1. **视口换算分母（P2-9 勘误）**：embed 上报的视口分母必须是**整窗 CSS 视口**（`window.innerWidth/innerHeight`）——main 侧 scale = getContentBounds(DIP)/viewport(CSS px) = zoomFactor，卡片 rect（getBoundingClientRect）与 innerWidth 同处窗口视口坐标系。评审建议的"网格容器 clientWidth 作分母"不成立：容器不含工具行/边距，比例会被放大导致实例窗口整体错位；容器自身滚动条不影响全局比例（分母与内容位置无关）。已在 ConsoleInstanceGrid 代码注释记录该结论。
2. **底栏内存合计（P2-11②，兑现设计 §4.1）**：数据源 = Profile 列表 IPC 聚合的 `memoryMB`（Windows 单次 tasklist CSV 全量进程表筛 pid，千分位/单位剥离后 KB→MB；非 Windows/查询失败缺省）。任一运行实例内存不可得时底栏不显示合计（不编造部分和）。
3. **收养兜底名语言无关（P2-11①）**：main 侧无 i18n 机制，畸形入参兜底名改为 `instance-adopted`（正常路径 renderer 始终传本地化名称 `console.adoptionDefaultName`）。
4. **主窗口重建重挂（P2-11③）**：主窗口存在销毁重建路径（renderer 崩溃自愈 discard→重建 / macOS activate 重建），`createWindowInstance` 内每次创建后重挂 `setOmnicodeEmbedManagerWindow`（原先仅 app-ready 挂一次，重建后内嵌跟随失效）。
5. **帧比例冻结的边界**：冻结发生在"进入内嵌后收到首帧"——该帧通常是 embedLayout 生效前的桌面基线比例，作为反馈环的稳定起点；实例窗口真实比例与冻结值差异由 letterbox 兜住（object-contain 不裁切）。

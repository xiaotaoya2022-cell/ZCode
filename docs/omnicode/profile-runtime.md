# OmniCode Profile Runtime（原生多开与实例隔离）

> 状态：2026-11-10 M1 实现依据 ｜ 上位设计：《ZCode 原生魔改版架构与实现方案报告》§2（OmniCode 仓 docs/）
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
      .zcode/v2/…                  ← 该实例全部业务数据（凭据/会话/sqlite/logs）
      electron-userdata/           ← Chromium userData
      electron-session/            ← Chromium sessionData
```

- `profileId`：`p` + 时间戳+随机后缀（ASCII、目录名安全、不可变）。`displayName` 用户可改。
- `profile.json` 字段：`{ id, name, createdAt, notes? }`
- 环境变量 `OMNICODE_PROFILE_ROOT` 可覆盖 profiles 根目录（开发/测试用）。

## 产品规则

1. **身份注入四件套**（实例启动时由控制台写入一次性 handoff 文件，实例自身在**最早导入点**消费：argv `--omnicode-profile=<profileId>` 供手动/外部启动；控制台拉起的实例带 `--omnicode-handoff` 字面量旗标、从 `<profileRoot>/.handoff/current.json` 读取 profileId（读取即删），并自行重建同一组 env。profileId 不进命令行参数、不进长期 env。两条路径产出必须一致）：
   - `ZCODE_DESKTOP_APPLICATION_NAME=OmniCode-<profileId>`（决定单实例锁归属与托盘/任务栏身份）
   - `ZCODE_DESKTOP_USER_DATA_DIR=<profileDir>/electron-userdata`
   - `ZCODE_DESKTOP_SESSION_DATA_DIR=<profileDir>/electron-session`
   - `ZCODE_DATA_BASE_DIR=<profileDir>`（凭据/会话/sqlite 全部落 profile 内）
   - （不注入 `ZCODE_CREDENTIAL_SECRET`：数据目录隔离已保证凭据隔离与持久——官方 fallback 密钥派生绑定 `homedir:username`，多开不触碰 homedir 即天然稳定；per-profile 密钥需打通 host env 继承链，收益为纵深防御，延后至 M1.5 评估）
2. **禁止注入** `HOME`/`USERPROFILE`（会改变官方 fallback 凭据密钥派生 → 掉线根因，见上位报告 §2.2）。
3. **实例与控制台互不抢锁**：实例 userData 各自独立；控制台以 `--omnicode-console` 启动时将应用身份设为 `OmniCode Console`（与官方安装版、Profile 实例三者 userData 互斥）。开发态沿用 `ZCode Dev`。
4. **生命周期**：启动 = `child_process.spawn` argv 数组直传（profileId 不进命令行，走 `OMNICODE_PROFILE_ID` env；packaged 用 `process.execPath`，开发态 electron.exe + appPath）。停止（M1）= `child.kill()` 硬停；优雅停机（WM_CLOSE→appShutdownPolicy）随 M2 实例控制通道落地。
5. **删除保护**：实例运行中禁止删除/克隆该 Profile；先停止。
6. **凭据自愈边界**：实例读取凭据解密失败时，先尝试「当前密钥重加密」不成立则**备份后保留现场并提示重新登录**，禁止静默清空（官方 `clearCorruptOAuthSession` 行为的收口，实现于 M1-5）。
7. 状态唯一所有者：**运行状态**归控制台主进程 `InstanceRegistry`（内存态，进程重启即重建，不持久化"运行中"）；**Profile 定义**归 `profile.json` 文件（唯一持久化事实）。UI 不持有可被当作事实的状态。
8. **输入白名单**：所有来自 renderer 的 `profileId` 在参与 spawn/execFile 参数构造前必须通过白名单正则（`^p[0-9a-z]{8,20}$`，兼作目录穿越防护）；spawn/execFile 一律 argv 数组直传、禁用 shell 拼接；动态文件名一律"普通拼接 + resolve 路径围栏"（禁用模板字符串拼接进 join）。

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
- **心跳**：持有方每 10s 续期；**自愈**：心跳超 30s 或 pid 已死 → 无主锁，读取时懒清理，永不死锁。pid = Host 进程 pid（窗口关闭 → Host 退出 → 锁自愈）。
- **呈现（D1）**：其他实例的工作区列表读到锁 → **变灰 + 提示"被实例X占用"**；同 profileId（含同实例多窗口）不互斥，保持官方单实例语义。
- **挂点**：Host 的 `observableSettingService.onDidUpdate`，patch 含 `lastActiveWorkspace` 即切换（换锁=释放旧+获取新）；初始锁取装配时的 `lastActiveWorkspace`（仅 `kind === "local"`，远程工作区 M1 不锁）。

## 并发与竞态（全部裁决权交给 OS 原子原语）

| 竞态 | 机制 |
|---|---|
| 两实例同时点开同一工作区 | 锁获取 = `wx`（CREATE_NEW），无"先读后写"间隙；判负方转灰显 |
| 同 Profile 双击"启动" | launch 单飞（per-profile in-flight Promise 去重）+ 全局启动串行链（上一 handoff 被消费后下一次才写） |
| 实例内双击工作区项 | renderer 激活态去重；同实例重复上锁幂等 |
| 两实例同时回写共享注册表 | 读-合并-原子替换 + 写入前重读，最终一致 |
| 占用者假死 >30s 后醒来重上锁 | 重上锁仍是原子创建：锁被接手则判负弹提示，宁可不打开也不双开 |

## 实时视窗（M2）

**v0（已落地）**：实例回连桥——127.0.0.1 WS + token 握手（token 经 handoff 传递，不进命令行/长期 env），1.4fps `capturePage` 缩略图回传，设置页「多开实例」网格实时画面 + focus 放大（v0=真窗口聚焦）。命令通道 `sendOmnicodeInstanceCommand`（show/hide/focus/quit/subscribeThumbnails/unsubscribeThumbnails/restore）。

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

## 接口

### IPC（channel 前缀 `omnicode:profile:`）

| 方法 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `list` | – | `ProfileSummary[]`（id/name/createdAt/运行状态/pid） | 列表 |
| `create` | `{name, notes?}` | `ProfileSummary` | 建 Profile + 生成 secret |
| `remove` | `{id}` | `{ok}` | 运行中拒绝（错误码 `PROFILE_RUNNING`） |
| `clone` | `{id, name}` | `ProfileSummary` | 目录级非覆盖复制（运行中拒绝）；不复制 electron-userdata（Chromium 存储不可复制语义，新实例重新登录） |
| `launch` | `{id}` | `{pid}` | 已运行返回现有 pid（幂等） |
| `stop` | `{id}` | `{ok}` | 见规则 4 |

### argv

- `--omnicode-profile=<profileId>`：实例身份注入（见规则 1）。
- `--omnicode-console`：控制台身份（M2 起承载视窗网格；M1 仅设置应用身份）。
- 二者互斥，同时出现以 profile 为准并在日志告警。

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
- `taskkill` 优雅退出依赖窗口存在；`closeToTrayOnWindows=true` 的实例 stop 会转为隐藏而非退出 → 对这类实例直接 `/T /F`（记录：tray 常驻实例的优雅停机走 M2 的 IPC 通道）。

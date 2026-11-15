# 全局偏好层（批次 4，G1）

> spec-first 事实源：本文件定义跨实例共享的全局偏好（语言/外观主题/快捷键）的存储分层、
> 同步白名单、上行/下行语义、spawn 注入方案与已知限制。
> 设计准则（README slogan）：**帮助不随实例数放大的能力就该被共享**——语言/外观/快捷键
> 这类偏好，五个账号没必要五种设置。
> 红线：官方 flavor 零改动（同步逻辑全在 omnicode 分支/桥命令/BroadcastHub [OmniCode]
> 观察点内）；白名单外键零触碰（模型/凭据/工作区/会话键是 per-instance 红线）；实例崩溃
> /断连时同步失败不阻塞管理器（fire-and-forget + 日志，无重试风暴）。

## G1.1 是什么 / 为什么

多实例产品里，界面语言、外观主题、快捷键这三类偏好在语义上是「人」的偏好而不是「实例」的
偏好：同一台机器上的五个实例各存一份、各配一次，既重复又不一致。全局偏好层把这些键收敛为
**管理器单源**：改一处 = 所有实例（含未运行的下次启动）生效；实例内改了也会回流管理器并
广播给其余实例。模型、凭据、工作区、会话等键永不进入该机制。

## G1.2 存储分层（含一次实测修正）

设计时假设「管理器设置页 general/appearance/shortcuts 分区本来就写 setting.json」。
实现前实测结论（决定分层形态）：

| 偏好 | 官方存储 | 分层裁定 |
| --- | --- | --- |
| `locale` / `localePreference` | setting.json（general 分区；落盘时 settingService 另写 `uiLocale`/`uiLocalePreference` 降级影子，由其自身维护） | **管理器 setting.json 即全局层**，双向同步 |
| `shortcutBindings` | setting.json（shortcuts 分区） | **管理器 setting.json 即全局层**，双向同步 |
| `theme`（zai-dark/zai-light/system） | 各进程 **localStorage**（`zcode-theme`；`useTheme.ts`/store），不在 setting.json——appSettingsSchema 的 zod strip 会在下次写盘时丢弃未知键 | **桥命令 + 管理器侧侧车**（`~/.omnicode/console/omnicode-global-prefs.json`，omnicode 自有文件、官方零接触）；apply 时经各进程自身 `state:theme` 广播落各自的 localStorage |

「不新建文件」指不另设 setting.json 之外的**全局层事实源**；theme 侧车是它官方存储
（localStorage）无法进 setting.json 时的唯一可行落盘位，与 console-ui.json 同一
atomicJson 读写内核（原子写 + 损坏自愈 + .bak 回滚）。

- 管理器全局层 setting.json：`~/.omnicode/console/.zcode/v2/setting.json`
  （`ZCODE_DESKTOP_HOME_DIR` 注入，desktopDataBaseDirBootstrap 批次2a 补盲同源）。
- 实例层 setting.json：`<dataBaseDir>/.zcode/v2/setting.json`（profileBootstrap 五件套）。

## G1.3 键白名单（shared 常量）

`OMNICODE_GLOBAL_PREF_KEYS`（packages/shared/src/omnicodeGlobalPrefs.ts）——setting.json 层
可同步键（实测探测后定案）：

1. `locale`（Locale 枚举，落盘值兼容旧版中英限制）
2. `localePreference`（"system" | Locale，真实偏好）
3. `shortcutBindings`（Record<命令 id, 组合键数组>）

外加桥/侧车层键 `theme`（`OMNICODE_THEME_PREF_KEY`，值域 system/zai-light/zai-dark，
light/dark 由官方 normalize 归一后才广播）。

**白名单外键零触碰**是结构性的，不是约定性的：`filterOmnicodeGlobalPrefsFromPatch` /
`sanitizeOmnicodeGlobalPrefsPayload` 只保留白名单键且逐键值域校验（locale 枚举、偏好枚举、
快捷键 Record 形状、主题枚举），未知/非法键一律丢弃；own-property 检查免疫原型链污染。
观察点、桥命令、上报消息三个入口都先过同一收口。单测锁定：伪造含
providerFamilyDomain / webRemoteControlRelayV2Device / dataBaseDir / __proto__ 等敏感键的
载荷，过滤器必须全部丢弃。

## G1.4 观察点（main 侧两路变更来源）

管理器与实例是同一份桌面程序，观察点完全对称（omnicode/globalPrefs.ts 的协调器按身份路由）：

1. **BroadcastHub state:* 广播观察**（broadcastHub.ts `[OmniCode]` 增补）：
   - `onOmnicodeRendererStateBroadcast(channel, payload)` 在 `relay()` 内登记，只观察
     **renderer 发起**的广播（`state:locale` / `state:theme`——语言走 IntlProvider 的
     {preference, resolvedLocale} 结构化载荷，主题走 store 订阅的字符串载荷）；
   - 未注册回调时 relay 行为逐字节不变（官方零影响）；回调 try 包裹，观察失败不影响转发；
   - **注入不经过 relay**：main 侧热应用走新增的 `relayFromOmnicodeMain(channel, payload)`
     （schema 校验 + postMessage 到全部 host，sourceWindowId=-1 哨兵）。因此观察点看不到
     自己的注入，**结构性无回环**。
2. **SyncAppSettings patch 观察**（main/index.ts `syncImmediateAppSettings` 首行 `[OmniCode]`
   调用）：`useSettingService.update` 落盘后的 main 即时通道（官方 shortcutBindings 菜单
   重建即走此路），patch 过白名单后路由。官方分支行为逐行原样。

语言/主题变更到达 main 的路径说明：IntlProvider 的 state:locale 广播与 store 的 state:theme
广播都经 Host → main BroadcastHub（官方跨窗口机制），main 因此天然可见；语言与快捷键的
落盘仍由官方链路（settingService.update / useSettingService.update）完成，观察点只做转发。

## G1.5 同步语义

### 下行（管理器 → 实例）

```
管理器窗口改偏好
  → 官方落盘链路（管理器 setting.json / theme localStorage）
  + 观察点（白名单过滤）
  → 桥命令 applyGlobalPrefs {prefs, sourceInstanceId:"manager"}
      → 全部已回连实例（getOmnicodeConnectedInstanceProfileIds；未连接不投不重试）
```

实例收到后（globalPrefs.handleOmnicodeGlobalPrefsApplyCommand）：

1. **环形抑制**：`sourceInstanceId === 自己 profileId` → 忽略（回声）；
2. 消毒载荷（白名单 + 值域）；
3. 写**自己** setting.json 白名单键（走本进程 mainSettingService——官方写队列 + 文件锁，
   与 renderer/host 侧写同锁安全）；theme 不写 setting.json（schema strip 会丢）；
4. 热应用：
   - locale：注入 `state:locale {preference, resolvedLocale}` 到自己 hub → IntlProvider
     既有广播机制热切换（resolvedLocale = 载荷 locale ?? system 时本进程
     `currentApplicationLocale`）；
   - theme：注入 `state:theme` → store.setTheme → 官方 DOM/localStorage 应用；
   - shortcutBindings：`rebuildMenu()` + 全窗口 `PlatformChannels.SettingsChanged`
     （与官方 syncImmediateAppSettings 的 shortcutBindings 分支同款动作，经依赖注入复用）；
5. 写入失败的键记入 deferredKeys（日志标注，待下次同步收敛）——所有白名单键当前均可热应用。

### 上行（实例 → 管理器）

```
实例窗口改偏好
  → 官方落盘链路（实例自己的 setting.json / localStorage）+ 观察点（白名单过滤）
  → 桥消息 reportGlobalPrefs {prefs, sourceInstanceId:<profileId>}
      → 管理器：写自己的全局层（setting.json 白名单键经 mainSettingService +
        theme 侧车）
      → 管理器本进程热应用（state:* 注入 + 快捷键刷新——管理器窗口即时跟随）
      → 下行广播 applyGlobalPrefs {prefs, sourceInstanceId:<源实例 id>}
          → 源实例收到回声 → 环形抑制忽略；其余实例应用
```

去重：dispatch 与上行接收共享同一 lastDispatchedJson（归一化后比较）——同值重复观察不重复
广播；A→B→A 序列因两条路径都更新去重键而不会漏播。

### 失败语义（红线）

- 桥未连接 / 发送失败：返回 false 记日志，**不重试**。长断连实例靠「连接即推快照」收敛；
- 管理器写全局层失败：日志 + 继续广播（载荷即真相，不依赖读回）；
- 实例写 setting.json 失败：deferredKeys 日志标注，热应用仍尝试；
- 桥协议无 ack：管理器侧结果标注 = 投递 delivered/missed 名单（日志）；实例侧结果 =
  applied/deferred 键名单（日志）。

### 连接即推快照（theme 主交付面 + 收敛兜底）

实例回连（桥 onInstanceConnected）→ 管理器读全局层快照（setting.json 白名单键 + 侧车
theme）→ applyGlobalPrefs {sourceInstanceId:"manager"}。幂等：spawn 注入已写过的键收到
同值无害；theme（localStorage 域）与长断连期间的漂移由此收敛。

## G1.6 spawn 注入（方案取舍）

**选「spawn 前文件合并」，不选「启动握手下发」**：

- 首帧即正确：语言/快捷键在 renderer 挂载前已在实例 setting.json 就位（IntlProvider 启动
  读取、useSettingService 快照），无语言/键位闪变；握手下发要等桥连接 + renderer 就绪，
  时序上必然后于首帧；
- 无新增协议/握手状态机；连接即推快照仍保留（theme 主交付面 + 收敛兜底），但持久层不依赖它；
- 天然覆盖「未运行的实例下次启动生效」——每次 launch 都重放注入。

实现（globalPrefs.injectOmnicodeGlobalPrefsForSpawn，doLaunch 内 dataBaseDir 确定后、spawn
前调用）：管理器读全局层快照 → 实例 setting.json **raw JSON 浅合并**（只覆盖快照中存在的
白名单键；system 偏好只写 localePreference，不把管理器解析结果写死；实例其余键原样保留；
文件不可解析时不覆盖，fail-open）→ atomicJson 原子写。此时实例进程尚不存在，无写竞争；
注入失败只告警，不阻断启动（启动前置 = 身份五件套，注入是增强）。

## G1.7 测试与守卫

- shared 纯函数：白名单过滤（含敏感键丢弃锁定）、值域校验、环形抑制判定、locale 键映射
  （system 不携带解析结果）；
- 协调器：身份路由（manager 下行 / instance 上行 / official no-op）、环形抑制端到端
  （echo-ignored）、去重（同值不重播、A→B→A 漏播回归）、消毒后落库参数断言；
- 桥协议：reportGlobalPrefs 帧消毒（白名单外键到不了钩子）、applyGlobalPrefs 命令分发；
- 既有 omnicode 用例（122+39+24）零回归；官方路径（relay 无回调 / syncImmediateAppSettings
  官方分支）零行为变化由既有官方用例守护。

## G1.8 已知限制

1. **theme 首启闪变**：全新实例首帧用默认主题（zai-dark），桥连接后快照推送才落到用户主题
   （≈启动后 1s 内）；已有 localStorage 值的实例不受影响。
2. **语言/快捷键的下行热值来自广播载荷**：观察点先于落盘完成（官方 send 不等待持久化 RPC），
   下行推的是用户选择值；spawn 注入读的是已落盘值——两者最终一致（下一轮动作/启动收敛）。
3. **外观分区的代码预览/字号等 localStorage 键未同步**：v1 白名单只含主题；同类机制可平移
   （加键 + 值域校验 + store 观察点），未做以控制爆炸半径。
4. **快捷键 accelerator 热应用依赖 rebuildMenu 注入**：若未来官方重构 rebuildMenu 签名，
   需同步调整依赖注入面（refreshShortcutApplication）。
5. **多管理器不存在**：全局层唯一事实源是本机管理器；跨机不设计（数据根本机隔离）。

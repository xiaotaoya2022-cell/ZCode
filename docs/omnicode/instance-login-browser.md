# OmniCode 实例专属登录浏览器（M1.5）

> 状态：2026-11-10 设计定稿（用户确认）并实现 ｜ 上位：方案报告 §2、profile-runtime.md
> 需求起源：多实例下系统默认浏览器存在账号串扰与回调路由歧义；本设计让登录、授权、回调全程封闭在实例自己的浏览器窗口内。

## 定稿决策（用户确认，2026-11-10）

1. **仅实例专属浏览器一条登录路径**，无痕模式移除（实例:账号 1:1 + 工作区共享，换号场景被"新建实例"替代；无痕反而杀掉 SSO Cookie，让官方缺失刷新链路的痛点每次到期都暴露为手输密码）。
2. **持久分区**：`persist:omnicode-auth-<profileId>`——数据落在实例自己的 `electron-userdata/Partitions/` 下，Cookie 跟随实例存活；token 到期后残留 SSO Cookie 支持**静默重授权**（补偿官方缺失的 refresh 链路；待真机验证 z.ai 授权端点对已登录会话是否免确认直发 code，若需点一次"允许"则降级为一键确认，仍优于手输）。
3. **清除浏览器会话 = 高级维护动作**（非登录模式）：账号在别处改密/分区异常时使用；删除 Profile 时分区随 `electron-userdata/` 一并移除，无残留。
4. **手动粘贴回调 = 失败态恢复入口**（常驻页脚删除）：导航拦截 + 官方轮询两层自动机制之下，手动粘贴仅服务"两层皆失效"的 bug 场景。

## 机制（参照 cockpit-tools v1.3.81 `src-tauri/src/modules/zcode_oauth.rs:125-186`，Electron 映射）

| Tauri（Cockpit） | Electron（OmniCode） |
|---|---|
| `WebviewWindowBuilder` + `.incognito(bool)` | `BrowserWindow` + `webPreferences.partition`（persist: 前缀=持久，无前缀=内存） |
| `on_navigation` 返回 false 拦截回调 | `webContents.on("will-navigate"/"will-redirect")` + `preventDefault()`；`setWindowOpenHandler` 全拒（弹窗兜底） |
| `is_zcode_callback_url` 校验（state+provider 形状） | **直接复用官方 `handleDeepLink`**：`oauthStateToWindow.get(state)` 路由到发起窗口，官方已做 state 校验与 pending 缓存，零新增状态存储 |
| 300s 过期 | 300s 超时销毁窗口（renderer 侧官方轮询超时自行收口 UI） |

## 流程

1. 实例内任意登录入口（`useOAuth.ts:96` / `oauthActions.ts:24`）先 `registerOAuthState`（官方语义不变），随后调用 `platform.openExternal(authorizeUrl)`。
2. `desktopPlatform.openExternal` 分流：当前进程为 Profile 实例（preload 注入 `__OMNICODE_PROFILE_ID__`）且 URL 命中授权形状 → `omnicodeOpenAuthWindow` IPC；否则走系统浏览器（控制台/官方身份行为不变）。
3. Main 侧二次校验 URL 形状（纵深防御）后创建内置窗口（920×720 / min 640×560，分区按 profileId），加载授权页。
4. 授权完成页跳转 `zcode://oauth/callback?code=…&state=…` → 拦截 preventDefault → 调用官方 `handleDeepLink`（state 校验 + 路由到实例主窗口 renderer）→ 关窗。
5. renderer 收到 `OAuthCallback` → 官方 code 交换链路不变；凭据写入该实例 `.zcode/v2/credentials.json`。

## 授权 URL 形状（匹配规则，renderer 与 main 双侧同规则）

- `https://chat.z.ai/api/oauth/authorize`（ZAI）
- `https://bigmodel.cn/login?appId=zcode…`（BigModel）
- 其余 `openExternal` 调用（文档、外部链接）不受影响。

## 验收场景

1. 实例 A 登录：授权页在实例内置窗口打开，全程无系统浏览器参与；回调拦截后窗口自动关闭，实例主窗口完成登录。
2. 实例 A 与控制台同时运行，控制台走系统浏览器、实例走内置窗口，互不影响。
3. 同账号到期重登：内置窗口打开授权页 → 依赖分区 Cookie 静默（或一键）授权 → 免手输密码（待真机验证项）。
4. 授权窗口内点击任何弹窗链接被拒（v0 限制：第三方登录若强依赖弹窗，走重定向式则正常；记录限制）。
5. 300s 无操作窗口自动销毁；renderer 登录态按官方轮询超时收口。
6. 删除 Profile：`electron-userdata/`（含分区数据）随目录整体移除。
7. `pnpm typecheck` / `architecture:check --changed` 0 新增违规。

## 已知限制与延后

- `setWindowOpenHandler` 全拒：若 Z.ai/BigModel 登录强依赖弹窗式第三方登录，v0 下该入口不可用（重定向式正常）；真机验证后决定是否放行同域弹窗。
- SSO 静默重授权的真机验证项见决策 2。

## 手动粘贴回调恢复入口（决策 4 落地，2026-11-10）

常驻 UI 不出现；仅当登录失败态（`WelcomeScreen.tsx` 的 `status === "error" || oauthError` 分支，
覆盖启动失败、轮询失败与 300s 超时后的收口错误）出现时，在错误面板底部提供可折叠的"高级恢复"区：

1. 折叠开关 `oauth-advanced-recovery-toggle` → 展开 `oauth-advanced-recovery-input`（单行输入，粘贴完整回调 URL）
   与 `oauth-advanced-recovery-submit`。
2. 提交走 `platform.submitOmnicodeCallback({ url })`（`IPlatformService` 可选方法，Web/旧 preload 缺席即无入口）
   → shared channel `OmnicodeSubmitCallback: "zcode:omnicode-submit-callback"`（request `{url}`，response `{ok, accepted}`）
   → main `desktopMainIpcRemote.ts` 的 ipcMain.handle：先经 `normalizePastedOmnicodeCallbackUrl` 归一化
   （`http(s)://localhost|127.0.0.1:1455/auth/callback?…` 重写为 `zcode://oauth/callback?…`，仅保留 query；
   其余形状原样），再复用官方 `handleDeepLink` 路由（state 校验 + 路由到发起窗口，与内置窗口拦截零差异）。
3. `accepted=true` → toast「回调已接收」并折叠恢复区；官方 1s 轮询 / OAuthCallback 链路自动收敛登录态。
   `accepted=false` → toast「回调未被接收：state 不匹配或已过期」（不区分 URL 格式错误与过期，避免暴露内部细节）。

## zcode:// 跨实例投递（最后兜底，2026-11-10）

背景：`zcode://` OS 级注册是全局单点（`registerDeepLinkProtocol` 不带实例标识），OS 回调只会拉起注册时的
默认实例；用户在外部浏览器完成授权的边缘场景下，回调可能落到未发起登录的实例。内置窗口拦截 + 同实例
`oauthStateToWindow` 路由的主路径不受本机制影响。

- **写入端**（`desktopOAuthDeepLink.ts` `handleDeepLink` OAuth 回调分支）：本进程是 Profile 实例
  （`isOmnicodeProfileInstanceEnv`）且 `oauthStateToWindow` 无该 state → 把回调 URL 写入
  `~/.omnicode/shared/oauth-callbacks/<state>.json`（`{url, receivedAt}`）并 log 转投说明，向调用方返回 true。
  state 文件名强制 `/^[0-9a-f]{16,64}$/`（hex 白名单防路径穿越）+ resolve 前缀围栏；目录根与
  `services workspaceLocks.getOmnicodeSharedRoot` 语义一致（`OMNICODE_SHARED_ROOT` 优先，否则
  `~/.omnicode/shared`），desktop 内独立实现、不 import services。
- **消费端**（同文件 `startOmnicodeOAuthCallbackRelayConsumer`）：`OAuthRegisterState` IPC 处理时拉起
  1s 消费 tick（与官方 renderer 轮询同节奏；`oauthStateToWindow` 为空且投递目录已空时自动停表，不常驻）。
  每轮读取投递目录：文件 state 命中本进程 `oauthStateToWindow` → 调官方 `handleDeepLink(url)` 路由后删除文件
  （未就绪时保留重试）；不匹配的文件超 60s 懒删除（读到但不匹配的文件由读取方清理）。
- `handleDeepLink` 返回 true = 已接收（转投成功或正常路由都算）；false 仅保留给窗口未就绪等暂态。

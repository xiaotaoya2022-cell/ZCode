# 远程聚合（丙1：聚合宿主实例）— 实施规格

> 状态：**定稿待实施**（2026-11-22，用户批准开工）。M0 调研依据：OmniCode 仓
> docs/batch4/research/remote-control-feasibility.md（事实链 file:line 已核）。
> 关联：OmniCode 仓 docs/batch4/research/single-instance-multi-account.md（模式二）——
> 模式二落地后本 spec 的 M3（跨实例聚合）优先级下调，M2（宿主自身多窗口聚合）不受影响。

## 1. 目标

手机只配对一次（一条固定链接/一个二维码），即可浏览并发起**聚合宿主实例可见范围内**的全部
工作区与会话操作。范围（M2→M3 递进）：
- M2：宿主实例**自身多窗口**的工作区聚合（官方每窗口一个 WindowControlRuntime 已存在，
  聚合 = 合并 workspace-list + 多 bridge 共存路由）。
- M3：**跨实例**聚合——其他实例的工作区经管理器桥（instanceBridge）上交宿主转发。

## 2. 非目标

- 不改手机端页面（z.ai OSS 不可控）；不新建 relay（官方 relay 复用）。
- 不做自托管手机页/Sites 中转（二期选项，见 OmniCode 仓 deploy-and-link-pairing.md：
  OAuth redirect 锁死官方域 + Sites 300s 请求硬切 + 机审三硬点）。
- 不改锁语义/凭据语义（与 D12 接管流、模式二互不依赖）。

## 3. 架构（丙1）

```
手机网页 ──relay(wss)──► 聚合宿主实例（唯一注册 relay 设备的已登录实例）
                            │ webRemoteControlManager（官方，门控聚合分支）
                            │ omnicode/remoteAggregateHost.ts（新增）
                            ├─ 宿主自身各窗口 workspace（官方 runtime 直连）
                            └─ 桥命令 remoteBridgeForward ──► 管理器 ──► 被聚合实例
                                                    （instanceBridge 既有通道）
```

- **角色**：聚合宿主 = 唯一对外设备；被聚合实例不注册 relay、不出现 device-not-owned 问题。
- **管理器职责**：编排（选宿主/转发/断连对账），不碰 relay、不需要账号 JWT（绕开 M0 甲方死结）。

## 4. 桥协议扩展（新增，全部 omnicode 域）

上行（实例→管理器→宿主方向经管理器路由）与下行对称，载荷均为不透明透传：

| 消息 | 方向 | 载荷 |
| --- | --- | --- |
| remoteForward | 实例→管理器 | {forwardId, target:"host", kind:"workspace-list"\|"rpc-frame"\|"bridge-open"\|"bridge-close", payload} |
| remoteForwardResult | 管理器→来源实例 | {forwardId, ok, payload?, error?} |
| remoteHostAnnounce | 管理器→全部实例 | {hostProfileId, epoch}（宿主变更广播） |

- 身份绑定：来源 profileId 取桥握手真身（D12 同款）；forwardId 幂等去重。
- rpc-frame 透传上限 = 桥消息上限（M1-R1 实测；超过则拒绝并回错误，不做分片——v1 语义）。

## 5. workspace-list 聚合语义

- 条目键：`aggregatedKey = profileId + ":" + (workspaceIdentity || workspacePath)`
  ——跨实例同路径天然去重；宿主自身条目 profileId="self"。
- 条目元数据附加：实例显示名 + 账号族徽标（手机页不认识的新字段放在 payload 附加区，
  官方页面忽略未知字段——M1-R4 验证官方页面渲染容错）。
- 合并顺序：宿主自身 → 同账号实例 → 跨账号实例（显式开启后）。

## 6. 状态与 failover

- 宿主在线判定：桥心跳（既有）。宿主退出 → 管理器 toast + remoteHostAnnounce(epoch+1)。
- **已知限制（修正 demo 承诺）**：固定链接含宿主 sid/mid；宿主更换后 MID 随之变化，
  手机端旧链接进入设备列表/重选流程（relay"无 sid 拉设备列表"路径），**不是无缝不变**。
  二期可评估"宿主代理 keep-alive"（旧宿主进程保留空壳连接）——本期不做，如实标注。
- 被聚合实例退出：其条目从聚合列表摘除（workspace-list-updated 推送），在途 bridge 关闭。

## 7. 安全红线

- 桥命令身份绑定握手真身；rpc-frame 载荷不落盘、不进日志；relay token/JWT 不进日志
  （沿用官方 redaction 约定）。
- 跨账号聚合默认关闭，管理器设置显式开启（omnicodeGlobalPrefs 新键）。
- 无新增常驻轮询（全部事件/桥推送驱动）。

## 8. 实施分步（每步独立门禁：typecheck/architecture/lint/vitest omnicode 全绿）

- **R1（骨架）**：桥协议 schema（shared/omnicodeRemoteForward.ts）+ 聚合纯函数
  （workspace-list 合并/去重/排序 + forwardId 路由表）+ 测试。
- **R2（宿主侧）**：omnicode/remoteAggregateHost.ts 接线——官方 manager 聚合分支
  （omnicode 门控，默认关闭=官方行为逐字不变）+ M2 自身多窗口聚合。
- **R3（跨实例）**：被聚合实例侧执行语义 + 管理器路由（takeover 模式同构）。
- **R4（策略）**：跨账号开关 + failover 提示 + 管理器聚合状态展示。

## 9. M1 真机验证清单（实施 R2 前用户配合项）

1. 同账号多 MID 实例各自注册设备无冲突、设备列表呈现正常。
2. rpc-frame（1MiB 分片/ACK/replay）经 127.0.0.1 桥透传语义完整（桥消息大小上限实测）。
3. 聚合 workspace-list 形状 + 官方手机页对未知附加字段的容错。
4. 异账号实例业务 RPC 无账号断言拦截（默认跨账号关闭，验证同账号路径即可）。
5. KICKED/切换设备在聚合模式的表现（手机应只见宿主一个 SID）。

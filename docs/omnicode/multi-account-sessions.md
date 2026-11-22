# 单实例多账号并发会话（模式二）— 实施规格

> 状态：**定稿**（2026-11-22 用户裁决：单独做模式二，路线A v2 冻结在讨论稿；智能调度=
> 开关式默认开，不强制；其余设计全采纳）。依据：OmniCode 仓
> docs/batch4/research/single-instance-multi-account.md（事实链 file:line 已核）。
> 关联：remote-aggregation.md（丙1）——本 spec 落地后其 M3（跨实例聚合）优先级下调。

## 1. 目标

一个 OmniCode 实例窗口内并存多个账号凭据，会话/任务按账号路由请求凭据，吃满
N 账号 × 每账号并发上限（免费账号 3 并发），无需开多个实例——**解决最初需求**。

## 2. 非目标

- 不动进程模型（路线A v2 冻结；spawn 多实例保留为既有开关，隔离/调试场景沿用）
- 不改官方 oauthCredentialRepo 单账号快照语义、不改 relay/远控链、不做服务端新接口

## 3. 术语

- **主账号**：实例当前 active 登录（官方语义逐字不动）
- **附加账号**：omnicode 账号库中主账号之外的凭据集。两个来源：
  a) **桥代理读取**（推荐默认）：其他 profile 数据根的 credentials.json 经管理器解密代理
     （批次3 accountDetection 读取链已验证"凭据在盘、实例不必运行"）——**零重登迁移**；
  b) 本实例内直接登录附加账号（instanceAuthWindow 复用，写入 omnicode 账号库）。

## 4. 架构（单点覆盖边界）

```
会话/任务 ──meta.accountId──► 请求出口
                                │ resolveCurrentAccountAccess（官方唯一汇聚点，
                                │   全依赖为 node.ts 注入闭包）
                                │ [OmniCode] 覆盖边界（新增 accountOverride.ts）：
                                │   会话绑定 accountId 且≠主账号
                                │     → 返回附加账号材料（桥代理/本地账号库）
                                └─ 无覆盖 → 官方 active 语义逐字不变（官方 flavor 零改动）
```

- 选择器三层的数据模型依据：plan 层本身就是凭据引用（providerId 如 `account:zai-start-plan`），
  账号层是同构扩展。
- ModelSelection 已随 sendText 每次下发（无状态切换）——accountId 同路透传，会话内可换。

## 5. 附加账号库与凭据读取

- 账号条目：{accountId, source:"bridge-proxy"|"local", sourceProfileId?, family, planKind,
  deviceMid}；**凭据材料不复制不落盘**——bridge-proxy 来源按需现取（见 7 缓存策略），
  local 来源存 omnicode 账号库（本实例固化密钥加密）。
- **device_mid 红线**：每账号持久化各自 device_mid——bridge-proxy 来源用**源 profile 的
  telemetry-state.json MID**（与现状多实例特征完全一致，无新增风控面）；local 来源用本实例 MID。
- 桥代理读取（a 来源）：新桥命令 `accountMaterialRequest {accountId}` → 管理器用批次3
  读取链解密返回（127.0.0.1 + timingSafeEqual 既有握手）→ 实例**内存短 TTL 缓存**，
  不落盘不进日志。管理器是唯一解密权威（实例不持有其他 profile 密钥）。

## 6. 智能调度（开关式，默认开，不强制）

- **开（智能）**：发任务时自动挑**剩余并发槽最多**的账号；本地计数器（每账号 running 任务数）
  + 服务端 429/bizCode 3101/3103 退避兜底（临时降权该账号）。用户可不感知账号。
- **关（手动）**：任务创建时账号选择器（默认主账号），完全手动。
- 会话内覆盖：两种模式下都允许会话内换账号（下一次请求生效，与切模型同语义）。
- 槽位可视化：任务列表/选择器显示每账号 `running/上限`（上限可配，默认 3）。

## 7. UI（官方 UI 门控点改）

- 选择器三层：账号（默认"主账号"+附加账号列表）→ 套餐 → 模型（V4ComposerToolbar/
  composerPlanGroups 门控扩展）。
- 任务列表账号徽标 + 槽位可视化；账号看板复用既有数据链展示每账号额度。

## 8. 官方文件改动清单（冲突面预算）

| 类别 | 文件 | 改动 |
| --- | --- | --- |
| 官方点改（门控） | packages/services/src/node.ts | resolver 闭包处 per-session 账号覆盖检查（单点） |
| 官方点改（门控） | V4ComposerToolbar.tsx / composerPlanGroups.ts | 选择器账号层 |
| 官方点改（门控） | 会话 meta 透传链 | accountId 字段（若 Meta 有扩展位则零改，M1-R1 核实） |
| omnicode 新文件 | accountOverride.ts / omnicodeAccounts.ts / accountScheduler.ts / 账号层 UI | 全部新增 |
| 官方零改动 | oauth 层 / offPeak / usage-stats / relay / 锁 / oauthCredentialRepo | 不动 |

## 9. 真机验证清单（R2 前用户配合项）

1. 同 IP 多账号 API 并发：429/3101/3103 实际形态与退避有效性（多实例已在跑，特征无新增）。
2. 附加账号 token 刷新语义：材料缓存 TTL 内 token 过期/刷新写回哪份凭据库
   （v1 策略=缓存过期即重取，不做刷新写回；验证有效期 ≥ TTL）。
3. billing X-Device-Mid per 账号生效（额度查询与扣减归属正确）。
4. 三层选择器渲染（宽度/溢出/键盘导航）。
5. 会话↔账号徽标在任务列表/看板的一致性。

## 10. 实施分步（每步独立门禁：typecheck/architecture/lint/vitest omnicode 全绿）

- **R1（后端骨架）**：账号库 + 桥代理读取 + resolver 覆盖边界 + 会话 accountId 绑定 + 测试（无 UI）。
- **R2（调度）**：per-账号并发计数 + 智能挑选 + 429 退避降权 + 槽位计数。
- **R3（UI）**：三层选择器 + 任务列表徽标 + 槽位可视化。
- **R4（策略收口）**：智能调度开关 + 设置面 + 真机验证清单执行。

## 11. 与其他项的关系

- 路线A v2：冻结（本 spec 落地后实例数预期降到 1~2，v2 动机消失；spawn 多实例开关永久保留）。
- 丙1 远控聚合：M2（宿主自身多窗口聚合）不受影响；M3（跨实例）优先级下调。
- 账号看板/登录健康（批次3）：附加账号额度/健康展示复用其数据链。

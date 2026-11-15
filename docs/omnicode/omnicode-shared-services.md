# 单点下沉：与账号身份无关的拉取型服务（批次四 G3）

> spec-first 事实源：本文件定义「实例各自在跑的拉取型服务」的盘点判定表、营销资产共享
> 缓存（assetFetch 桥协议）的授权链路、缓存语义与已知限制。
> 设计准则（README slogan）：**帮助不随实例数放大的能力就该被共享**——N 个实例各自拉
> 同一份"与账号无关"的资源 = 纯浪费 + N 倍指纹暴露。
> 红线：per-account 的一切（touch 轮询/claim/模型列表/凭据/设备号）零触碰；官方 flavor
> 零改动（桥命令/缓存全在 omnicode 链）；管理器不因下沉新增常驻轮询。

## G3.1 盘点判定表（2026-11-15 实测）

| 服务 | 每实例运行位置 | 与账号身份无关？ | 判定 | 理由 |
| --- | --- | --- | --- | --- |
| 营销 touch 轮询（GET `/api/v1/marketing/touch`，10min） | 实例 Host `marketingTouchService` + renderer poller | **否** | **不下沉（风控红线）** | 请求带 `Authorization: Bearer` + `X-Device-Mid`，快照按账号投放；轮询/上报/领取全部 per-account |
| 营销资产下载（image/video，`readPublishedMedia`） | 实例 Host `marketingAssetRegistry`（进程内 data-URL 缓存，48MB） | **是**（URL 与账号无关，授权来自快照 allow 表） | **下沉** | N 实例重复下载同一 campaign 资产；内容寻址（sha256）可共享 |
| 营销 interactive bundle zip（`prepare`/`acquire`） | 实例 Host `contentBundleCache`（per-instance `<uuid>` 目录，dispose 即删——每次重启都重新下载） | **是**（zip 内容寻址） | **下沉**（共享 zip 字节；解压/租约/本地 HTTP 服务保留实例侧） | 同上，且现行缓存根随 Host 生命周期销毁，重复浪费最重 |
| 模型目录（`fetchZCodeBuiltinRemoteRelease`） | 实例 Host | 否 | **不下沉** | `resolveZcodeJwtToken` 参与请求，账号链路 |
| 客户端配置快照（`clientConfigService`，1h TTL） | 实例 Host | 部分无关 | **不下沉** | 内核明文「不同请求身份不共用快照或在飞请求」——按身份分区，共享会破坏裁剪边界 |
| 语言资源/i18n | renderer 本地打包 | — | **已天然共享** | 无网络拉取 |
| 版本检查/autoUpdate | 实例 main | — | **已禁用，无需处理** | omnicode flavor 在 autoUpdater fail-closed（`autoUpdaterDisabledForProductFlavor`） |
| touch claim/领取 | 管理器 claimRunner + 实例 | 否 | **零触碰（红线）** | per-account 领取动作 |

## G3.2 下沉范围与授权链路（关键设计）

**只有"下载"下沉，授权不下沉。** 资产 URL 的授权始终来自实例自己已验证的 touch 快照
（`marketingAssetRegistry.allow()` 只收 `accept(snapshot)` 喂入的资产；`readMedia`/
`prepare` 都先过 allow 表）。实例只对**已授权**资产发起共享取回；管理器对请求做形态校验
（https-only、sha256 形态、kind 白名单），下载后做 sha256 强校验 + magic 嗅探。信任链：

```
实例快照（Bearer/token 链，per-account）→ 实例 allow 表 → assetFetch 请求（桥 token 握手保护）
→ 管理器形态校验（https-only/无凭据/无重定向）→ 下载 → sha256 == 请求 sha256 → assets-cache/<sha256>
```

管理器**不持有**任何账号凭据参与资产下载（`credentials: "omit"`、`redirect: "error"`），
因此与账号身份零关联；快照本身仍由每实例自取（红线不动）。

## G3.3 桥协议（omnicode 链内）

- 实例 → 管理器报告：`{type: "assetFetch", requestId, src, sha256, kind}`（kind ∈ image/video/bundle）。
- 管理器 → 实例命令：`{type: "assetFetchResult", requestId, assetResult: {ok, dataBase64?, error?}}`。
- 实例 Host ↔ 实例 main 经既有 parentPort 协议新增一对消息（`shared-asset-fetch-request` /
  `shared-asset-fetch-result`，与 credential-cipher / local-media-preview 同形：requestId 关联）。
- 实例 main ↔ 实例 Host 之间 main 侧不依赖窗口存在（下载在 Host 进程，桥在 main 进程，进程内中转）。
- 超时：桥客户端请求 40s（管理器自身下载超时 30s + 回环开销）；Host 侧 50s 安全网防悬挂。
- 断连/管理器不可用：请求立即失败 → **回退实例直连**（既有 download 路径原样保留，不瘫）。

## G3.4 管理器缓存（`~/.omnicode/assets-cache/`）

- 布局：内容寻址 `<cacheRoot>/<sha256>`（无 manifest）；`OMNICODE_ASSETS_CACHE_ROOT` env 可覆盖（dev/test）。
- 命中：lstat（须为普通文件、非符号链接）→ 读 → sha256 复核 == 请求 sha256 → 返回（每次读都复核，防磁盘篡改/损坏）。
- 未命中：https-only 下载（无重定向、无凭据、30s 超时、按 kind 尺寸上限 image 8MB / video 16MB / bundle 8MB）→ sha256 校验 → magic 嗅探（png/jpeg/webp/ftyp/PK）→ 原子发布（tmp + rename，竞态双方内容一致无害）→ 返回。
- 并发去重：管理器内 in-flight 按 sha256 去重（N 实例同请求 → 1 次下载）；实例 Host 侧沿用 registry 既有 pending 去重。
- 容量上限：256MB，LRU（mtime 升序淘汰）——纯函数 `resolveOmnicodeAssetsCacheEviction` 单测锁定。
- 无常驻轮询：缓存只在收到实例 assetFetch 请求时被动读写；管理器既有营销检测轮询（若登录）不被复用也不新增。

## G3.5 官方 flavor 零改动

- 桥命令/报告新类型在共享代码中定义，但 assetFetch 报告只在实例→管理器链上出现（官方无实例回连）。
- 实例 Host 的共享取回入口以 `isOmnicodeProfileInstanceEnv()` 门控：非实例身份（官方/控制台/远端 Host）不注入 provider，行为与现状逐字节一致。
- 管理器钩子仅在 omnicode flavor 注册缓存模块；官方 flavor 的桥服务收到（不可能出现的）请求时按"钩子缺席"回结构化错误 → 实例回退直连。

## G3.6 已知限制

1. 管理器离线/未回连时共享缓存不可用，全部回退直连（功能降级，非故障）。
2. 管理器缓存只服务实例请求；控制台自身的营销资产下载仍直连（不增加控制台↔Host 新通道，收益低）。
3. bundle 的解压/租约/本地 HTTP 服务仍在实例 Host：共享的是 zip 字节（下载去重），每个实例仍各自解压到自己的 content-bundles 目录——跨实例磁盘重复保留（解压产物生命周期绑定实例租约，共享需跨进程租约协调，风险 > 收益）。
4. dev 态 loopback 资产（registry allowLoopback）不进共享缓存（管理器内核 https-only），回退直连。
5. 首轮并发竞态：N 实例同时 miss 时管理器去重为 1 次下载，但多实例回退直连的竞态窗口内仍可能 N 直连（与现状一致，不劣化）。

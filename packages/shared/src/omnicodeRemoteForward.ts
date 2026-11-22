// [OmniCode] 丙1 远程聚合桥协议（spec: docs/omnicode/remote-aggregation.md §4）：
// 聚合宿主 = 唯一注册 relay 设备的已登录实例；被聚合实例的工作区/会话操作经
// 管理器桥（instanceBridge 既有通道）上交宿主转发，下行结果对称回源。载荷均为
// 不透明透传（spec §5 附加区——官方手机页忽略未知字段，M1-R4 验证渲染容错）。
// spec §4 的 target:"host" 为 v1 唯一目标值，去向由管理器路由层编排（R3），
// 载荷 schema 不收 target 字段（消除伪造路由面）。
//
// 红线（实现即约束）：
// - 官方 flavor 零改动：全部消息只在 omnicode 实例桥链上流转，官方进程无桥即
//   天然禁用；本 schema 不触碰 web-remote-control.ts 官方 relay 链任何形状。
// - 身份绑定认证：来源 profileId 一律取桥握手已验的连接身份（D12 同款），
//   载荷自报值不参与授权判定。
// - rpc-frame 载荷不落盘、不进日志（沿用官方 redaction 约定）；透传上限 =
//   桥消息上限（M1-R1 实测），超限拒绝并回错误，不做分片——v1 语义。
// - 不新增常驻轮询：转发结果走既有桥事件推送；pending 死线由 expire 在转发
//   结果/断连对账事件时点调用收口（见 omnicodeRemoteAggregate.ts 路由表）。
import { z } from "zod";

/**
 * 转发载荷类别（spec §4 remoteForward.kind）：
 * - workspace-list：被聚合实例的 workspace-list 快照（聚合合并输入，R2 消费）；
 * - rpc-frame：手机页→实例的业务 RPC 帧透传（官方 1MiB 分片/ACK/replay 原语义）；
 * - bridge-open / bridge-close：在途 workspace bridge 的开合对账帧（spec §6 在途
 *   bridge 关闭语义）。
 */
export const OMNICODE_REMOTE_FORWARD_KINDS = [
  "workspace-list",
  "rpc-frame",
  "bridge-open",
  "bridge-close",
] as const;
export type OmnicodeRemoteForwardKind = (typeof OMNICODE_REMOTE_FORWARD_KINDS)[number];

/** forwardId 长度上限（形态白名单与 takeover requestId 同口径）。 */
export const OMNICODE_REMOTE_FORWARD_ID_MAX_LEN = 64;

const forwardIdSchema = z
  .string()
  .min(8)
  .max(OMNICODE_REMOTE_FORWARD_ID_MAX_LEN)
  .regex(/^[A-Za-z0-9._:-]+$/u, "forwardId 形态非法");

/** 转发载荷：不透明透传，宿主不解读字段语义（只按 kind 路由）。 */
const opaquePayloadSchema = z.record(z.string(), z.unknown());

const hostProfileIdSchema = z.string().regex(/^p[0-9a-z]{8,20}$/u, "hostProfileId 形态非法");

// ─── 桥上行（实例 → 管理器；宿主方向经管理器路由，下行对称）───

/**
 * 实例发起转发（workspace-list 拉取 / rpc-frame 透传 / bridge 开合）。forwardId 由
 * 发起方生成，幂等去重的唯一键（路由表 take 即删，迟到重复天然丢弃）。
 */
export const omnicodeRemoteForwardMessageSchema = z
  .object({
    type: z.literal("remoteForward"),
    forwardId: forwardIdSchema,
    kind: z.enum(OMNICODE_REMOTE_FORWARD_KINDS),
    /** 不透明透传（宿主不落盘、不进日志；桥消息上限之外拒绝，不做分片）。 */
    payload: opaquePayloadSchema.optional(),
  })
  .strict();

/**
 * 管理器→来源实例的转发回执。ok=false 时 error 为摘要（max 200，禁止携带载荷
 * 原文——rpc-frame 不回显红线）；成功时 payload 携带宿主回传的不透明结果。
 */
export const omnicodeRemoteForwardResultMessageSchema = z
  .object({
    type: z.literal("remoteForwardResult"),
    forwardId: forwardIdSchema,
    ok: z.boolean(),
    payload: opaquePayloadSchema.optional(),
    error: z.string().max(200).optional(),
  })
  .strict();

/**
 * 管理器→全部实例的宿主变更广播（spec §6 failover：宿主退出 → epoch+1）。
 * 实例按 epoch 判新旧广播（旧值/同值忽略），hostProfileId 为新宿主桥握手真身。
 */
export const omnicodeRemoteHostAnnounceMessageSchema = z
  .object({
    type: z.literal("remoteHostAnnounce"),
    hostProfileId: hostProfileIdSchema,
    epoch: z.number().int().nonnegative(),
  })
  .strict();

export type OmnicodeRemoteForwardMessage = z.infer<typeof omnicodeRemoteForwardMessageSchema>;
export type OmnicodeRemoteForwardResultMessage = z.infer<
  typeof omnicodeRemoteForwardResultMessageSchema
>;
export type OmnicodeRemoteHostAnnounceMessage = z.infer<
  typeof omnicodeRemoteHostAnnounceMessageSchema
>;

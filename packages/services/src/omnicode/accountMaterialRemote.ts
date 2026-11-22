// [OmniCode] 模式二 R2：附加账号材料 bridge-proxy 来源提供者（spec:
// docs/omnicode/multi-account-sessions.md §5——"bridge-proxy 来源按需现取 + 实例内存短
// TTL 缓存，不落盘不进日志"）。
//
// 通道：走 R1.5 留下的 host→main 消息契约（HostResponseTypes.OmnicodeAccountMaterialRequest
// → HostMessageTypes.OmnicodeAccountMaterialResult，shared/omnicodeAccountMaterial.ts 载荷
// 契约）。main（实例 main）经实例桥把请求转给管理器解密代理（管理器唯一解密权威，实例
// 不持有其他 profile 密钥）；处理依赖缺席时 main 回结构化失败应答。
//
// 本模块职责（纯逻辑 + 可注入，Host 进程内无 IO）：
// - 请求关联（requestId pending 表 + 安全网超时，shared-asset-fetch 先例同款）；
// - 应答二次校验（host 消息 schema → base64 解码 → omnicodeAccountMaterialFileSchema
//   → accountId 防串号一致校验）——纵深防御，任一环节失败按"材料缺失" fail-closed，
//   绝不回落主账号材料；
// - 每账号短 TTL 内存缓存（默认 60s，与 local 文件提供者/覆盖边界同语义；命中与否都
//   缓存，TTL 内不重发桥请求）；
// - 组合提供者：remote（bridge-proxy）优先、local 文件来源兜底——"零重登"目标下桥代理
//   命中即用；两级都缺 → null（fail-closed，调用方决定排队/报错）。
// 红线：材料内容只存在于本进程内存（缓存值 + 返回值），不落盘、不写日志；错误路径只
// 传播固定结构化错误键。
import { randomUUID } from "node:crypto";
import {
  hostOmnicodeAccountMaterialResultMessageSchema,
  omnicodeAccountMaterialRequestPayloadSchema,
  omnicodeAccountMaterialFileSchema,
  type OmnicodeAccountMaterialFileData,
} from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";
import type {
  OmnicodeAccountMaterialProvider,
  OmnicodeAccountOverrideMaterial,
} from "./accountOverride.js";

/** main↔Host 传输口形状（与 createBroadcastService 的 parentPort 同形；测试可注入 stub）。 */
export interface OmnicodeAccountMaterialTransport {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
}

/** bridge-proxy 应答的传输层形状（与 shared 结果载荷契约同构）。 */
export type OmnicodeAccountMaterialTransportReply = {
  ok: boolean;
  dataBase64?: string;
  error?: string;
};

/** 应答 base64 → 材料快照（纯函数，单测锁定）：解码/schema/防串号任一失败 → null。 */
export function decodeOmnicodeAccountMaterialReply(
  dataBase64: string,
  accountId: string,
): OmnicodeAccountOverrideMaterial | null {
  let raw: string;
  try {
    raw = Buffer.from(dataBase64, "base64").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validated = omnicodeAccountMaterialFileSchema.safeParse(parsed);
  if (!validated.success) return null;
  // 防串号：应答材料声称的账号必须与请求键一致（目录解析错位即视为材料缺失）。
  if (validated.data.accountId !== accountId) return null;
  const material: OmnicodeAccountMaterialFileData = validated.data;
  return {
    accountId: material.accountId,
    family: material.family,
    selections: material.selections,
    accountIdentity: material.accountIdentity,
    // 字段形状已由 schema 校验；此处按官方材料类型收口（loginProvider 等联合类型收窄）。
    startPlanMaterial: material.startPlanMaterial as OmnicodeAccountOverrideMaterial["startPlanMaterial"],
    familyMaterial: material.familyMaterial as OmnicodeAccountOverrideMaterial["familyMaterial"],
    deviceMid: material.deviceMid,
  };
}

export interface OmnicodeAccountRemoteMaterialOptions {
  /** Host 进程 parentPort（main↔Host 通道）；null = 远端来源不可用（恒 fail-closed null）。 */
  transport: OmnicodeAccountMaterialTransport | null;
  /** 每账号短 TTL 缓存（默认 60s，spec §5 现取语义）。 */
  cacheTtlMs?: number;
  /** 请求安全网超时（默认 20s；高于实例桥 15s 总预算，桥侧超时先回结构化失败）。 */
  requestTimeoutMs?: number;
  now?: () => number;
  randomId?: () => string;
}

/**
 * bridge-proxy 来源材料提供者（OmnicodeAccountMaterialProvider 实现）。应答处理在构造时
 * 一次性挂到 transport 的 message 事件（broadcastService 同款；迟到/陌生 requestId 直接
 * 丢弃防串扰）。任何失败路径返回 null（fail-closed），绝不抛穿、绝不写日志。
 */
export function createOmnicodeAccountRemoteMaterialProvider(
  options: OmnicodeAccountRemoteMaterialOptions,
): OmnicodeAccountMaterialProvider {
  const now = options.now ?? (() => Date.now());
  const ttl = options.cacheTtlMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  const randomId = options.randomId ?? randomUUID;
  const cache = new Map<
    string,
    { value: OmnicodeAccountOverrideMaterial | null; expiresAt: number }
  >();
  const pending = new Map<
    string,
    (reply: OmnicodeAccountMaterialTransportReply) => void
  >();

  // 应答路由（构造期一次挂载；无应答也不轮询——事件驱动）。
  if (options.transport) {
    options.transport.on("message", (e: { data: unknown }) => {
      const parsed = hostOmnicodeAccountMaterialResultMessageSchema.safeParse(e?.data);
      if (!parsed.success) return;
      const settle = pending.get(parsed.data.requestId);
      if (!settle) return;
      pending.delete(parsed.data.requestId);
      settle({
        ok: parsed.data.ok,
        ...(parsed.data.ok && parsed.data.dataBase64
          ? { dataBase64: parsed.data.dataBase64 }
          : {}),
        ...(!parsed.data.ok && parsed.data.error ? { error: parsed.data.error } : {}),
      });
    });
  }

  const loadUncached = async (
    accountId: string,
  ): Promise<OmnicodeAccountOverrideMaterial | null> => {
    const transport = options.transport;
    if (!transport) return null;
    // 发送前载荷校验（纵深防御：形态不合法根本不出进程）。
    const request = omnicodeAccountMaterialRequestPayloadSchema.safeParse({ accountId });
    if (!request.success) return null;
    let reply: OmnicodeAccountMaterialTransportReply;
    try {
      reply = await new Promise<OmnicodeAccountMaterialTransportReply>((resolve) => {
        const requestId = randomId();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve({ ok: false, error: "omnicode_account_material_timeout" });
        }, Math.max(1_000, requestTimeoutMs));
        timer.unref?.();
        pending.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        try {
          transport.postMessage({
            type: HostResponseTypes.OmnicodeAccountMaterialRequest,
            requestId,
            request: request.data,
          });
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          resolve({
            ok: false,
            error: error instanceof Error ? error.message : "omnicode_account_material_send",
          });
        }
      });
    } catch {
      return null;
    }
    if (!reply.ok || !reply.dataBase64) return null;
    return decodeOmnicodeAccountMaterialReply(reply.dataBase64, accountId);
  };

  return {
    async load(accountId) {
      const cached = cache.get(accountId);
      if (cached && cached.expiresAt > now()) return cached.value;
      const value = await loadUncached(accountId);
      cache.set(accountId, { value, expiresAt: now() + ttl });
      return value;
    },
  };
}

export interface OmnicodeAccountCompositeMaterialOptions {
  /** 主来源（bridge-proxy；"零重登"目标，命中即用）。 */
  remote: OmnicodeAccountMaterialProvider;
  /** 兜底来源（local 文件账号库）；两级都缺 → null（fail-closed）。 */
  fallback: OmnicodeAccountMaterialProvider;
}

/**
 * 组合提供者（node.ts 装配点消费）：remote 优先、local 兜底。remote 命中（含 TTL 缓存
 * 命中）直接返回；remote 未命中（null = 目录无此账号/桥断连/解密失败）才查 local；
 * 两级都缺返回 null——绝不回落主账号材料（防串号，spec §4）。
 */
export function createOmnicodeAccountRemoteFirstMaterialProvider(
  options: OmnicodeAccountCompositeMaterialOptions,
): OmnicodeAccountMaterialProvider {
  return {
    async load(accountId) {
      const remote = await options.remote.load(accountId);
      if (remote) return remote;
      return await options.fallback.load(accountId);
    },
  };
}

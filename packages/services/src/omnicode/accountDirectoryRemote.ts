// [OmniCode] 模式二 R3/R4：附加账号目录元数据的 Host→main 请求提供者（spec:
// docs/omnicode/multi-account-sessions.md §6/§7）。
//
// 通道：host→main 消息契约（HostResponseTypes.OmnicodeAccountDirectoryListRequest →
// HostMessageTypes.OmnicodeAccountDirectoryListResult，shared/omnicodeAccountMaterial.ts
// 载荷契约）。main（实例 main）用 TTL 缓存应答（缓存未命中才经桥问管理器枚举——管理器
// 仍是唯一枚举权威）。消费方：调度器 pickAccount 候选（R4 智能调度缺省路径）。
//
// 本模块职责（纯逻辑 + 可注入，Host 进程内无 IO）：
// - 请求关联（requestId pending 表 + 安全网超时，accountMaterialRemote 先例同款）；
// - 应答二次校验（host 消息 schema → shared 条目 schema 逐条校验，防载荷放大/漂移）；
// - 短 TTL 内存缓存（默认 60s；失败不缓存，下次查询重试）。
// 红线：元数据 only——条目形状由 shared schema 锁定（accountId/sourceProfileId/family/
// displayName），任何凭据字段到不了本提供者的返回值。
import { randomUUID } from "node:crypto";
import {
  hostOmnicodeAccountDirectoryListResultMessageSchema,
  omnicodeAccountDirectoryEntrySchema,
  omnicodeAccountDirectoryListRequestPayloadSchema,
  type OmnicodeAccountDirectoryEntry,
} from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

/** main↔Host 传输口形状（与 accountMaterialRemote 同形；测试可注入 stub）。 */
export interface OmnicodeAccountDirectoryTransport {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
}

/** 目录请求安全网超时（默认 15s；实例 main 缓存命中应答为毫秒级）。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** 目录缓存 TTL（与实例 main 侧缓存同节奏；candidates 只需要形态稳定）。 */
const DEFAULT_CACHE_TTL_MS = 60_000;

export interface OmnicodeAccountDirectoryRemoteOptions {
  /** Host 进程 parentPort（main↔Host 通道）；null = 目录来源不可用（恒空列表）。 */
  transport: OmnicodeAccountDirectoryTransport | null;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  randomId?: () => string;
}

/**
 * 目录元数据提供者（调度器候选来源）。应答处理在构造时一次性挂到 transport 的 message
 * 事件（accountMaterialRemote 同款；迟到/陌生 requestId 直接丢弃防串扰）。任何失败路径
 * 返回空列表（不缓存失败），绝不抛穿、绝不写日志。
 */
export function createOmnicodeAccountDirectoryRemoteProvider(
  options: OmnicodeAccountDirectoryRemoteOptions,
): { list(): Promise<readonly OmnicodeAccountDirectoryEntry[]> } {
  const now = options.now ?? (() => Date.now());
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const randomId = options.randomId ?? randomUUID;
  let cache: { value: OmnicodeAccountDirectoryEntry[]; expiresAt: number } | null = null;
  const pending = new Map<string, (reply: { ok: boolean; accounts?: unknown[] }) => void>();

  // 应答路由（构造期一次挂载；无应答也不轮询——事件驱动）。
  if (options.transport) {
    options.transport.on("message", (e: { data: unknown }) => {
      const parsed = hostOmnicodeAccountDirectoryListResultMessageSchema.safeParse(e?.data);
      if (!parsed.success) return;
      const settle = pending.get(parsed.data.requestId);
      if (!settle) return;
      pending.delete(parsed.data.requestId);
      settle({
        ok: parsed.data.ok,
        ...(parsed.data.ok && parsed.data.accounts ? { accounts: parsed.data.accounts } : {}),
      });
    });
  }

  const listUncached = async (): Promise<OmnicodeAccountDirectoryEntry[]> => {
    const transport = options.transport;
    if (!transport) return [];
    const request = omnicodeAccountDirectoryListRequestPayloadSchema.parse({});
    const reply = await new Promise<{ ok: boolean; accounts?: unknown[] }>((resolve) => {
      const requestId = randomId();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false });
      }, Math.max(1_000, requestTimeoutMs));
      timer.unref?.();
      pending.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      try {
        transport.postMessage({
          type: HostResponseTypes.OmnicodeAccountDirectoryListRequest,
          requestId,
          request,
        });
      } catch {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false });
      }
    });
    if (!reply.ok) return [];
    // 逐条 schema 校验（防桥载荷放大/漂移；失败条目整条丢弃）。
    const entries: OmnicodeAccountDirectoryEntry[] = [];
    for (const raw of reply.accounts ?? []) {
      const parsed = omnicodeAccountDirectoryEntrySchema.safeParse(raw);
      if (parsed.success) entries.push(parsed.data);
    }
    return entries;
  };

  return {
    async list() {
      const cached = cache;
      if (cached && cached.expiresAt > now()) return cached.value;
      const value = await listUncached();
      // 空列表与失败同形：都不缓存（真实空目录重试幂等无害；失败下次查询重试——
      // 智能挑选在目录空时回落主账号，不阻断发送）。
      if (value.length > 0) {
        cache = { value, expiresAt: now() + ttl };
      }
      return value;
    },
  };
}

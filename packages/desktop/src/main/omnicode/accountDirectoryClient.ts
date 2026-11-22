// [OmniCode] 模式二 R3：实例 main 侧附加账号目录客户端（spec:
// docs/omnicode/multi-account-sessions.md §7）。
//
// 职责（实例 main 进程内，纯内存 + 事件驱动，无轮询）：
// - 桥取回应答按 shared 契约逐条校验（omnicodeAccountDirectoryEntrySchema——防桥载荷
//   放大/漂移），校验失败的条目整条丢弃；
// - 每 TTL 内存缓存（命中即用，不重发桥请求；失败不缓存，下次查询重试）；
// - 双消费方共用同一缓存：renderer IPC（选择器账号层/徽标显示名）与 Host 请求（调度器
//   pickAccount 候选）。**元数据 only**——凭据/deviceMid 永不进入本模块返回值（红线）。
import {
  omnicodeAccountDirectoryEntrySchema,
  type OmnicodeAccountDirectoryEntry,
} from "@zcode/shared";
import { requestOmnicodeAccountDirectoryFromManager } from "./instanceBridgeClient.js";

/** 目录缓存 TTL（spec §5 现取语义的目录级近似；管理器逐 profile 枚举有盘 IO）。 */
const OMNICODE_ACCOUNT_DIRECTORY_CACHE_TTL_MS = 60_000;
/** 桥取回安全网（低于实例桥 15s 总预算，桥侧超时先回结构化失败）。 */
const OMNICODE_ACCOUNT_DIRECTORY_REQUEST_TIMEOUT_MS = 12_000;

interface CachedDirectory {
  value: OmnicodeAccountDirectoryEntry[];
  expiresAt: number;
}

let cache: CachedDirectory | null = null;
let inFlight: Promise<OmnicodeAccountDirectoryEntry[]> | null = null;

/** 桥应答 → 校验条目列表（纯函数；逐条 schema 校验，失败条目整条丢弃，防载荷放大）。 */
export function decodeOmnicodeAccountDirectoryReply(
  reply: { ok: boolean; accounts?: unknown[]; error?: string },
): { entries: OmnicodeAccountDirectoryEntry[]; error: string | null } {
  if (!reply.ok) {
    return { entries: [], error: reply.error ?? "account_directory_unavailable" };
  }
  const entries: OmnicodeAccountDirectoryEntry[] = [];
  for (const raw of reply.accounts ?? []) {
    const parsed = omnicodeAccountDirectoryEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
  }
  return { entries, error: null };
}

/**
 * 读附加账号目录（TTL 缓存；并发请求共享同一 in-flight，防重复桥流量）。失败返回空列表
 *（不缓存失败——下次查询重试；调用方按"目录空"渲染，绝不抛穿）。
 */
export async function getOmnicodeAccountDirectoryList(): Promise<OmnicodeAccountDirectoryEntry[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const reply = await requestOmnicodeAccountDirectoryFromManager(
          OMNICODE_ACCOUNT_DIRECTORY_REQUEST_TIMEOUT_MS,
        );
        const { entries } = decodeOmnicodeAccountDirectoryReply(reply);
        // 空目录与失败同形：都不缓存（失败重试；空目录=真实无附加账号或桥瞬断，
        // 下次查询重试幂等无害——绝不把"空目录"钉死成事实源）。
        if (entries.length > 0) {
          cache = {
            value: entries,
            expiresAt: Date.now() + OMNICODE_ACCOUNT_DIRECTORY_CACHE_TTL_MS,
          };
        }
        return entries;
      } catch {
        return [];
      } finally {
        inFlight = null;
      }
    })();
  }
  return await inFlight;
}

/** 重置缓存（测试专用）。 */
export function resetOmnicodeAccountDirectoryCacheForTest(): void {
  cache = null;
  inFlight = null;
}

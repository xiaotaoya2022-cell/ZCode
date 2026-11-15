// [OmniCode] 批次4 单点下沉：共享营销资产取回请求的形状契约（spec:
// docs/omnicode/omnicode-shared-services.md §G3.2/§G3.3）。
// 形状校验是管理器侧的**授权形态门**：请求只允许 https 直链 + 64 位十六进制 sha256 +
// 白名单 kind；管理器不持任何账号凭据（credentials: "omit" / redirect: "error"），
// URL 授权本身仍由实例的已验证 touch 快照 allow 表完成（实例侧先 allow 再发起取回）。
// loopback/dev 资产不进共享缓存（https-only 门，回退实例直连既有下载路径）。
import { z } from "zod";

export const OMNICODE_SHARED_ASSET_KINDS = ["image", "video", "bundle"] as const;

export const omnicodeSharedAssetKindSchema = z.enum(OMNICODE_SHARED_ASSET_KINDS);

export const omnicodeSharedAssetRequestSchema = z
  .object({
    src: z
      .string()
      .max(4096)
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const parsed = new URL(value);
        // https-only：管理器内核不跟随 loopback/http（dev 态资产回退实例直连）。
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: omnicodeSharedAssetKindSchema,
  })
  .strict();

export type OmnicodeSharedAssetRequest = z.infer<typeof omnicodeSharedAssetRequestSchema>;
export type OmnicodeSharedAssetKind = OmnicodeSharedAssetRequest["kind"];

/** 共享资产按 kind 的字节上限（与实例内核同源：image/video 取 marketingAssetRegistry，
 * bundle 取 contentBundleCache 的 ZIP_LIMIT）。 */
export const OMNICODE_SHARED_ASSET_MAX_BYTES: Record<OmnicodeSharedAssetKind, number> = {
  image: 8 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  bundle: 8 * 1024 * 1024,
};

/**
 * 容量上限的 LRU 淘汰决策（纯函数）：按 mtime 升序从最旧开始淘汰，直到总量 ≤ capacity。
 * 新写入条目（mtime 最新）在 capacity ≥ 单文件上限（16MB）时必然存活；capacity 过小时
 * 一并淘汰由调用方兜底（不阻塞发布）。返回应删除的条目名（保序：先删的在前）。
 */
export function resolveOmnicodeAssetsCacheEviction(
  entries: ReadonlyArray<{ name: string; sizeBytes: number; mtimeMs: number }>,
  capacityBytes: number,
): string[] {
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = sorted.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const evicted: string[] = [];
  for (const entry of sorted) {
    if (total <= capacityBytes) break;
    evicted.push(entry.name);
    total -= entry.sizeBytes;
  }
  return evicted;
}

/**
 * in-flight 去重注册表（纯逻辑，可注入执行器单测）：同 key 并发调用共享同一次执行的
 * Promise；settled 后释放 key（下次调用重新执行——读缓存路径由磁盘事实兜底）。
 */
export function createOmnicodeAssetInflightDedup() {
  const pending = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, execute: () => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing as Promise<T>;
      const promise = execute();
      pending.set(key, promise);
      void promise.catch(() => {}).finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
      return promise;
    },
    pendingKeys(): string[] {
      return [...pending.keys()];
    },
  };
}

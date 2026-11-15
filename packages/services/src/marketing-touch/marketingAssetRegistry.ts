import { createHash } from "node:crypto";
import {
  marketingAssetSchema,
  type MarketingAsset,
  type MarketingTouchSnapshot,
  type MarketingVisual,
} from "@zcode/shared";

// [OmniCode] 批次4 单点下沉（spec: docs/omnicode/omnicode-shared-services.md §G3）：
// 共享取回通道由宿主注入（omnicode 实例 Host → main → 桥 → 管理器缓存）；仅对已过
// allow 表的资产发起，返回字节须 sha256 复核（授权不下沉、失败回退直连）。
export interface MarketingSharedAssetFetchInput {
  src: string;
  sha256: string;
  kind: "image" | "video";
}

/** image/video 媒体字节 → data URL。magic 嗅探与既有 download() 内核同源；不符抛错。 */
export function buildMarketingMediaDataUrl(bytes: Uint8Array, kind: "image" | "video"): string {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const mime =
    kind === "video"
      ? buffer.toString("ascii", 4, 8) === "ftyp"
        ? "video/mp4"
        : undefined
      : buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        ? "image/png"
        : buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
          ? "image/jpeg"
          : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp"
            : undefined;
  if (!mime) throw new Error("marketing_asset_type");
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** 下载授权只来自宿主已验证的投放响应；Renderer 不能自行授权地址。 */
export function createMarketingAssetRegistry(
  options: {
    fetch?: typeof fetch;
    allowLoopback?: boolean;
    // [OmniCode] 批次4 单点下沉：宿主注入的共享取回通道（管理器单点缓存）。抛错即回退直连。
    sharedFetch?: (input: MarketingSharedAssetFetchInput) => Promise<Uint8Array>;
  } = {},
) {
  const allowed = new Map<string, Set<string>>();
  const cache = new Map<string, { data: string; size: number }>();
  const pending = new Map<string, Promise<string>>();
  let cacheBytes = 0;
  function allow(asset: MarketingAsset) {
    const parsed = marketingAssetSchema.parse(asset);
    const url = new URL(parsed.src);
    const loopback =
      options.allowLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) return;
    if (!allowed.has(parsed.src) && allowed.size >= 512)
      allowed.delete(allowed.keys().next().value!);
    const hashes = allowed.get(parsed.src) ?? new Set<string>();
    if (hashes.size >= 8) hashes.delete(hashes.values().next().value!);
    hashes.add(parsed.sha256);
    allowed.set(parsed.src, hashes);
  }
  function allows(asset: MarketingAsset) {
    return allowed.get(asset.src)?.has(asset.sha256) === true;
  }
  function visual(value?: MarketingVisual | null) {
    if (!value) return;
    if (value.type === "image") {
      allow(value.image.default);
      if (value.image.dark) allow(value.image.dark);
    }
    if (value.type === "video") {
      allow(value.video.src);
      allow(value.video.fallback);
    }
    if (value.type === "bundle") {
      allow(value.bundle.bundle);
      if (value.bundle.fallback) allow(value.bundle.fallback);
    }
  }
  async function download(asset: MarketingAsset, kind: "image" | "video") {
    const response = await (options.fetch ?? fetch)(asset.src, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body) throw new Error("marketing_asset_download");
    const limit = (kind === "image" ? 8 : 16) * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("marketing_asset_size");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error("marketing_asset_integrity");
    return bytes;
  }
  // [OmniCode] 批次4 单点下沉改造：download() 改返回字节，data URL 构造与内存缓存插入
  // 收口到 readMedia——共享取回与直连下载两条路径共用同一套 48MB data-URL 缓存上限与
  // 淘汰语义（原 download() 内联逻辑原样迁移，行为不变）。
  function rememberMedia(key: string, data: string) {
    while (cacheBytes + data.length > 48 * 1024 * 1024 && cache.size) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.size;
      cache.delete(oldest);
    }
    cache.set(key, { data, size: data.length });
    cacheBytes += data.length;
  }
  return {
    allow,
    allows,
    allowsUrl: (url: URL) => allowed.has(url.href),
    accept(snapshot: MarketingTouchSnapshot) {
      for (const delivery of snapshot.deliveries) {
        if (delivery.resource_position === "banner") {
          visual(delivery.banner.background);
          visual(delivery.banner.success_popup?.hero);
        } else visual(delivery.popup.hero);
      }
    },
    async readMedia(input: MarketingAsset, kind: "image" | "video") {
      const asset = marketingAssetSchema.parse(input);
      if (!allows(asset)) throw new Error("marketing_asset_source");
      if (kind !== "image" && kind !== "video") throw new Error("marketing_asset_type");
      const key = `${kind}:${asset.sha256}`;
      const cached = cache.get(key);
      if (cached) return cached.data;
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = (async () => {
        // [OmniCode] 批次4 单点下沉：先试管理器共享缓存（授权已由 allow 表把关，返回
        // 字节做 sha256 复核 + magic 嗅探），任何失败回退直连既有下载路径（管理器不可用不瘫）。
        if (options.sharedFetch) {
          try {
            const sharedBytes = await options.sharedFetch({
              src: asset.src,
              sha256: asset.sha256,
              kind,
            });
            const sharedBuffer = Buffer.from(sharedBytes);
            if (
              sharedBuffer.length <= (kind === "image" ? 8 : 16) * 1024 * 1024 &&
              createHash("sha256").update(sharedBuffer).digest("hex") === asset.sha256
            ) {
              return buildMarketingMediaDataUrl(sharedBuffer, kind);
            }
          } catch {
            /* 共享通道不可用/校验失败：静默回退直连（行为与无共享通道时一致）。 */
          }
        }
        const bytes = await download(asset, kind);
        return buildMarketingMediaDataUrl(bytes, kind);
      })();
      pending.set(key, promise);
      try {
        const data = await promise;
        rememberMedia(key, data);
        return data;
      } finally {
        pending.delete(key);
      }
    },
  };
}

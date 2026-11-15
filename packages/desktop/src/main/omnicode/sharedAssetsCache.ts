// [OmniCode] 批次4 单点下沉：管理器侧共享营销资产缓存（spec:
// docs/omnicode/omnicode-shared-services.md §G3.4）。
// 职责：实例经桥发起 assetFetch → 这里做内容寻址磁盘缓存（~/.omnicode/assets-cache/<sha256>）
// 的命中读取 / 未命中单点下载（https-only、无重定向、无凭据、尺寸上限、sha256 强校验、
// magic 嗅探）/ 原子发布 / LRU 容量淘汰 / in-flight 去重。
// 边界：管理器不持任何账号凭据参与下载；URL 的授权由实例的已验证 touch 快照 allow 表
// 完成（授权不下沉），本模块只做形态校验与内容校验。无常驻轮询——只在收到实例请求时被动读写。
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createOmnicodeAssetInflightDedup,
  omnicodeSharedAssetRequestSchema,
  OMNICODE_SHARED_ASSET_MAX_BYTES,
  resolveOmnicodeAssetsCacheEviction,
  type OmnicodeSharedAssetRequest,
} from "@zcode/shared";

export const OMNICODE_ASSETS_CACHE_DEFAULT_CAPACITY_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TMP_FILE_PREFIX = "tmp-";

/** 管理器共享缓存根：OmniCode 自有数据根下 assets-cache/（env 可覆盖，dev/test 用）。 */
export function resolveOmnicodeAssetsCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMNICODE_ASSETS_CACHE_ROOT?.trim();
  return override || join(homedir(), ".omnicode", "assets-cache");
}

/**
 * 资产字节 magic 嗅探（纯函数）：与实例侧内核同源（marketingAssetRegistry 的
 * png/jpeg/webp/ftyp + contentBundleCache 的 zip）。kind=bundle 要求 PK 头；不符抛错。
 */
export function sniffOmnicodeSharedAssetMime(bytes: Buffer, kind: OmnicodeSharedAssetRequest["kind"]): string {
  if (kind === "bundle") {
    if (bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex"))) return "application/zip";
    throw new Error("asset_type");
  }
  if (kind === "video") {
    if (bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
    throw new Error("asset_type");
  }
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  throw new Error("asset_type");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface OmnicodeSharedAssetsCacheDeps {
  cacheRoot?: string;
  fetch?: typeof fetch;
  maxTotalBytes?: number;
}

export interface OmnicodeSharedAssetFetchResult {
  ok: true;
  dataBase64: string;
}
export interface OmnicodeSharedAssetFetchFailure {
  ok: false;
  error: string;
}

/**
 * 管理器共享资产缓存。resolve() 是实例 assetFetch 的唯一入口：
 * 形态校验 → in-flight 去重（同 sha256 并发合并为一次下载）→ 磁盘命中（读 + sha256 复核）
 * → 未命中单点下载 → sha256/magic 校验 → 原子发布（tmp + rename）→ 容量淘汰 → 返回 base64。
 */
export function createOmnicodeSharedAssetsCache(deps: OmnicodeSharedAssetsCacheDeps = {}) {
  const cacheRoot = deps.cacheRoot ?? resolveOmnicodeAssetsCacheRoot();
  const maxTotalBytes = deps.maxTotalBytes ?? OMNICODE_ASSETS_CACHE_DEFAULT_CAPACITY_BYTES;
  const doFetch = deps.fetch ?? fetch;
  const inflight = createOmnicodeAssetInflightDedup();
  // in-flight 内容键（下载与发布期间不参与淘汰，防自我回收竞态）。
  const reserved = new Set<string>();

  async function readFromDisk(request: OmnicodeSharedAssetRequest): Promise<Buffer | null> {
    const path = join(cacheRoot, request.sha256);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      if (stat.size > OMNICODE_SHARED_ASSET_MAX_BYTES[request.kind]) return null;
      const content = await readFile(path);
      // 每次读取都复核内容寻址键（磁盘损坏/被篡改 → 视为未命中，走单点下载重建）。
      return sha256Hex(content) === request.sha256 ? content : null;
    } catch {
      return null;
    }
  }

  async function downloadFromOrigin(request: OmnicodeSharedAssetRequest): Promise<Buffer> {
    const limit = OMNICODE_SHARED_ASSET_MAX_BYTES[request.kind];
    const response = await doFetch(request.src, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error("asset_download");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("asset_size");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (sha256Hex(bytes) !== request.sha256) throw new Error("asset_integrity");
    sniffOmnicodeSharedAssetMime(bytes, request.kind);
    return bytes;
  }

  async function publish(bytes: Buffer, sha256: string): Promise<void> {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const staging = join(cacheRoot, `${TMP_FILE_PREFIX}${randomUUID()}`);
    await writeFile(staging, bytes, { mode: 0o600 });
    try {
      // 内容寻址键：并发发布者内容一致，rename 覆盖无害（Windows 侧 Node rename 具替换语义）。
      await rename(staging, join(cacheRoot, sha256));
    } catch (error) {
      await rm(staging, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** 容量淘汰（发布后调用）：跳过在途键；顺带清理超过 1 小时的孤儿 tmp 文件。 */
  async function evict(): Promise<void> {
    const names = await readdir(cacheRoot).catch(() => []);
    const now = Date.now();
    const tmpSweep: Promise<unknown>[] = [];
    const entries: { name: string; sizeBytes: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (name.startsWith(TMP_FILE_PREFIX)) {
        const stat = await lstat(join(cacheRoot, name)).catch(() => null);
        if (stat && now - stat.mtimeMs > 60 * 60_000) {
          tmpSweep.push(rm(join(cacheRoot, name), { force: true }).catch(() => {}));
        }
        continue;
      }
      if (!/^[a-f0-9]{64}$/u.test(name)) continue;
      const stat = await lstat(join(cacheRoot, name)).catch(() => null);
      if (!stat || !stat.isFile() || reserved.has(name)) continue;
      entries.push({ name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    }
    await Promise.all(tmpSweep);
    const evictable = new Set(resolveOmnicodeAssetsCacheEviction(entries, maxTotalBytes));
    await Promise.all(
      [...evictable]
        .filter((name) => !reserved.has(name))
        .map((name) => rm(join(cacheRoot, name), { force: true }).catch(() => {})),
    );
  }

  async function loadOrDownload(request: OmnicodeSharedAssetRequest): Promise<string> {
    const cached = await readFromDisk(request);
    if (cached) return cached.toString("base64");
    reserved.add(request.sha256);
    try {
      const bytes = await downloadFromOrigin(request);
      await publish(bytes, request.sha256);
      await evict().catch(() => {});
      return bytes.toString("base64");
    } finally {
      reserved.delete(request.sha256);
    }
  }

  return {
    /**
     * 实例 assetFetch 请求入口。任何失败都以 {ok:false, error} 结构化返回（调用方转发给
     * 实例，实例回退直连），不抛异常越出钩子边界。
     */
    async resolve(value: unknown): Promise<OmnicodeSharedAssetFetchResult | OmnicodeSharedAssetFetchFailure> {
      const parsed = omnicodeSharedAssetRequestSchema.safeParse(value);
      if (!parsed.success) return { ok: false, error: "asset_request" };
      const request = parsed.data;
      try {
        const dataBase64 = await inflight.run(request.sha256, () => loadOrDownload(request));
        return { ok: true, dataBase64 };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error && error.message ? error.message : "asset_fetch",
        };
      }
    },
  };
}

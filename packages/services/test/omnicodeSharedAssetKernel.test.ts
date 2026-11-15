// [OmniCode] 批次4 单点下沉：共享资产内核回退单测（marketingAssetRegistry /
// contentBundleCache 的可选 sharedFetch 注入点）。spec:
// docs/omnicode/omnicode-shared-services.md §G3.2（授权不下沉）/ §G3.5（回退直连）。
// 写法参照 packages/services/test/inputPredictionSwitch.test.ts（同包相对导入）。
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMarketingMediaDataUrl,
  createMarketingAssetRegistry,
} from "../src/marketing-touch/marketingAssetRegistry.js";
import { createContentBundleCache } from "../src/cloud-content/contentBundleCache.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 合法 PNG 字节（magic 头 + 尾部填充，registry magic 嗅探只看前 8 字节）。 */
function fakePng(): Buffer {
  const head = Buffer.from("89504e470d0a1a0a", "hex");
  return Buffer.concat([head, Buffer.alloc(64, 7)]);
}

/** 最小 stored zip（本地头 + 中央目录 + EOCD，无压缩），内容 index.html + style.css。 */
function fakeZip(): Buffer {
  const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const entries = [
    { path: "index.html", content: "<html><body>hero</body></html>" },
    { path: "style.css", content: "body{color:#fff}" },
  ];
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

describe("marketing asset registry sharedFetch (batch4 assetFetch sink)", () => {
  const mediaUrl = "https://cdn.example.com/hero.png";

  it("未过 allow 表的资产不发起共享取回（授权不下沉，先例=marketing_asset_source）", async () => {
    const bytes = fakePng();
    const sharedFetch = vi.fn(async () => bytes);
    const registry = createMarketingAssetRegistry({ sharedFetch, allowLoopback: false });
    await expect(registry.readMedia({ src: mediaUrl, sha256: sha(bytes) }, "image")).rejects.toThrow(
      "marketing_asset_source",
    );
    expect(sharedFetch).not.toHaveBeenCalled();
  });

  it("共享通道命中：返回字节 sha256 复核通过 → data URL，且不走直连 fetch", async () => {
    const bytes = fakePng();
    const sharedFetch = vi.fn(async () => bytes);
    const directFetch = vi.fn(() => {
      throw new Error("direct download must not run when shared path succeeds");
    });
    const registry = createMarketingAssetRegistry({ sharedFetch, fetch: directFetch as typeof fetch });
    registry.allow({ src: mediaUrl, sha256: sha(bytes) });
    const data = await registry.readMedia({ src: mediaUrl, sha256: sha(bytes) }, "image");
    expect(data.startsWith("data:image/png;base64,")).toBe(true);
    expect(sharedFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("共享通道返回字节 sha256 不符 → 静默回退直连下载（同请求同结果）", async () => {
    const bytes = fakePng();
    const sharedFetch = vi.fn(async () => Buffer.alloc(32, 1)); // 内容不符
    const response = new Response(new Uint8Array(bytes), { status: 200 });
    const directFetch = vi.fn(async () => response);
    const registry = createMarketingAssetRegistry({ sharedFetch, fetch: directFetch as typeof fetch });
    registry.allow({ src: mediaUrl, sha256: sha(bytes) });
    const data = await registry.readMedia({ src: mediaUrl, sha256: sha(bytes) }, "image");
    expect(data.startsWith("data:image/png;base64,")).toBe(true);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it("共享通道抛错（桥断/管理器不可用）→ 静默回退直连下载", async () => {
    const bytes = fakePng();
    const sharedFetch = vi.fn(async () => {
      throw new Error("bridge_disconnected");
    });
    const directFetch = vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 }));
    const registry = createMarketingAssetRegistry({ sharedFetch, fetch: directFetch as typeof fetch });
    registry.allow({ src: mediaUrl, sha256: sha(bytes) });
    const data = await registry.readMedia({ src: mediaUrl, sha256: sha(bytes) }, "image");
    expect(data.startsWith("data:image/png;base64,")).toBe(true);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });
});

describe("buildMarketingMediaDataUrl (magic sniff shared helper)", () => {
  it("png/jpeg/webp/ftyp magic 分别映射对应 mime", () => {
    const png = fakePng();
    expect(buildMarketingMediaDataUrl(png, "image").startsWith("data:image/png;base64,")).toBe(true);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
    expect(buildMarketingMediaDataUrl(jpeg, "image").startsWith("data:image/jpeg;base64,")).toBe(
      true,
    );
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBP"),
      Buffer.alloc(16),
    ]);
    expect(buildMarketingMediaDataUrl(webp, "image").startsWith("data:image/webp;base64,")).toBe(
      true,
    );
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(32)]);
    expect(buildMarketingMediaDataUrl(mp4, "video").startsWith("data:video/mp4;base64,")).toBe(true);
  });

  it("非媒体字节抛 marketing_asset_type", () => {
    expect(() => buildMarketingMediaDataUrl(Buffer.alloc(32, 1), "image")).toThrow(
      "marketing_asset_type",
    );
  });
});

describe("content bundle cache sharedFetch (batch4 bundle zip sink)", () => {
  const bundleUrl = "https://cdn.example.com/hero.zip";
  const zip = fakeZip();
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // 每用例独立缓存根：acquire 会落盘解压产物，共享根会使命中路径串扰下载断言。
  async function makeCache(
    sharedFetch?: (bundle: { sha256: string }) => Promise<Uint8Array>,
    fetchImpl?: typeof fetch,
  ) {
    const cacheRoot = await mkdtemp(join(tmpdir(), "omnicode-bundle-cache-"));
    tempRoots.push(cacheRoot);
    return createContentBundleCache({
      cacheRoot,
      // 可信源门与 registry allow 表同位：只放行测试 bundle URL。
      isTrustedUrl: (url) => url.href === bundleUrl,
      ...(sharedFetch ? { sharedFetch: sharedFetch as never } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  it("共享通道命中：zip 字节 sha256 复核通过 → 解压/租约不变，直连 fetch 不执行", async () => {
    const sharedFetch = vi.fn(async () => zip);
    const directFetch = vi.fn(() => {
      throw new Error("direct download must not run when shared path succeeds");
    });
    const cache = await makeCache(sharedFetch, directFetch as typeof fetch);
    const lease = await cache.acquire({
      format: "zip",
      url: bundleUrl,
      sha256: sha(zip),
      entry: "index.html",
    });
    expect(lease.cacheHit).toBe(false);
    expect(sharedFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
    const content = await cache.read(lease.leaseId, "index.html");
    expect(content.toString()).toContain("hero");
    await cache.release(lease.leaseId);
  });

  it("共享通道返回字节 sha256 不符 → 回退直连 download()", async () => {
    const sharedFetch = vi.fn(async () => Buffer.alloc(64, 9));
    const directFetch = vi.fn(async () => new Response(new Uint8Array(zip), { status: 200 }));
    const cache = await makeCache(sharedFetch, directFetch as typeof fetch);
    const lease = await cache.acquire({
      format: "zip",
      url: bundleUrl,
      sha256: sha(zip),
      entry: "index.html",
    });
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect((await cache.read(lease.leaseId, "index.html")).toString()).toContain("hero");
    await cache.release(lease.leaseId);
  });

  it("共享通道抛错（管理器不可用）→ 回退直连 download()，不瘫", async () => {
    const sharedFetch = vi.fn(async () => {
      throw new Error("bridge_disconnected");
    });
    const directFetch = vi.fn(async () => new Response(new Uint8Array(zip), { status: 200 }));
    const cache = await makeCache(sharedFetch, directFetch as typeof fetch);
    const lease = await cache.acquire({
      format: "zip",
      url: bundleUrl,
      sha256: sha(zip),
      entry: "index.html",
    });
    expect(directFetch).toHaveBeenCalledTimes(1);
    await cache.release(lease.leaseId);
  });

  it("无 sharedFetch 注入（官方/控制台 Host）→ 行为与现状一致，仅直连", async () => {
    const directFetch = vi.fn(async () => new Response(new Uint8Array(zip), { status: 200 }));
    const cache = await makeCache(undefined, directFetch as typeof fetch);
    const lease = await cache.acquire({
      format: "zip",
      url: bundleUrl,
      sha256: sha(zip),
      entry: "index.html",
    });
    expect(directFetch).toHaveBeenCalledTimes(1);
    await cache.release(lease.leaseId);
  });
});

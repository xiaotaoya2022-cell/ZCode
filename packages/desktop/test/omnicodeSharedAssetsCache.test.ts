// [OmniCode] 批次4 单点下沉：管理器共享资产缓存单测（sharedAssetsCache 纯函数 + 真实
// 临时目录磁盘行为）。spec: docs/omnicode/omnicode-shared-services.md §G3.4。
// 写法参照 omnicodeBatch6BackgroundFrame.test.ts（纯函数）与 e2eAtomicJsonFile.test.ts
//（临时目录磁盘 IO）。
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOmnicodeAssetInflightDedup,
  omnicodeSharedAssetRequestSchema,
  resolveOmnicodeAssetsCacheEviction,
  type OmnicodeSharedAssetRequest,
} from "@zcode/shared";
import {
  createOmnicodeSharedAssetsCache,
  resolveOmnicodeAssetsCacheRoot,
  sniffOmnicodeSharedAssetMime,
} from "../src/main/omnicode/sharedAssetsCache.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnicode-assets-cache-"));
  tempRoots.push(root);
  return root;
}

function pngRequest(src = "https://cdn.example.com/hero.png"): {
  request: OmnicodeSharedAssetRequest;
  bytes: Buffer;
} {
  const bytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.alloc(64, 7),
  ]);
  return { request: { src, sha256: sha(bytes), kind: "image" }, bytes };
}

describe("omnicodeSharedAssetRequestSchema（缓存键/授权形态门）", () => {
  it("合法 https 直链 + 64 位 hex sha256 + kind 白名单通过", () => {
    const { request } = pngRequest();
    expect(omnicodeSharedAssetRequestSchema.safeParse(request).success).toBe(true);
  });

  it("http/loopback/带凭据 URL 一律拒绝（管理器内核 https-only，dev 资产回退直连）", () => {
    const { request } = pngRequest("http://cdn.example.com/hero.png");
    expect(omnicodeSharedAssetRequestSchema.safeParse(request).success).toBe(false);
    expect(
      omnicodeSharedAssetRequestSchema.safeParse({ ...pngRequest().request, src: "http://127.0.0.1:8080/a.png" })
        .success,
    ).toBe(false);
    expect(
      omnicodeSharedAssetRequestSchema.safeParse({
        ...pngRequest().request,
        src: "https://user:pass@cdn.example.com/a.png",
      }).success,
    ).toBe(false);
  });

  it("sha256 非 64 位 hex / kind 白名单外 / strict 多余键拒绝", () => {
    const { request } = pngRequest();
    expect(
      omnicodeSharedAssetRequestSchema.safeParse({ ...request, sha256: "deadbeef" }).success,
    ).toBe(false);
    expect(
      omnicodeSharedAssetRequestSchema.safeParse({ ...request, kind: "font" }).success,
    ).toBe(false);
    expect(
      omnicodeSharedAssetRequestSchema.safeParse({ ...request, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("resolveOmnicodeAssetsCacheEviction（容量上限 LRU 淘汰决策）", () => {
  it("总量在容量内 → 不淘汰", () => {
    expect(
      resolveOmnicodeAssetsCacheEviction(
        [
          { name: "a", sizeBytes: 10, mtimeMs: 3 },
          { name: "b", sizeBytes: 10, mtimeMs: 4 },
        ],
        100,
      ),
    ).toEqual([]);
  });

  it("超容量 → 从最旧 mtime 开始淘汰直到总量 ≤ 容量", () => {
    expect(
      resolveOmnicodeAssetsCacheEviction(
        [
          { name: "old", sizeBytes: 60, mtimeMs: 1 },
          { name: "mid", sizeBytes: 60, mtimeMs: 2 },
          { name: "new", sizeBytes: 10, mtimeMs: 3 },
        ],
        100,
      ),
    ).toEqual(["old"]);
    expect(
      resolveOmnicodeAssetsCacheEviction(
        [
          { name: "old", sizeBytes: 60, mtimeMs: 1 },
          { name: "mid", sizeBytes: 60, mtimeMs: 2 },
          { name: "new", sizeBytes: 10, mtimeMs: 3 },
        ],
        10,
      ),
    ).toEqual(["old", "mid"]);
  });

  it("单文件超出容量 → 连最新也淘汰（调用方兜底，不阻塞发布）", () => {
    expect(
      resolveOmnicodeAssetsCacheEviction([{ name: "huge", sizeBytes: 500, mtimeMs: 9 }], 100),
    ).toEqual(["huge"]);
  });
});

describe("createOmnicodeAssetInflightDedup（同键并发去重）", () => {
  it("同 key 并发调用共享同一次执行", async () => {
    const dedup = createOmnicodeAssetInflightDedup();
    let runs = 0;
    const execute = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "value";
    };
    const [a, b, c] = await Promise.all([
      dedup.run("k", execute),
      dedup.run("k", execute),
      dedup.run("k", execute),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe("value");
    expect(b).toBe(a);
    expect(c).toBe(a);
    // settled 后释放 key：下次调用重新执行（磁盘事实兜底）。
    await dedup.run("k", execute);
    expect(runs).toBe(2);
  });

  it("失败不毒化后续调用（finally 释放）", async () => {
    const dedup = createOmnicodeAssetInflightDedup();
    await expect(dedup.run("k", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(dedup.run("k", async () => "ok")).resolves.toBe("ok");
  });

  it("不同 key 并行执行，互不合并", async () => {
    const dedup = createOmnicodeAssetInflightDedup();
    const runs: string[] = [];
    await Promise.all([
      dedup.run("a", async () => void runs.push("a")),
      dedup.run("b", async () => void runs.push("b")),
    ]);
    expect(runs.sort()).toEqual(["a", "b"]);
  });
});

describe("sniffOmnicodeSharedAssetMime（magic 嗅探）", () => {
  it("png/jpeg/webp/mp4/zip 分别映射；非媒体字节抛错", () => {
    expect(sniffOmnicodeSharedAssetMime(pngRequest().bytes, "image")).toBe("image/png");
    expect(
      sniffOmnicodeSharedAssetMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]), "image"),
    ).toBe("image/jpeg");
    expect(
      sniffOmnicodeSharedAssetMime(
        Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
        "image",
      ),
    ).toBe("image/webp");
    expect(
      sniffOmnicodeSharedAssetMime(Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp")]), "video"),
    ).toBe("video/mp4");
    expect(sniffOmnicodeSharedAssetMime(Buffer.from("504b0304", "hex"), "bundle")).toBe(
      "application/zip",
    );
    expect(() => sniffOmnicodeSharedAssetMime(Buffer.alloc(32, 1), "image")).toThrow("asset_type");
    // png 字节按 bundle 校验必须拒绝（kind 与内容不匹配）。
    expect(() => sniffOmnicodeSharedAssetMime(pngRequest().bytes, "bundle")).toThrow("asset_type");
  });
});

describe("createOmnicodeSharedAssetsCache（磁盘缓存行为，真实临时目录）", () => {
  it("未命中 → 单点下载 + sha256/magic 校验 + 原子发布；再请求命中磁盘（fetch 只调 1 次）", async () => {
    const root = await makeTempRoot();
    const { request, bytes } = pngRequest();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 }));
    const cache = createOmnicodeSharedAssetsCache({ cacheRoot: root, fetch: fetchImpl as typeof fetch });
    const first = await cache.resolve(request);
    expect(first).toMatchObject({ ok: true, dataBase64: bytes.toString("base64") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, request.sha256))).toEqual(bytes);
    const second = await cache.resolve(request);
    expect(second).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("并发同 sha256 请求 → 一次下载（in-flight 去重）", async () => {
    const root = await makeTempRoot();
    const { request, bytes } = pngRequest();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 }));
    const cache = createOmnicodeSharedAssetsCache({ cacheRoot: root, fetch: fetchImpl as typeof fetch });
    const results = await Promise.all([cache.resolve(request), cache.resolve(request)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("下载字节 sha256 不符 → 结构化失败 asset_integrity，不落缓存", async () => {
    const root = await makeTempRoot();
    const { request } = pngRequest();
    const fetchImpl = vi.fn(
      async () => new Response(new Uint8Array(Buffer.alloc(32, 3)), { status: 200 }),
    );
    const cache = createOmnicodeSharedAssetsCache({ cacheRoot: root, fetch: fetchImpl as typeof fetch });
    expect(await cache.resolve(request)).toMatchObject({ ok: false, error: "asset_integrity" });
    expect((await readdir(root)).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
  });

  it("请求形态不合法（http URL）→ 结构化失败 asset_request，不发起下载", async () => {
    const root = await makeTempRoot();
    const fetchImpl = vi.fn();
    const cache = createOmnicodeSharedAssetsCache({ cacheRoot: root, fetch: fetchImpl as typeof fetch });
    expect(
      await cache.resolve({ src: "http://cdn.example.com/a.png", sha256: "a".repeat(64), kind: "image" }),
    ).toMatchObject({ ok: false, error: "asset_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("缓存文件被篡改 → 视为未命中，重新下载重建", async () => {
    const root = await makeTempRoot();
    const { request, bytes } = pngRequest();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 }));
    const cache = createOmnicodeSharedAssetsCache({ cacheRoot: root, fetch: fetchImpl as typeof fetch });
    await cache.resolve(request);
    await writeFile(join(root, request.sha256), Buffer.alloc(32, 4));
    const again = await cache.resolve(request);
    expect(again).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("容量上限：发布后 LRU 淘汰旧内容；在途键不参与淘汰", async () => {
    const root = await makeTempRoot();
    const first = pngRequest("https://cdn.example.com/first.png");
    const second = pngRequest("https://cdn.example.com/second.png");
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const isSecond = String(input).includes("second.png");
      const bytes = isSecond ? second.bytes : first.bytes;
      return new Response(new Uint8Array(bytes), { status: 200 });
    });
    const cache = createOmnicodeSharedAssetsCache({
      cacheRoot: root,
      fetch: fetchImpl as typeof fetch,
      // 两份资产 ≈ 各 72 字节；容量只装得下一份。
      maxTotalBytes: first.bytes.byteLength + second.bytes.byteLength - 1,
    });
    await cache.resolve(first.request);
    // 人为把 first 的 mtime 调旧，保证 LRU 判定确定性。
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, first.request.sha256), old, old);
    await cache.resolve(second.request);
    const names = (await readdir(root)).filter((name) => /^[a-f0-9]{64}$/.test(name));
    expect(names).toEqual([second.request.sha256]);
  });
});

describe("resolveOmnicodeAssetsCacheRoot（管理器数据根）", () => {
  it("缺省 ~/.omnicode/assets-cache；env 覆盖生效（dev/test 用）", () => {
    expect(resolveOmnicodeAssetsCacheRoot({})).toContain(join(".omnicode", "assets-cache"));
    expect(
      resolveOmnicodeAssetsCacheRoot({ OMNICODE_ASSETS_CACHE_ROOT: "F:/tmp/omni-assets" }).replace(
        /\\/gu,
        "/",
      ),
    ).toBe("F:/tmp/omni-assets");
  });
});

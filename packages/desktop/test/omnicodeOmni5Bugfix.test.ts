// [OmniCode] omni.5 真机验收修复单测（F1-F2）：console 根 os→env 一次性迁移原语
//（reWrapOsCredentialValuesWithEnvKey 纯函数 + runConsoleRootOsCredentialMigration
// 守卫路径）与迁移标记读写（readConsoleRootOsMigrationMarker）；loginHealth unknown
// 细分口径（bug2：logged-out vs unreadable）。写法参照 omnicodeBatch25Extras.test.ts。
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSystemCredentialCipher,
  reWrapOsCredentialValuesWithEnvKey,
} from "@zcode/shared/credential-security";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../src/main/omnicode/profileRuntime.js", () => ({
  listOmnicodeProfiles: async () => [],
  getOmnicodeProfileRecord: async () => undefined,
  getOmnicodeProfileDir: (id: string) => `/virtual/omnicode/${id}`,
  getOmnicodeConsoleDataBaseDir: () => "/virtual/omnicode-console-data",
}));

import { readOmnicodeLoginHealthFromDataRoot } from "../src/main/omnicode/loginHealth.js";
import {
  OMNICODE_MIGRATION_MARKER_FILE,
  readConsoleRootOsMigrationMarker,
  runConsoleRootOsCredentialMigration,
} from "../src/main/omnicode/consoleCredentialOsMigration.js";

const SECRET = "omni5-fix-secret-0123456789abcdef-0123456789";
const DAY_MS = 24 * 60 * 60 * 1000;

/** 以固化 env 密钥生成 enc:v2:env: 密文（loginHealth/accountData 同款 env 注入 cipher）。 */
async function encryptEnvAsync(filePath: string, plain: string): Promise<string> {
  const cipher = createSystemCredentialCipher({
    filePath,
    env: { ZCODE_CREDENTIAL_SECRET: SECRET },
  });
  return cipher.encrypt(plain);
}

describe("omni.5 F2-5: reWrapOsCredentialValuesWithEnvKey (pure)", () => {
  const envKey = createHash("sha256").update(SECRET).digest();
  // os: 测试密钥：32 字节原始密钥的 base64url 编码（与 keyring 存储形态一致）。
  const osKeyRaw = createHash("sha256").update("os-side-key").digest();
  const osKeyEncoded = osKeyRaw.toString("base64url");
  const osKeyFingerprint = createHash("sha256").update(osKeyRaw).digest("hex").slice(0, 24);
  const envKeyFingerprint = createHash("sha256").update(envKey).digest("hex").slice(0, 24);

  /** 用 os: 原始密钥手工构造 enc:v2:os: 密文（aes-256-gcm，iv.tag.ciphertext base64url）。 */
  function sealOs(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", osKeyRaw, iv);
    const bytes = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((part) => part.toString("base64url"))
      .join(".");
  }

  it("全部 os: 值以 keyring 原始密钥解开 → 重加密为 env:（env cipher 可解回明文）", async () => {
    const record = {
      "oauth:zai:expires_at": `enc:v2:os:${osKeyFingerprint}:${sealOs(String(1_700_000_000_000))}`,
      "oauth:active_provider": `enc:v2:os:${osKeyFingerprint}:${sealOs("zai")}`,
    };
    const migrated = reWrapOsCredentialValuesWithEnvKey(record, osKeyEncoded, envKey);
    expect(migrated).not.toBeNull();
    expect(migrated?.["oauth:active_provider"]).toMatch(
      new RegExp(`^enc:v2:env:${envKeyFingerprint}:`),
    );
    // 迁移后的 env: 值必须能被固化 env 密钥的 cipher 解回明文（与 host 同读法）。
    const cipher = createSystemCredentialCipher({
      filePath: "/virtual/credentials.json",
      env: { ZCODE_CREDENTIAL_SECRET: SECRET },
    });
    await expect(cipher.decrypt(migrated!["oauth:active_provider"]!)).resolves.toBe("zai");
    await expect(cipher.decrypt(migrated!["oauth:zai:expires_at"]!)).resolves.toBe(
      String(1_700_000_000_000),
    );
  });

  it("任一 os: 值解不开 → 整体失败（null，绝不产出半迁移）", () => {
    const record = {
      "oauth:zai:expires_at": `enc:v2:os:${osKeyFingerprint}:${sealOs("123")}`,
      "zcodejwttoken": `enc:v2:os:${osKeyFingerprint}:garbage-payload`,
    };
    expect(reWrapOsCredentialValuesWithEnvKey(record, osKeyEncoded, envKey)).toBeNull();
    // os: 值不存在 → null（无可迁移项）。
    expect(
      reWrapOsCredentialValuesWithEnvKey({ a: "enc:v2:env:abc:def" }, osKeyEncoded, envKey),
    ).toBeNull();
    // keyring 编码密钥格式非法 → null。
    expect(
      reWrapOsCredentialValuesWithEnvKey(
        { a: `enc:v2:os:${osKeyFingerprint}:${sealOs("123")}` },
        "not-base64url!!",
        envKey,
      ),
    ).toBeNull();
  });
});

describe("omni.5 F2-5: runConsoleRootOsCredentialMigration 守卫路径 + 标记读写", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omni5-os-migration-"));
    await mkdir(join(root, ".zcode", "v2"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("无 credentials.json / 无 os: 值 → not-applicable（不触 keyring、不改文件）", async () => {
    await expect(runConsoleRootOsCredentialMigration(root, SECRET)).resolves.toEqual({
      status: "not-applicable",
    });
    const credentialsPath = join(root, ".zcode", "v2", "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ a: "enc:v2:env:x:y" }), "utf8");
    await expect(runConsoleRootOsCredentialMigration(root, SECRET)).resolves.toEqual({
      status: "not-applicable",
    });
    await expect(readFile(credentialsPath, "utf8")).resolves.toContain("enc:v2:env:x:y");
  });

  it("os: 值存在但 env 密钥缺失 → unrecoverable（备份+标记，原文件保持原样）", async () => {
    const credentialsPath = join(root, ".zcode", "v2", "credentials.json");
    const raw = JSON.stringify({
      "oauth:zai:expires_at": "enc:v2:os:aaaaaaaaaaaaaaaaaaaaaaaa:AAAA",
    });
    await writeFile(credentialsPath, raw, "utf8");
    const outcome = await runConsoleRootOsCredentialMigration(root, "");
    expect(outcome.status).toBe("unrecoverable");
    expect(outcome.backupPath).toBeTruthy();
    // 备份文件存在且内容与原文件一致（解密失败先备份，绝不静默清空）。
    await expect(readFile(outcome.backupPath!, "utf8")).resolves.toBe(raw);
    // live 文件原样保留（os: 值不清空）。
    await expect(readFile(credentialsPath, "utf8")).resolves.toBe(raw);
    // 管理器 UI 可读标记已落盘（重登引导数据源）。
    await expect(readConsoleRootOsMigrationMarker(root)).resolves.toMatchObject({
      status: "unrecoverable",
      backedUp: true,
    });
  });

  it("标记缺失/损坏 → 无标记（null），UI 不渲染引导", async () => {
    await expect(readConsoleRootOsMigrationMarker(root)).resolves.toBeNull();
    await writeFile(
      join(root, ".zcode", "v2", OMNICODE_MIGRATION_MARKER_FILE),
      "{corrupt",
      "utf8",
    );
    await expect(readConsoleRootOsMigrationMarker(root)).resolves.toBeNull();
  });
});

describe("omni.5 F2-6(bug2): loginHealth unknown 细分", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omni5-login-health-"));
    await mkdir(join(root, ".zcode", "v2"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeCredentials(values: Record<string, string>): Promise<string> {
    const credentialsPath = join(root, ".zcode", "v2", "credentials.json");
    await writeFile(credentialsPath, JSON.stringify(values), "utf8");
    return credentialsPath;
  }

  it("凭据文件缺失 → logged-out；有 oauth 值但无密钥文件 → unreadable（非未登录）", async () => {
    await expect(readOmnicodeLoginHealthFromDataRoot(join(root, "nope"))).resolves.toEqual({
      status: "unknown",
      unknownReason: "logged-out",
    });
    // 模拟收养根：env: 密文（source 标记改写为 os:，与真机收养根同形态）+ 密钥文件缺失。
    const ciphertext = (
      await encryptEnvAsync(join(root, "anchor.json"), String(1_700_000_000_000))
    ).replace("enc:v2:env:", "enc:v2:os:");
    await writeCredentials({ "oauth:zai:expires_at": ciphertext });
    await expect(readOmnicodeLoginHealthFromDataRoot(root)).resolves.toEqual({
      status: "unknown",
      unknownReason: "unreadable",
    });
  });

  it("空快照（无任何 oauth 值）→ logged-out；source 不匹配密文（收养根）→ unreadable", async () => {
    await writeCredentials({});
    await expect(readOmnicodeLoginHealthFromDataRoot(root)).resolves.toEqual({
      status: "unknown",
      unknownReason: "logged-out",
    });
    await writeFile(join(root, ".zcode", "v2", "credential-secret"), SECRET, "utf8");
    const NOW = Date.now();
    const ciphertext = (
      await encryptEnvAsync(join(root, "anchor.json"), String(NOW + 30 * DAY_MS))
    ).replace("enc:v2:env:", "enc:v2:os:");
    await writeCredentials({ "oauth:zai:expires_at": ciphertext });
    await expect(readOmnicodeLoginHealthFromDataRoot(root, NOW)).resolves.toEqual({
      status: "unknown",
      unknownReason: "unreadable",
    });
  });
});

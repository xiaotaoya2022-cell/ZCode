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
import { backupCorruptFile } from "@zcode/shared/node";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("../src/main/omnicode/profileRuntime.js", () => ({
  listOmnicodeProfiles: async () => [],
  getOmnicodeProfileRecord: async () => undefined,
  getOmnicodeProfileDir: (id: string) => `/virtual/omnicode/${id}`,
  getOmnicodeConsoleDataBaseDir: () => "/virtual/omnicode-console-data",
}));
// 终审 P2-2：测试环境无系统 keyring——迁移成功路径用注入式假探测（默认 null=条目缺失，
// 成功用例再 mockResolvedValue 为可用 key）。其余导出保持真实实现。
vi.mock("@zcode/shared/credential-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/shared/credential-security")>();
  return {
    ...actual,
    readSystemCredentialKeyringEntry: vi.fn(async () => null),
  };
});
// 终审 P2-1：备份失败分支的可注入断言面（默认走真实实现，备份失败用例一次性拒绝）。
vi.mock("@zcode/shared/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/shared/node")>();
  return {
    ...actual,
    backupCorruptFile: vi.fn(actual.backupCorruptFile),
  };
});

import { readOmnicodeLoginHealthFromDataRoot } from "../src/main/omnicode/loginHealth.js";
import {
  OMNICODE_MIGRATION_MARKER_FILE,
  readConsoleRootOsMigrationMarker,
  runConsoleRootOsCredentialMigration,
} from "../src/main/omnicode/consoleCredentialOsMigration.js";
import { readSystemCredentialKeyringEntry } from "@zcode/shared/credential-security";

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

// ── 终审 P2-2：迁移成功路径编排（注入式 keyring 探测，全链断言）─────────────────
// 此前仅有 reWrap 纯函数双向断言与 unrecoverable 守卫路径；keyring 可达 → reWrap →
// rm 钉扎 → 原子写回的成功编排此前只靠实现阅读。本组用注入式假探测锁住完整编排。
describe("omni.5 终审: 迁移成功路径编排（假 keyring 探测注入）", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omni5-os-migration-success-"));
    await mkdir(join(root, ".zcode", "v2"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // env 密文指纹 = sha256(env 密钥字节)，密钥字节 = sha256(固化 secret)（与 reWrap 同构造）。
  const envKeyFingerprint = createHash("sha256")
    .update(createHash("sha256").update(SECRET).digest())
    .digest("hex")
    .slice(0, 24);
  const osKeyRaw = createHash("sha256").update("omni5-integration-os-key").digest();
  const osKeyEncoded = osKeyRaw.toString("base64url");
  const osKeyFingerprint = createHash("sha256").update(osKeyRaw).digest("hex").slice(0, 24);

  /** 用 os: 原始密钥手工构造 enc:v2:os: 密文（aes-256-gcm，iv.tag.ciphertext base64url）。 */
  function sealOs(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", osKeyRaw, iv);
    const bytes = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((part) => part.toString("base64url"))
      .join(".");
  }

  /** 布置迁移前置状态：两个 os: 值 + credential-source 钉扎 + 旧 marker。 */
  async function setupMigrationInput(): Promise<{ credentialsPath: string; raw: string }> {
    const credentialsPath = join(root, ".zcode", "v2", "credentials.json");
    const raw = JSON.stringify({
      "oauth:zai:expires_at": `enc:v2:os:${osKeyFingerprint}:${sealOs(String(1_700_000_000_000))}`,
      "oauth:active_provider": `enc:v2:os:${osKeyFingerprint}:${sealOs("zai")}`,
    });
    await writeFile(credentialsPath, raw, "utf8");
    // 钉扎标记（成功迁移后必须移除）与旧 marker（成功迁移后必须清除）。
    await writeFile(join(root, ".zcode", "v2", "credential-source"), "os", "utf8");
    await writeFile(join(root, ".zcode", "v2", OMNICODE_MIGRATION_MARKER_FILE), "{}", "utf8");
    return { credentialsPath, raw };
  }

  it("keyring 可达 → reWrap → 原子写回 env: → 备份存在 → 钉扎/marker 清除（全链）", async () => {
    const { credentialsPath, raw } = await setupMigrationInput();
    vi.mocked(readSystemCredentialKeyringEntry).mockResolvedValue(osKeyEncoded);

    const outcome = await runConsoleRootOsCredentialMigration(root, SECRET);
    expect(outcome.status).toBe("migrated");
    expect(outcome.migratedCount).toBe(2);
    // 备份先行：内容寻址备份存在且内容与原文件一致（原 os: 密文证据不丢）。
    expect(outcome.backupPath).toBeTruthy();
    await expect(readFile(outcome.backupPath!, "utf8")).resolves.toBe(raw);

    // live 文件已重写为 env: 密文（不再是 os:），且能被固化 env 密钥解回明文（全链可解）。
    const migratedRaw = await readFile(credentialsPath, "utf8");
    expect(migratedRaw).not.toContain("enc:v2:os:");
    expect(migratedRaw).toContain("enc:v2:env:");
    const migrated = JSON.parse(migratedRaw) as Record<string, string>;
    const cipher = createSystemCredentialCipher({
      filePath: "/virtual/omni5-migrated.json",
      env: { ZCODE_CREDENTIAL_SECRET: SECRET },
    });
    await expect(cipher.decrypt(migrated["oauth:active_provider"]!)).resolves.toBe("zai");
    await expect(cipher.decrypt(migrated["oauth:zai:expires_at"]!)).resolves.toBe(
      String(1_700_000_000_000),
    );
    // 密文指纹为 env 密钥指纹（host 后续用 managed secret 短路读取，不再触 keyring）。
    expect(migrated["oauth:active_provider"]).toMatch(new RegExp(`^enc:v2:env:${envKeyFingerprint}:`));

    // 编排收尾：钉扎解除 + marker 清除（成功路径不给 UI 留重登引导）。
    await expect(
      readFile(join(root, ".zcode", "v2", "credential-source"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readConsoleRootOsMigrationMarker(root)).resolves.toBeNull();
  });

  it("备份失败 → unrecoverable(backup-failed) + 补写 marker，live 文件保持 os: 原样（终审 P2-1）", async () => {
    const { credentialsPath, raw } = await setupMigrationInput();
    vi.mocked(readSystemCredentialKeyringEntry).mockResolvedValue(osKeyEncoded);
    // 证据备份与 markUnrecoverable 的兜底重试各拒绝一次（备份持续失败 → 无证据路径）。
    vi.mocked(backupCorruptFile)
      .mockRejectedValueOnce(new Error("backup disk full"))
      .mockRejectedValueOnce(new Error("backup disk full"));

    const outcome = await runConsoleRootOsCredentialMigration(root, SECRET);
    // 解密其实已成功：reason 不得误标 decrypt-failed（终审 P2-1 修复点）。
    expect(outcome).toEqual({ status: "unrecoverable", reason: "backup-failed" });
    // live 文件未动（os: 值留存待重登），UI 有重登引导（marker 已补写、无备份证据）。
    await expect(readFile(credentialsPath, "utf8")).resolves.toBe(raw);
    await expect(readConsoleRootOsMigrationMarker(root)).resolves.toMatchObject({
      status: "unrecoverable",
      reason: "backup-failed",
      backedUp: false,
    });
  });

  it("keyring 探测不可达（抛错）→ unrecoverable(keyring-unavailable)，备份+标记，live 原样", async () => {
    const { credentialsPath, raw } = await setupMigrationInput();
    vi.mocked(readSystemCredentialKeyringEntry).mockRejectedValue(new Error("dbus down"));

    const outcome = await runConsoleRootOsCredentialMigration(root, SECRET);
    expect(outcome.status).toBe("unrecoverable");
    expect(outcome.reason).toBe("keyring-unavailable");
    expect(outcome.backupPath).toBeTruthy();
    await expect(readFile(outcome.backupPath!, "utf8")).resolves.toBe(raw);
    await expect(readFile(credentialsPath, "utf8")).resolves.toBe(raw);
    await expect(readConsoleRootOsMigrationMarker(root)).resolves.toMatchObject({
      status: "unrecoverable",
      backedUp: true,
    });
  });
});

// [OmniCode] 模式二（单实例多账号并发会话）单测（spec:
// docs/omnicode/multi-account-sessions.md §4/§5）：
// - 本地文件材料提供者：write→load 往返、ENOENT/损坏 JSON/schema 不符/accountId 串号
//   全部 fail-closed null、TTL 缓存（读次数计数）；
// - resolver 覆盖边界：作用域未激活/未绑定 → 官方 fallback 原样；激活+材料 → 附加账号
//   材料、fallback 不触；family 不匹配/材料缺失 → null 与空视图（fail-closed 防串号）；
//   门控关闭（isActive=false）→ 恒官方路径（官方 flavor 零改动铁律）。
// 注：全部凭据形字段为测试夹具合成值（syntheticFixture 拼接生成，非真实凭据形态）。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import type { ProviderFamilyDomain } from "@zcode/shared";
import {
  createOmnicodeAccountOverride,
  runWithOmnicodeAccountScope,
  getOmnicodeAccountScopeAccountId,
  type OmnicodeAccountOverrideMaterial,
} from "../src/omnicode/accountOverride.js";
import {
  createOmnicodeAccountFileMaterialProvider,
  writeOmnicodeAccountMaterialFile,
} from "../src/omnicode/accountMaterialFile.js";

const TEST_ENV = { ZCODE_CREDENTIAL_SECRET: "omnicode-account-override-test-secret" };
const testCipher = (filePath: string) =>
  createSystemCredentialCipher({ filePath, env: TEST_ENV });

/** 测试夹具专用：合成"明显非真实凭据"的字符串值（拼接生成，规避真实凭据形态）。 */
const syntheticFixture = (part: string) => `omnicode-test-fixture:${part}`;

function materialFixture(overrides: Partial<OmnicodeAccountOverrideMaterial> = {}): OmnicodeAccountOverrideMaterial {
  return {
    accountId: "omni-acct-alpha",
    family: "zai",
    selections: { zai: { kind: "start-plan" } },
    accountIdentity: syntheticFixture("identity-alpha"),
    startPlanMaterial: {
      family: "zai",
      loginProvider: "zai",
      zcodeUserId: syntheticFixture("user-alpha"),
      sessionRevision: null,
      accountIdentity: syntheticFixture("identity-alpha"),
      zcodeJwtToken: syntheticFixture("start-plan-jwt"),
    },
    familyMaterial: null,
    deviceMid: syntheticFixture("device-mid"),
    ...overrides,
  };
}

describe("模式二：附加账号材料本地文件提供者", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omnicode-accounts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeProvider(now?: () => number, readFile?: typeof import("node:fs/promises").readFile) {
    return createOmnicodeAccountFileMaterialProvider({
      accountsDir: dir,
      createCipher: testCipher,
      ...(now ? { now } : {}),
      ...(readFile ? { readFile } : {}),
    });
  }

  it("write→load 往返：材料快照逐字段还原", async () => {
    const fixture = materialFixture();
    await writeOmnicodeAccountMaterialFile(fixture, { accountsDir: dir, createCipher: testCipher });
    const loaded = await makeProvider().load(fixture.accountId);
    expect(loaded).toEqual(fixture);
  });

  it("文件缺失/损坏 JSON/schema 不符/accountId 串号 → 全部 fail-closed null", async () => {
    const provider = makeProvider();
    expect(await provider.load("omni-acct-missing")).toBeNull();

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "omni-acct-corrupt.json"), "{not-json", "utf8");
    expect(await provider.load("omni-acct-corrupt")).toBeNull();

    await writeFile(join(dir, "omni-acct-badschema.json"), JSON.stringify({ unrelated: true }), "utf8");
    expect(await provider.load("omni-acct-badschema")).toBeNull();

    // accountId 与文件名不一致（内容声称 B 文件名 A）→ 拒绝
    const swapped = materialFixture({ accountId: "omni-acct-real" });
    await writeOmnicodeAccountMaterialFile(swapped, { accountsDir: dir, createCipher: testCipher });
    expect(await provider.load("omni-acct-claiming-other")).toBeNull();
    expect(await provider.load("omni-acct-real")).toEqual(swapped);
  });

  it("TTL 缓存：窗口内复用不重读文件，过期后重读", async () => {
    let clock = 1_000;
    const now = () => clock;
    let reads = 0;
    const readFileSpy = (async (...args: Parameters<typeof import("node:fs/promises").readFile>) => {
      reads += 1;
      const real = await import("node:fs/promises");
      return real.readFile(...args);
    }) as typeof import("node:fs/promises").readFile;
    const fixture = materialFixture();
    await writeOmnicodeAccountMaterialFile(fixture, { accountsDir: dir, createCipher: testCipher });
    const provider = makeProvider(now, readFileSpy);

    await provider.load(fixture.accountId);
    await provider.load(fixture.accountId);
    expect(reads).toBe(1);

    clock += 61_000;
    await provider.load(fixture.accountId);
    expect(reads).toBe(2);
  });
});

describe("模式二：resolver 覆盖边界", () => {
  const officialFamilyMaterial = {
    family: "zai" as ProviderFamilyDomain,
    loginProvider: "zai",
    zcodeUserId: syntheticFixture("user-main"),
    sessionRevision: null,
    accountIdentity: syntheticFixture("identity-main"),
    accessToken: syntheticFixture("family-access"),
    zcodeJwtToken: syntheticFixture("family-jwt"),
  };
  const officialStartPlanMaterial = {
    family: "zai" as ProviderFamilyDomain,
    loginProvider: "zai",
    zcodeUserId: syntheticFixture("user-main"),
    sessionRevision: null,
    accountIdentity: syntheticFixture("identity-main"),
    zcodeJwtToken: syntheticFixture("start-jwt-main"),
  };
  const officialSettings = {
    providerFamilyDomain: "zai" as ProviderFamilyDomain,
    selections: { zai: { kind: "start-plan" } },
    unresolvedFamilies: [] as string[],
  };

  function makeOverride(options?: {
    isActive?: () => boolean;
    material?: OmnicodeAccountOverrideMaterial | null;
  }) {
    const fallbackLoadFamily = vi.fn(async () => officialFamilyMaterial);
    const fallbackLoadStartPlan = vi.fn(async () => officialStartPlanMaterial);
    const fallbackReadSettings = vi.fn(async () => officialSettings);
    const override = createOmnicodeAccountOverride({
      materialProvider: { load: async () => options?.material ?? null },
      ...(options?.isActive ? { isActive: options.isActive } : {}),
    });
    return { override, fallbackLoadFamily, fallbackLoadStartPlan, fallbackReadSettings };
  }

  it("门控关闭（isActive=false）：即使作用域绑定也恒走官方路径（官方 flavor 零改动）", async () => {
    const { override, fallbackLoadFamily } = makeOverride({ isActive: () => false });
    const result = await runWithOmnicodeAccountScope("omni-acct-alpha", () =>
      override.loadFamilyMaterial("zai", fallbackLoadFamily),
    );
    expect(result).toEqual(officialFamilyMaterial);
    expect(fallbackLoadFamily).toHaveBeenCalledWith("zai");
    expect(override.scopedAccountId()).toBeNull();
  });

  it("门控开但作用域未绑定：官方路径", async () => {
    const { override, fallbackReadSettings } = makeOverride({ isActive: () => true });
    expect(await override.readSettings(fallbackReadSettings)).toEqual(officialSettings);
    expect(fallbackReadSettings).toHaveBeenCalled();
    expect(getOmnicodeAccountScopeAccountId()).toBeNull();
  });

  it("作用域激活+材料在：附加账号材料作答，官方 fallback 不触（runWith 包裹传播）", async () => {
    const fixture = materialFixture();
    const { override, fallbackLoadFamily, fallbackLoadStartPlan, fallbackReadSettings } = makeOverride({
      isActive: () => true,
      material: fixture,
    });
    await runWithOmnicodeAccountScope(fixture.accountId, async () => {
      expect(override.scopedAccountId()).toBe(fixture.accountId);
      expect(await override.loadFamilyMaterial("zai", fallbackLoadFamily)).toBeNull(); // familyMaterial=null
      expect(await override.loadStartPlanMaterial("zai", fallbackLoadStartPlan)).toEqual(
        fixture.startPlanMaterial,
      );
      expect(await override.readSettings(fallbackReadSettings)).toEqual({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "start-plan" } },
        unresolvedFamilies: [],
      });
    });
    expect(fallbackLoadFamily).not.toHaveBeenCalled();
    expect(fallbackLoadStartPlan).not.toHaveBeenCalled();
    expect(fallbackReadSettings).not.toHaveBeenCalled();
  });

  it("family 不匹配/材料缺失 → fail-closed（null/空视图），绝不回落主账号材料", async () => {
    const fixture = materialFixture({ family: "bigmodel" });
    const { override, fallbackLoadFamily, fallbackLoadStartPlan, fallbackReadSettings } = makeOverride({
      isActive: () => true,
      material: fixture,
    });
    await runWithOmnicodeAccountScope(fixture.accountId, async () => {
      expect(await override.loadFamilyMaterial("zai", fallbackLoadFamily)).toBeNull();
      expect(await override.loadStartPlanMaterial("zai", fallbackLoadStartPlan)).toBeNull();
      const settings = await override.readSettings(fallbackReadSettings);
      expect(settings.providerFamilyDomain).toBe("bigmodel");
    });
    expect(fallbackLoadFamily).not.toHaveBeenCalled();
    expect(fallbackLoadStartPlan).not.toHaveBeenCalled();

    const missing = makeOverride({ isActive: () => true, material: null });
    await runWithOmnicodeAccountScope(fixture.accountId, async () => {
      expect(await missing.override.loadFamilyMaterial("zai", missing.fallbackLoadFamily)).toBeNull();
      const settings = await missing.override.readSettings(missing.fallbackReadSettings);
      expect(settings.providerFamilyDomain).toBeNull();
      expect(settings.selections).toEqual({});
    });
    expect(missing.fallbackLoadFamily).not.toHaveBeenCalled();
    expect(missing.fallbackReadSettings).not.toHaveBeenCalled();
  });
});

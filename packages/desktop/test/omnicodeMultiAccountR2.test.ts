// [OmniCode] 模式二 R2 单测：附加账号目录 + 解密代理（desktop 域，spec:
// docs/omnicode/multi-account-sessions.md §5）。仿批次3 注入风格（vi.mock profileRuntime
// + 真 fs/cipher 临时数据根）。覆盖：
// - accountId 派生/反解（纯函数）：acct-<profileId> 派生、白名单校验、非法/null。
// - 材料映射（纯函数）：zai 直连（familyMaterial+startPlan 剥离 accessToken）、zai_cn
//   Start 兜底（family=bigmodel、无 familyMaterial）、bigmodel 直连、bigmodel 有效/无效
//   关联（linkedBigModel userId 绑定校验）、无可用材料 → null。
// - 目录枚举：排除请求方自身 profile、跳过无凭据 profile、displayName 归一、单 profile
//   失败不抛穿。
// - 桥解密代理：ok=true（base64 → shared schema 可解析、内容匹配源 profile）；未知
//   accountId/请求方自身排除/无材料 → 固定结构化错误键；多实例并发幂等（两次独立解密
//   同快照、只读不写盘）；错误路径绝不携带材料内容。
// 注：全部凭据形字段为测试夹具合成值（syntheticFixture 拼接生成，非真实凭据形态）。
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import { omnicodeAccountMaterialFileSchema } from "@zcode/shared";
import {
  deriveOmnicodeBridgeAccountId,
  listOmnicodeBridgeAccounts,
  mapOmnicodeProfileCredentialsToMaterial,
  OMNICODE_BRIDGE_ACCOUNT_ERRORS,
  parseOmnicodeStoredProfileUserId,
  readOmnicodeProfileOAuthCredentials,
  resolveOmnicodeBridgeAccountMaterial,
  resolveOmnicodeBridgeAccountSourceProfileId,
  resolveOmnicodeBridgeAccountFamily,
  type OmnicodeProfileMaterialMapperInput,
} from "../src/main/omnicode/accountDirectory.js";

// ─── mocks：profileRuntime（列表/记录/数据根注入；批次3 accountDetection 同款）──────
const profileState = vi.hoisted(() => ({
  profiles: [] as { id: string; name: string; createdAt: string }[],
  records: {} as Record<string, { dataBaseDirOverride?: string } | undefined>,
  dirs: {} as Record<string, string>,
}));
vi.mock("../src/main/omnicode/profileRuntime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/main/omnicode/profileRuntime.js")>();
  return {
    ...actual,
    listOmnicodeProfiles: async () => profileState.profiles.map((entry) => ({ ...entry })),
    getOmnicodeProfileRecord: async (profileId: string) => profileState.records[profileId],
    getOmnicodeProfileDir: (profileId: string) =>
      profileState.dirs[profileId] ?? actual.getOmnicodeProfileDir(profileId),
  };
});

const SECRET = "omnicode-r2-dir-test-secret-0123456789abcdef";
const syntheticFixture = (part: string) => `omnicode-r2-test-fixture:${part}`;

// ─── 源 profile 数据根夹具（真 fs + 真 cipher，只读写入测试临时目录）────────────────
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omnicode-r2-account-dir-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface FixtureProfileInput {
  profileId: string;
  name?: string;
  provider?: string;
  userId?: string;
  jwt?: string | null;
  accessToken?: string | null;
  sessionRevision?: string | null;
  linkedBigModel?: { userId: string; customerId: string; accessToken: string } | null;
  deviceMid?: string | null;
  selections?: unknown;
}

async function writeProfileFixture(input: FixtureProfileInput): Promise<string> {
  const dataRoot = join(root, input.profileId);
  const v2Dir = join(dataRoot, ".zcode", "v2");
  await mkdir(v2Dir, { recursive: true });
  const credentialsPath = join(v2Dir, "credentials.json");
  const provider = input.provider ?? "zai";
  const encrypted: Record<string, string> = {};
  const cipher = createSystemCredentialCipher({
    filePath: credentialsPath,
    env: { ZCODE_CREDENTIAL_SECRET: SECRET },
  });
  const put = async (key: string, value: unknown): Promise<void> => {
    if (value === undefined) return;
    // 官方落盘口径：纯字符串键（provider/revision/jwt/token）明文即原串；
    // 对象键（user_info/linked_bigmodel）明文为 JSON 字符串。
    encrypted[key] = await cipher.encrypt(
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  await put("oauth:active_provider", provider);
  if (input.sessionRevision !== null) {
    await put("oauth:session_revision", input.sessionRevision ?? syntheticFixture("rev"));
  }
  if (input.jwt !== null) {
    await put("zcodejwttoken", input.jwt ?? syntheticFixture(`jwt-${input.profileId}`));
  }
  if (input.accessToken !== null) {
    await put(`oauth:${provider}:access_token`, input.accessToken ?? syntheticFixture(`access-${input.profileId}`));
  }
  await put(`oauth:${provider}:user_info`, {
    id: input.userId ?? syntheticFixture(`user-${input.profileId}`),
    username: `user-${input.profileId}`,
    displayName: input.name ? `显示-${input.name}` : undefined,
  });
  if (input.linkedBigModel !== null) {
    await put(
      "oauth:linked_bigmodel",
      input.linkedBigModel ?? {
        userId: input.userId ?? syntheticFixture(`user-${input.profileId}`),
        customerId: syntheticFixture(`cid-${input.profileId}`),
        accessToken: syntheticFixture(`linked-access-${input.profileId}`),
      },
    );
  }
  await writeFile(credentialsPath, JSON.stringify(encrypted), "utf8");
  await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
  if (input.deviceMid !== null) {
    await writeFile(
      join(v2Dir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: input.deviceMid ?? "123e4567-e89b-12d3-a456-426614174000" }),
      "utf8",
    );
  }
  if (input.selections !== undefined) {
    await writeFile(
      join(v2Dir, "setting.json"),
      JSON.stringify({ providerFamilyConnectionSelections: input.selections }),
      "utf8",
    );
  }
  return dataRoot;
}

function registerProfile(input: FixtureProfileInput, dataRoot?: string): void {
  profileState.profiles.push({
    id: input.profileId,
    name: input.name ?? input.profileId,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  profileState.dirs[input.profileId] = dataRoot ?? join(root, input.profileId);
  // 档存在（无 override）——解密代理按记录解析数据根（缺档 = 目录外 profile，按 unknown 收口）。
  profileState.records[input.profileId] = {};
}

// ─── 纯函数：accountId 派生/反解 ─────────────────────────────────────────────
describe("omnicode 模式二 R2：accountId 派生/反解（纯函数）", () => {
  it("派生 = acct-<profileId>；反解还原 sourceProfileId", () => {
    expect(deriveOmnicodeBridgeAccountId("pabc12345")).toBe("acct-pabc12345");
    expect(resolveOmnicodeBridgeAccountSourceProfileId("acct-pabc12345")).toBe("pabc12345");
  });

  it("非法形态（无前缀/白名单外 profileId/非字符串）→ null", () => {
    expect(resolveOmnicodeBridgeAccountSourceProfileId("pabc12345")).toBeNull();
    expect(resolveOmnicodeBridgeAccountSourceProfileId("acct-../evil")).toBeNull();
    expect(resolveOmnicodeBridgeAccountSourceProfileId("acct-not-a-profile")).toBeNull();
    expect(resolveOmnicodeBridgeAccountSourceProfileId(undefined as never)).toBeNull();
  });
});

// ─── 纯函数：family 决策 + 主体 id 解析 ─────────────────────────────────────
describe("omnicode 模式二 R2：family 决策 + 主体 id 解析（纯函数）", () => {
  it("zai→zai、bigmodel→bigmodel、zai_cn→bigmodel（Start 家族兜底）", () => {
    expect(resolveOmnicodeBridgeAccountFamily("zai")).toBe("zai");
    expect(resolveOmnicodeBridgeAccountFamily("bigmodel")).toBe("bigmodel");
    expect(resolveOmnicodeBridgeAccountFamily("zai_cn")).toBe("bigmodel");
    expect(resolveOmnicodeBridgeAccountFamily("unknown-provider")).toBeNull();
  });

  it("归一化 OAuthUserProfile 形态 id 直取；ZAI raw data.user 形态 user_id 兜底", () => {
    expect(
      parseOmnicodeStoredProfileUserId(
        JSON.stringify({ id: "u-1", username: "n", displayName: "d" }),
        "bigmodel",
      ),
    ).toBe("u-1");
    expect(
      parseOmnicodeStoredProfileUserId(
        JSON.stringify({ user_id: "z-9", name: "张三", email: "a@b.c" }),
        "zai",
      ),
    ).toBe("z-9");
    expect(parseOmnicodeStoredProfileUserId("{broken", "zai")).toBeNull();
    expect(parseOmnicodeStoredProfileUserId(undefined, "zai")).toBeNull();
  });
});

// ─── 纯函数：材料映射（官方 oauthCredentialRepo 语义移植） ───────────────────
describe("omnicode 模式二 R2：材料映射（纯函数）", () => {
  const baseCredentials = (overrides: Record<string, unknown> = {}) => ({
    loginProvider: "zai",
    sessionRevision: syntheticFixture("rev"),
    zcodeJwtToken: syntheticFixture("jwt"),
    accessToken: syntheticFixture("access"),
    zcodeUserId: syntheticFixture("user"),
    linkedBigModel: null,
    ...overrides,
  });
  const map = (input: Partial<OmnicodeProfileMaterialMapperInput>) =>
    mapOmnicodeProfileCredentialsToMaterial({
      accountId: "acct-pabc12345",
      credentials: baseCredentials(),
      selections: { zai: { kind: "start-plan" } },
      deviceMid: syntheticFixture("mid"),
      ...input,
    });

  it("zai 直连：familyMaterial 全量 + startPlan 剥离 accessToken + selections 透传", () => {
    const material = map({});
    expect(material?.family).toBe("zai");
    expect(material?.familyMaterial?.accessToken).toBe(syntheticFixture("access"));
    expect(material?.familyMaterial?.accountIdentity).toBe(syntheticFixture("user"));
    expect(material?.startPlanMaterial).toEqual({
      family: "zai",
      loginProvider: "zai",
      zcodeUserId: syntheticFixture("user"),
      sessionRevision: syntheticFixture("rev"),
      accountIdentity: syntheticFixture("user"),
      zcodeJwtToken: syntheticFixture("jwt"),
    });
    expect(material?.selections).toEqual({ zai: { kind: "start-plan" } });
  });

  it("zai_cn 登录：family=bigmodel、无关联 → 仅 startPlan（ZCode 主体兜底）", () => {
    const material = map({
      credentials: baseCredentials({ loginProvider: "zai_cn", accessToken: null }),
    });
    expect(material?.family).toBe("bigmodel");
    expect(material?.familyMaterial).toBeNull();
    expect(material?.startPlanMaterial?.loginProvider).toBe("zai_cn");
    expect(material?.startPlanMaterial?.accountIdentity).toBe(syntheticFixture("user"));
    expect(material?.accountIdentity).toBe(syntheticFixture("user"));
  });

  it("bigmodel 有效关联（userId 匹配）：accountIdentity/accessToken 取关联值", () => {
    const material = map({
      credentials: baseCredentials({
        loginProvider: "zai",
        linkedBigModel: {
          userId: syntheticFixture("user"),
          customerId: syntheticFixture("cid"),
          accessToken: syntheticFixture("linked-access"),
        },
      }),
    });
    // family = zai（直连家族优先）；关联只在 bigmodel family 生效——单 family 快照按
    // 直连家族映射（accountIdentity/accessToken 为直连值）。
    expect(material?.family).toBe("zai");
    expect(material?.familyMaterial?.accountIdentity).toBe(syntheticFixture("user"));
  });

  it("bigmodel 登录 + 有效关联：accountIdentity/accessToken 用关联材料", () => {
    const material = map({
      credentials: baseCredentials({
        loginProvider: "bigmodel",
        accessToken: null,
        linkedBigModel: {
          userId: syntheticFixture("user"),
          customerId: syntheticFixture("cid"),
          accessToken: syntheticFixture("linked-access"),
        },
      }),
    });
    expect(material?.family).toBe("bigmodel");
    expect(material?.familyMaterial?.accountIdentity).toBe(syntheticFixture("cid"));
    expect(material?.familyMaterial?.accessToken).toBe(syntheticFixture("linked-access"));
  });

  it("无可用材料（缺 JWT/缺主体/未知 provider）→ null", () => {
    expect(map({ credentials: baseCredentials({ zcodeJwtToken: "" }) })).toBeNull();
    expect(map({ credentials: baseCredentials({ zcodeUserId: null }) })).toBeNull();
    expect(map({ credentials: baseCredentials({ loginProvider: "weird" }) })).toBeNull();
  });

  it("映射结果过 shared 材料快照 schema（与 Host 二次校验同一事实源）", () => {
    const material = map({});
    expect(omnicodeAccountMaterialFileSchema.safeParse(material).success).toBe(true);
  });
});

// ─── 目录枚举 + 桥解密代理（真 fs/cipher + mock profileRuntime）────────────────
describe("omnicode 模式二 R2：目录枚举 listOmnicodeBridgeAccounts", () => {
  it("枚举除请求方外的全部有凭据 profile；displayName 归一；deviceMid 取源 MID", async () => {
    const rootA = await writeProfileFixture({ profileId: "paaaa11111", name: "实例甲" });
    const rootB = await writeProfileFixture({
      profileId: "pbbbb22222",
      name: "实例乙",
      provider: "zai_cn",
    });
    registerProfile({ profileId: "paaaa11111", name: "实例甲" }, rootA);
    registerProfile({ profileId: "pbbbb22222", name: "实例乙", provider: "zai_cn" }, rootB);
    const accounts = await listOmnicodeBridgeAccounts({ excludeProfileId: "paaaa11111" });
    expect(accounts.map((entry) => entry.accountId)).toEqual([
      "acct-pbbbb22222",
    ]);
    const entry = accounts[0];
    expect(entry.sourceProfileId).toBe("pbbbb22222");
    expect(entry.family).toBe("bigmodel");
    expect(entry.displayName).toBe("显示-实例乙");
    expect(entry.deviceMid).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("无凭据/无 JWT/无设备号的 profile 跳过（永不抛穿）", async () => {
    const rootOk = await writeProfileFixture({ profileId: "pcccc33333" });
    const rootNoJwt = await writeProfileFixture({ profileId: "pdddd44444", jwt: null });
    const rootNoMid = await writeProfileFixture({ profileId: "peeee55555", deviceMid: null });
    const rootEmpty = await mkdtemp(join(tmpdir(), "omnicode-r2-empty-"));
    try {
      registerProfile({ profileId: "pcccc33333" }, rootOk);
      registerProfile({ profileId: "pdddd44444", jwt: null }, rootNoJwt);
      registerProfile({ profileId: "peeee55555", deviceMid: null }, rootNoMid);
      profileState.profiles.push({ id: "pffff66666", name: "空目录", createdAt: "2026-01-01T00:00:00.000Z" });
      profileState.dirs["pffff66666"] = rootEmpty;
      profileState.records["pffff66666"] = {};
      const accounts = await listOmnicodeBridgeAccounts();
      expect(accounts.map((entry) => entry.sourceProfileId)).toEqual(["pcccc33333"]);
    } finally {
      await rm(rootEmpty, { recursive: true, force: true });
    }
  });
});

describe("omnicode 模式二 R2：桥解密代理 resolveOmnicodeBridgeAccountMaterial", () => {
  it("ok=true：base64 → shared schema 可解析；材料内容与源 profile 一致", async () => {
    const dataRoot = await writeProfileFixture({
      profileId: "paaaa11111",
      selections: { zai: { kind: "start-plan" } },
    });
    registerProfile({ profileId: "paaaa11111" }, dataRoot);
    const result = await resolveOmnicodeBridgeAccountMaterial({
      accountId: "acct-paaaa11111",
      requesterProfileId: "pbbbb22222",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = omnicodeAccountMaterialFileSchema.parse(
      JSON.parse(Buffer.from(result.dataBase64, "base64").toString("utf8")),
    );
    expect(parsed.accountId).toBe("acct-paaaa11111");
    expect(parsed.family).toBe("zai");
    expect(parsed.selections).toEqual({ zai: { kind: "start-plan" } });
    expect(parsed.startPlanMaterial?.zcodeUserId).toBe(syntheticFixture("user-paaaa11111"));
    expect(parsed.familyMaterial?.accessToken).toBe(syntheticFixture("access-paaaa11111"));
    expect(parsed.deviceMid).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("selections 读不到 → 缺省 {kind:'start-plan'}（该账号自己的 family 上）", async () => {
    const dataRoot = await writeProfileFixture({ profileId: "pcccc33333" });
    // 不写 setting.json。
    registerProfile({ profileId: "pcccc33333" }, dataRoot);
    const result = await resolveOmnicodeBridgeAccountMaterial({ accountId: "acct-pcccc33333" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = omnicodeAccountMaterialFileSchema.parse(
      JSON.parse(Buffer.from(result.dataBase64, "base64").toString("utf8")),
    );
    expect(parsed.selections).toEqual({ zai: { kind: "start-plan" } });
  });

  it("zai_cn 源（无关联）：材料 family=bigmodel、无 familyMaterial、startPlan 兜底", async () => {
    const dataRoot = await writeProfileFixture({
      profileId: "pdddd44444",
      provider: "zai_cn",
      linkedBigModel: null,
    });
    registerProfile({ profileId: "pdddd44444", provider: "zai_cn", linkedBigModel: null }, dataRoot);
    const result = await resolveOmnicodeBridgeAccountMaterial({ accountId: "acct-pdddd44444" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = omnicodeAccountMaterialFileSchema.parse(
      JSON.parse(Buffer.from(result.dataBase64, "base64").toString("utf8")),
    );
    expect(parsed.family).toBe("bigmodel");
    expect(parsed.familyMaterial).toBeNull();
    expect(parsed.startPlanMaterial?.loginProvider).toBe("zai_cn");
  });

  it("未知 accountId / 形态非法 → 固定结构化错误键", async () => {
    const unknown = await resolveOmnicodeBridgeAccountMaterial({ accountId: "acct-pzzzz99999" });
    expect(unknown).toEqual({ ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unknown });
    const malformed = await resolveOmnicodeBridgeAccountMaterial({ accountId: "../evil" });
    expect(malformed).toEqual({ ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unknown });
    const blank = await resolveOmnicodeBridgeAccountMaterial({ accountId: "" });
    expect(blank).toEqual({ ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.request });
  });

  it("请求方自身排除：主账号不通过桥拉取自己的材料（附加账号 = 主账号之外）", async () => {
    const dataRoot = await writeProfileFixture({ profileId: "paaaa11111" });
    registerProfile({ profileId: "paaaa11111" }, dataRoot);
    const result = await resolveOmnicodeBridgeAccountMaterial({
      accountId: "acct-paaaa11111",
      requesterProfileId: "paaaa11111",
    });
    expect(result).toEqual({ ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.selfExcluded });
  });

  it("无凭据 profile → 材料缺失收口（固定错误键，绝不携带材料内容）", async () => {
    const dataRoot = await writeProfileFixture({ profileId: "peeee55555", jwt: null });
    registerProfile({ profileId: "peeee55555", jwt: null }, dataRoot);
    const result = await resolveOmnicodeBridgeAccountMaterial({
      accountId: "acct-peeee55555",
      requesterProfileId: "paaaa11111",
    });
    expect(result).toEqual({ ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unavailable });
  });

  it("多实例并发幂等：两次并发独立解密同快照；只读不写盘（mtime/文件集不变）", async () => {
    const dataRoot = await writeProfileFixture({ profileId: "paaaa11111" });
    registerProfile({ profileId: "paaaa11111" }, dataRoot);
    const credentialsPath = join(dataRoot, ".zcode", "v2", "credentials.json");
    const before = await stat(credentialsPath);
    const [first, second] = await Promise.all([
      resolveOmnicodeBridgeAccountMaterial({
        accountId: "acct-paaaa11111",
        requesterProfileId: "pbbbb22222",
      }),
      resolveOmnicodeBridgeAccountMaterial({
        accountId: "acct-paaaa11111",
        requesterProfileId: "pcccc33333",
      }),
    ]);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    const after = await stat(credentialsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // 数据根无新增文件（材料不落盘红线——桥代理只在内存现取，代理全程只读）。
    const entries = await readdir(join(dataRoot, ".zcode", "v2"));
    expect(entries.sort()).toEqual(["credential-secret", "credentials.json", "telemetry-state.json"]);
  });

  it("源 profile 凭据读取失败（密钥越界/缺失）→ 材料缺失收口", async () => {
    const dataRoot = join(root, "pffff77777");
    const v2Dir = join(dataRoot, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v2Dir, "credential-secret"), "short", "utf8");
    await writeFile(join(v2Dir, "credentials.json"), "{}", "utf8");
    profileState.profiles.push({ id: "pffff77777", name: "坏密钥", createdAt: "2026-01-01T00:00:00.000Z" });
    profileState.dirs["pffff77777"] = dataRoot;
    profileState.records["pffff77777"] = {};
    const snapshot = await readOmnicodeProfileOAuthCredentials(dataRoot);
    expect(snapshot).toBeNull();
    const result = await resolveOmnicodeBridgeAccountMaterial({
      accountId: "acct-pffff77777",
      requesterProfileId: "paaaa11111",
    });
    expect(result).toEqual({ ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unavailable });
  });
});

// [OmniCode] 批次3 单测：登录态看板数据层 + 赛博鸡蛋数据层。
// 覆盖（spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2/§3）：
// - accountData：凭据快照解密扩展（user_info/expires_at/active_provider/zcodejwttoken/
//   telemetry-state.json deviceMid——全部只读、token 绝不出结果）；
// - billingClient：仿真头构造（device-mid 来源隔离/缺设备号跳过）、balance/preview/claim
//   响应解析、1001-1005 失败码映射、传输层失败归"未知"不抛穿；
// - claimPacer：抖动区间/中断(skip)/单张失败继续/进度事件序列；
// - consoleUiState：merge 白名单扩展（autoClaimEnabled/claimHistory FIFO 50）。
// 写法参照 omnicodeBatch25Extras.test.ts（electron/本地模块 mock + 真 fs/cipher）。
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import { DEFAULT_OMNICODE_CONSOLE_UI_STATE } from "../src/main/omnicode/consoleUiState.js";
import {
  appendOmnicodeClaimHistory,
  mergeOmnicodeConsoleUiState,
  normalizeOmnicodeClaimHistory,
} from "../src/main/omnicode/consoleUiState.js";
import {
  parseOmnicodeDeviceMid,
  parseOmnicodeUserInfo,
  readOmnicodeAccountDataFromDataRoot,
  readOmnicodeBillingCredentials,
} from "../src/main/omnicode/accountData.js";
import {
  buildOmnicodeBalanceUrl,
  buildOmnicodeBillingHeaders,
  buildOmnicodeClaimUrl,
  buildOmnicodePreviewUrl,
  buildOmnicodeTouchHeaders,
  buildOmnicodeTouchUrl,
  fetchOmnicodeBillingEnvelope,
  findOmnicodeTouchClaimAction,
  mapOmnicodeBalanceFailureReasonKey,
  mapOmnicodeClaimTransportReasonKey,
  OMNICODE_BALANCE_REASON_HTTP,
  OMNICODE_BALANCE_REASON_INVALID_RESPONSE,
  OMNICODE_BALANCE_REASON_NETWORK,
  OMNICODE_CLAIM_REASON_INVALID_RESPONSE,
  OMNICODE_CLAIM_REASON_NETWORK,
  parseOmnicodeBalanceEnvelope,
  parseOmnicodeClaimEnvelope,
  parseOmnicodePreviewEnvelope,
  parseOmnicodeTouchEnvelope,
  resetOmnicodeTouchRequestStateForTest,
  resolveOmnicodeBillingRequestPolicy,
  resolveOmnicodeTouchRequestLocale,
  resolveOmnicodeClaimFailureReasonKey,
} from "../src/main/omnicode/billingClient.js";
import {
  OMNICODE_CLAIM_JITTER_MAX_MS,
  OMNICODE_CLAIM_JITTER_MIN_MS,
  resolveOmnicodeClaimJitterMs,
  runOmnicodeClaimQueue,
  type OmnicodeClaimPacerEvent,
} from "../src/main/omnicode/claimPacer.js";
import {
  assembleOmnicodeAccountBalanceView,
  fetchOmnicodeAccountBalanceAttempt,
  resetOmnicodeAccountDashboardCacheForTest,
  resolveOmnicodeSnapshotCacheHit,
} from "../src/main/omnicode/accountDashboard.js";
import {
  hasOmnicodeClaimRunInFlight,
  resetOmnicodeClaimRunnerForTest,
  resolveOmnicodeClaimTargets,
  startOmnicodeAccountClaimRun,
  type OmnicodeClaimRunOptions,
} from "../src/main/omnicode/claimRunner.js";

// ─── mocks：profileRuntime（列表/记录/数据根注入；getOmnicodeConsoleDataBaseDir 保留
// 真实 env 语义供 claimHistory 落盘到测试临时目录）───────────────────────────────
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

const SECRET = "test-secret-0123456789abcdef-0123456789abcdef";

// ─── parseOmnicodeUserInfo / parseOmnicodeDeviceMid（纯函数）────────────────────
describe("omnicode batch3: parseOmnicodeUserInfo (pure)", () => {
  it("归一化形态（OAuthUserProfile 落盘）：displayName/avatarUrl 直取", () => {
    expect(
      parseOmnicodeUserInfo({
        id: "u1",
        username: "user1",
        displayName: "显示名",
        avatarUrl: "https://a/img.png",
      }),
    ).toEqual({ displayName: "显示名", avatarUrl: "https://a/img.png" });
  });

  it("ZAI raw data.user 形态：email/name/avatar/customerNumber 归一", () => {
    expect(
      parseOmnicodeUserInfo({
        email: "a@b.c",
        name: "张三",
        avatar: "https://a/av.png",
        customerNumber: "CN123",
      }),
    ).toEqual({
      email: "a@b.c",
      displayName: "张三",
      avatarUrl: "https://a/av.png",
      customerNumber: "CN123",
    });
  });

  it("嵌套 data.user / rawProfile 形态：逐层查找", () => {
    expect(parseOmnicodeUserInfo({ data: { user: { email: "x@y.z", name: "李四" } } })).toEqual({
      email: "x@y.z",
      displayName: "李四",
    });
    expect(parseOmnicodeUserInfo({ rawProfile: { customerNumber: "9" } })).toEqual({
      customerNumber: "9",
    });
  });

  it("垃圾输入（null/数组/全空）→ 空对象不抛错", () => {
    expect(parseOmnicodeUserInfo(null)).toEqual({});
    expect(parseOmnicodeUserInfo([1, 2])).toEqual({});
    expect(parseOmnicodeUserInfo({ email: "  ", name: 42 })).toEqual({});
  });
});

describe("omnicode batch3: parseOmnicodeDeviceMid (pure)", () => {
  it("只接受 UUID 形态的已存设备号（防脏数据进请求头）", () => {
    expect(
      parseOmnicodeDeviceMid({
        deviceMid: "123e4567-e89b-12d3-a456-426614174000",
      }),
    ).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(parseOmnicodeDeviceMid({ deviceMid: "not-a-uuid" })).toBeUndefined();
    expect(parseOmnicodeDeviceMid({})).toBeUndefined();
    expect(parseOmnicodeDeviceMid(null)).toBeUndefined();
  });
});

// ─── readOmnicodeAccountDataFromDataRoot（fs + cipher）──────────────────────────
describe("omnicode batch3: readOmnicodeAccountDataFromDataRoot (fs + cipher)", () => {
  let root: string;
  const NOW = Date.now();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omnicode-account-data-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSnapshot(entries: Record<string, string>): Promise<string> {
    const v2Dir = join(root, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
    const credentialsPath = join(v2Dir, "credentials.json");
    const encrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries)) {
      const cipher = createSystemCredentialCipher({
        filePath: credentialsPath,
        env: { ZCODE_CREDENTIAL_SECRET: SECRET },
      });
      encrypted[key] = await cipher.encrypt(value);
    }
    await writeFile(credentialsPath, JSON.stringify(encrypted), "utf8");
    return credentialsPath;
  }

  async function writeTelemetryState(payload: unknown): Promise<void> {
    const v2Dir = join(root, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v2Dir, "telemetry-state.json"), JSON.stringify(payload), "utf8");
  }

  it("happy path：身份 + 登录态 + JWT 存在性 + 数据根设备号（只读复用）", async () => {
    const credentialsPath = await writeSnapshot({
      "oauth:active_provider": "zai",
      "oauth:zai:expires_at": String(NOW + 10 * 24 * 60 * 60 * 1000),
      "oauth:zai:user_info": JSON.stringify({
        email: "a@b.c",
        name: "张三",
        avatar: "https://a/av.png",
        customerNumber: "CN1",
      }),
      zcodejwttoken: "jwt-token-value",
    });
    await writeTelemetryState({ deviceMid: "123e4567-e89b-12d3-a456-426614174000" });
    const snapshot = await readOmnicodeAccountDataFromDataRoot(root);
    expect(snapshot.identity).toEqual({
      email: "a@b.c",
      displayName: "张三",
      avatarUrl: "https://a/av.png",
      customerNumber: "CN1",
    });
    expect(snapshot.session).toMatchObject({ activeProvider: "zai", hasJwtToken: true });
    expect(typeof snapshot.session?.expiresAt).toBe("number");
    expect(snapshot.deviceMid).toBe("123e4567-e89b-12d3-a456-426614174000");
    // 红线：快照结果里绝不出现 token 明文
    expect(JSON.stringify(snapshot)).not.toContain("jwt-token-value");
    expect(await readFile(credentialsPath, "utf8")).toBeTruthy(); // 只读不写
  });

  it("telemetry-state.json 缺失/损坏 → deviceMid undefined（绝不生成）", async () => {
    await writeSnapshot({ "oauth:active_provider": "zai", zcodejwttoken: "jwt" });
    await expect(readOmnicodeAccountDataFromDataRoot(root)).resolves.toMatchObject({
      session: { hasJwtToken: true },
    });
    await writeTelemetryState("{corrupt");
    const snapshot = await readOmnicodeAccountDataFromDataRoot(root);
    expect(snapshot.deviceMid).toBeUndefined();
  });

  it("user_info JSON 损坏 → identity 缺省，session 不受影响（解密失败归未知静默）", async () => {
    await writeSnapshot({
      "oauth:active_provider": "zai",
      "oauth:zai:user_info": "{not json",
      zcodejwttoken: "jwt",
    });
    const snapshot = await readOmnicodeAccountDataFromDataRoot(root);
    expect(snapshot.identity).toBeUndefined();
    expect(snapshot.session).toEqual({ activeProvider: "zai", hasJwtToken: true });
  });

  it("active provider 缺失时 expires_at 取已知 provider 最大值；无 token → hasJwtToken=false", async () => {
    await writeSnapshot({
      "oauth:zai:expires_at": String(NOW + 1000),
      "oauth:bigmodel:expires_at": String(NOW + 9000),
    });
    const snapshot = await readOmnicodeAccountDataFromDataRoot(root);
    expect(snapshot.session).toEqual({ expiresAt: NOW + 9000, hasJwtToken: false });
  });

  it("凭据缺失/密钥过短/JSON 损坏 → 空快照（不抛错）", async () => {
    await expect(readOmnicodeAccountDataFromDataRoot(join(root, "nope"))).resolves.toEqual({});
    const v2Dir = join(root, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v2Dir, "credential-secret"), "short", "utf8");
    await writeFile(join(v2Dir, "credentials.json"), "{}", "utf8");
    await expect(readOmnicodeAccountDataFromDataRoot(root)).resolves.toEqual({});
  });

  it("readOmnicodeBillingCredentials：只回 jwtToken（供 main 侧请求头用，不进 IPC）", async () => {
    await writeSnapshot({ zcodejwttoken: "jwt-value-2" });
    await expect(readOmnicodeBillingCredentials(root)).resolves.toEqual({
      jwtToken: "jwt-value-2",
    });
    await expect(readOmnicodeBillingCredentials(join(root, "nope"))).resolves.toBeUndefined();
  });
});

// ─── billingClient：请求资格门 + 仿真头 ─────────────────────────────────────────
describe("omnicode batch3: billing request policy + headers", () => {
  it("资格门：缺设备号=skip（风控红线——绝不生成）优先于缺 JWT", () => {
    expect(resolveOmnicodeBillingRequestPolicy({ hasJwtToken: true, hasDeviceMid: false })).toBe(
      "skip_no_device_mid",
    );
    expect(resolveOmnicodeBillingRequestPolicy({ hasJwtToken: false, hasDeviceMid: false })).toBe(
      "skip_no_device_mid",
    );
    expect(resolveOmnicodeBillingRequestPolicy({ hasJwtToken: false, hasDeviceMid: true })).toBe(
      "skip_no_jwt",
    );
    expect(resolveOmnicodeBillingRequestPolicy({ hasJwtToken: true, hasDeviceMid: true })).toBe(
      "go",
    );
  });

  it("仿真头：Bearer + 全套 Cockpit 实测集，X-Device-Mid 只来自传入的该 profile 设备号", () => {
    const headers = buildOmnicodeBillingHeaders(
      {
        jwtToken: "jwt-abc",
        deviceMid: "dev-mid-of-this-profile",
        platform: "win32",
        arch: "x64",
        requestId: "req-1",
      },
      { method: "GET" },
    );
    expect(headers["Authorization"]).toBe("Bearer jwt-abc");
    expect(headers["X-Device-Mid"]).toBe("dev-mid-of-this-profile");
    expect(headers["X-Platform"]).toBe("win32-x64");
    expect(headers["X-ZCode-App-Version"]).toBeTruthy();
    expect(headers["X-Request-Id"]).toBe("req-1");
    expect(headers["User-Agent"]).toContain("ZCode/");
    expect(headers["X-Title"]).toBe("Z Code@electron");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("POST（claim）补 Content-Type；requestId 缺省生成", () => {
    const headers = buildOmnicodeBillingHeaders(
      { jwtToken: "jwt", deviceMid: "dm", platform: "win32", arch: "x64" },
      { method: "POST" },
    );
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Request-Id"]).toBeTruthy();
  });

  it("URL 构造走 shared helper（不硬编码 origin）且带 app_version", () => {
    expect(buildOmnicodeBalanceUrl({})).toContain("/api/v1/zcode-plan/billing/balance?app_version=");
    expect(buildOmnicodePreviewUrl({})).toContain(
      "/api/v1/zcode-plan/billing/preview?app_version=",
    );
    expect(buildOmnicodePreviewUrl({}, "1.2.3", "win32-x64")).toContain("platform=win32-x64");
    expect(buildOmnicodeClaimUrl({})).toContain("/api/v1/zcode-plan/billing/claim");
  });

  it("touch：seq 单调递增 + 语言归一为受支持 locale 覆写 X-Client-Language", () => {
    resetOmnicodeTouchRequestStateForTest();
    expect(buildOmnicodeTouchUrl({})).toContain("/api/v1/marketing/touch?seq=0");
    expect(buildOmnicodeTouchUrl({})).toContain("seq=1");
    // 显式 locale 精确命中；主前缀回退（zh-TW→zh-CN / en-GB→en-US）；不支持值兜底 en-US
    expect(resolveOmnicodeTouchRequestLocale("ja-JP")).toBe("ja-JP");
    expect(resolveOmnicodeTouchRequestLocale("zh-TW")).toBe("zh-CN");
    expect(resolveOmnicodeTouchRequestLocale("en-GB")).toBe("en-US");
    expect(resolveOmnicodeTouchRequestLocale("fr-FR")).toBe("en-US");
    const headers = buildOmnicodeTouchHeaders(
      { jwtToken: "jwt", deviceMid: "dm", platform: "win32", arch: "x64" },
      "zh-TW",
    );
    expect(headers["X-Client-Language"]).toBe("zh-CN");
    expect(headers.Authorization).toBe("Bearer jwt");
    expect(headers["X-Device-Mid"]).toBe("dm");
  });

  it("touch：投放动作发现（banner/popup/priority 序）与畸形 envelope 解析", () => {
    const parsed = parseOmnicodeTouchEnvelope({
      code: 0,
      data: {
        server_time: 1731000000,
        language: "zh-CN",
        deliveries: [
          {
            campaign_id: "camp-a",
            priority: 1,
            resource_position: "banner",
            banner: {
              background: {
                type: "image",
                image: { default: { src: "https://example.com/a.png", sha256: "a".repeat(64) } },
              },
              buttons: [
                {
                  text: { format: "plaintext", content: "领取" },
                  action: { type: "claim_zcode_plan", args: { plan_id: "plan-a" } },
                },
              ],
            },
          },
          {
            campaign_id: "camp-b",
            priority: 9,
            resource_position: "popup",
            popup: {
              title: { format: "plaintext", content: "t" },
              description: { format: "plaintext", content: "d" },
              buttons: [
                { text: { format: "plaintext", content: "x" }, action: { type: "close" } },
                {
                  text: { format: "plaintext", content: "领取" },
                  action: { type: "claim_zcode_plan", args: { plan_id: "plan-b" } },
                },
              ],
            },
          },
        ],
      },
    });
    expect(parsed?.rejectedCount).toBe(0);
    // priority 降序：popup(camp-b, 9) 先于 banner(camp-a, 1)
    expect(findOmnicodeTouchClaimAction(parsed!)).toEqual({ planId: "plan-b", campaignId: "camp-b" });
    // 无 claim 动作 → undefined
    const empty = parseOmnicodeTouchEnvelope({
      code: 0,
      data: { server_time: 1731000000, language: "zh-CN", deliveries: [] },
    });
    expect(findOmnicodeTouchClaimAction(empty!)).toBeUndefined();
    // 畸形 envelope（缺 data / code≠0 / 非对象）→ undefined（调用方回落 preview）
    expect(parseOmnicodeTouchEnvelope({ code: 0 })).toBeUndefined();
    expect(parseOmnicodeTouchEnvelope({ code: 3001, msg: "parameter error" })).toBeUndefined();
    expect(parseOmnicodeTouchEnvelope(null)).toBeUndefined();
  });
});

// ─── billingClient：响应解析 ────────────────────────────────────────────────────
describe("omnicode batch3: parseOmnicodeBalanceEnvelope", () => {
  it("聚合口径对齐 Cockpit：active plan 名 / 分桶求和 / period_end 最小值", () => {
    const parsed = parseOmnicodeBalanceEnvelope({
      code: 0,
      data: {
        server_time: 1731000000,
        plans: [
          { name: "GLM Coding Plan", status: "active", ends_at: 1732000000 },
          { name: "Old", status: "expired", ends_at: 1731500000 },
        ],
        balances: [
          {
            show_name: "GLM-4.6",
            meter: "model_usage",
            total_units: "100",
            used_units: 30,
            remaining_units: 70,
            period_end: 1731900000,
          },
          {
            show_name: "Bonus",
            total_units: 10.5,
            used_units: "0.5",
            available_units: 10,
            expires_at: 1731800000,
          },
        ],
      },
    });
    expect(parsed.planType).toBe("GLM Coding Plan");
    expect(parsed.quotaTotal).toBeCloseTo(110.5);
    expect(parsed.quotaUsed).toBeCloseTo(30.5);
    expect(parsed.quotaRemaining).toBeCloseTo(80);
    expect(parsed.quotaResetAt).toBe(1731800000);
    expect(parsed.plans).toHaveLength(2);
    expect(parsed.plans[0]).toEqual({ name: "GLM Coding Plan", status: "active", endsAt: 1732000000 });
    expect(parsed.balances[1]).toMatchObject({ remainingUnits: 10 }); // available_units fallback
    expect(parsed.serverTime).toBe(1731000000);
  });

  it("无 active plan 时 fallback 首 plan 名；空 envelope → 空数组", () => {
    expect(parseOmnicodeBalanceEnvelope({ code: 0, data: { plans: [{ name: "Only", status: "pending" }] } }).planType).toBe("Only");
    expect(parseOmnicodeBalanceEnvelope({})).toEqual({ plans: [], balances: [] });
  });
});

describe("omnicode batch3: parseOmnicodePreviewEnvelope", () => {
  it("priority 降序 + planId 缺失丢弃 + grant_units 求和", () => {
    const plans = parseOmnicodePreviewEnvelope({
      code: 0,
      data: {
        plans: [
          { plan_id: "low", name: "Low", priority: 1, entitlements: [{ grant_units: 10 }] },
          { plan_id: "", name: "Broken" },
          {
            plan_id: "high",
            name: "High",
            priority: "9",
            entitlements: [{ grant_units: 5 }, { grant_units: "2.5" }],
          },
        ],
      },
    });
    expect(plans.map((plan) => plan.planId)).toEqual(["high", "low"]);
    expect(plans[0]).toMatchObject({ priority: 9, grantUnits: 7.5 });
  });

  it("code≠0 → 空列表（整体失败）", () => {
    expect(parseOmnicodePreviewEnvelope({ code: 401 })).toEqual([]);
  });
});

describe("omnicode batch3: parseOmnicodeClaimEnvelope + 失败码映射", () => {
  it("成功：planId + show_name + grant_units 求和", () => {
    const result = parseOmnicodeClaimEnvelope({
      code: 0,
      data: {
        plan: {
          plan_id: "p1",
          status: "active",
          ends_at: 1732000000,
          entitlements: [{ show_name: "GLM-4.6", grant_units: 120 }, { grant_units: 30 }],
        },
      },
    });
    expect(result).toMatchObject({
      success: true,
      planId: "p1",
      planName: "GLM-4.6",
      grantedUnits: 150,
      endsAt: 1732000000,
    });
  });

  it("terminal 失败码 1001-1005 → 稳定原因键（不重试）；401 → login_required", () => {
    expect(resolveOmnicodeClaimFailureReasonKey(1001)).toBe("omnicode.claim.failure.plan_not_found");
    expect(resolveOmnicodeClaimFailureReasonKey(1002)).toBe("omnicode.claim.failure.plan_unavailable");
    expect(resolveOmnicodeClaimFailureReasonKey(1003)).toBe("omnicode.claim.failure.already_claimed");
    expect(resolveOmnicodeClaimFailureReasonKey(1004)).toBe("omnicode.claim.failure.ineligible");
    expect(resolveOmnicodeClaimFailureReasonKey(1005)).toBe("omnicode.claim.failure.quota_exhausted");
    expect(resolveOmnicodeClaimFailureReasonKey(401)).toBe("omnicode.claim.failure.login_required");
    expect(resolveOmnicodeClaimFailureReasonKey(9999)).toBe("omnicode.claim.failure.unknown");
    for (const code of [1001, 1002, 1003, 1004, 1005]) {
      const parsed = parseOmnicodeClaimEnvelope({ code, data: null });
      expect(parsed).toMatchObject({ success: false, code, reasonKey: resolveOmnicodeClaimFailureReasonKey(code) });
    }
  });

  it("数字字符串 code 归一；非数字 code → invalid_response；缺 plan → 失败不推断成功", () => {
    expect(parseOmnicodeClaimEnvelope({ code: "1003" })).toMatchObject({
      success: false,
      code: 1003,
      reasonKey: "omnicode.claim.failure.already_claimed",
    });
    expect(parseOmnicodeClaimEnvelope({ code: "abc" })).toMatchObject({
      success: false,
      code: -1,
      reasonKey: OMNICODE_CLAIM_REASON_INVALID_RESPONSE,
    });
    expect(parseOmnicodeClaimEnvelope({ code: 0, data: {} }).success).toBe(false);
  });

  it("传输层原因键映射（balance/claim 各自口径）", () => {
    expect(mapOmnicodeBalanceFailureReasonKey("network")).toBe(OMNICODE_BALANCE_REASON_NETWORK);
    expect(mapOmnicodeBalanceFailureReasonKey("http")).toBe(OMNICODE_BALANCE_REASON_HTTP);
    expect(mapOmnicodeBalanceFailureReasonKey("invalid_response")).toBe(
      OMNICODE_BALANCE_REASON_INVALID_RESPONSE,
    );
    expect(mapOmnicodeClaimTransportReasonKey("network")).toBe(OMNICODE_CLAIM_REASON_NETWORK);
  });
});

// ─── billingClient：传输层（可注入 fetch，永不抛穿）────────────────────────────
describe("omnicode batch3: fetchOmnicodeBillingEnvelope（失败归未知不抛穿）", () => {
  const okEnvelope = { code: 0, data: {} };

  it("网络抛错/超时 → network；非 2xx → http", async () => {
    const networkFail = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(
      fetchOmnicodeBillingEnvelope(networkFail, "https://x", { method: "GET", headers: {} }),
    ).resolves.toEqual({ ok: false, reason: "network" });
    const httpFail = (async () =>
      new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchOmnicodeBillingEnvelope(httpFail, "https://x", { method: "GET", headers: {} }),
    ).resolves.toMatchObject({ ok: false, reason: "http", httpStatus: 503 });
  });

  it("JSON 损坏 / 非对象 → invalid_response；正常 envelope 通过", async () => {
    const badJson = (async () => new Response("{corrupt", { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchOmnicodeBillingEnvelope(badJson, "https://x", { method: "GET", headers: {} }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_response" });
    const good = (async () =>
      new Response(JSON.stringify(okEnvelope), { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchOmnicodeBillingEnvelope(good, "https://x", { method: "GET", headers: {} }),
    ).resolves.toEqual({ ok: true, envelope: okEnvelope });
  });
});

// ─── claimPacer：抖动/中断/失败继续/事件 ────────────────────────────────────────
describe("omnicode batch3: resolveOmnicodeClaimJitterMs（抖动区间 300-1500）", () => {
  it("rand 0 → 下沿；rand 接近 1 → 上沿；越界收敛到区间内", () => {
    expect(resolveOmnicodeClaimJitterMs(0)).toBe(OMNICODE_CLAIM_JITTER_MIN_MS);
    expect(resolveOmnicodeClaimJitterMs(0.5)).toBe(
      Math.round(OMNICODE_CLAIM_JITTER_MIN_MS + 0.5 * (OMNICODE_CLAIM_JITTER_MAX_MS - OMNICODE_CLAIM_JITTER_MIN_MS)),
    );
    expect(resolveOmnicodeClaimJitterMs(1)).toBe(OMNICODE_CLAIM_JITTER_MAX_MS);
    expect(resolveOmnicodeClaimJitterMs(-5)).toBe(OMNICODE_CLAIM_JITTER_MIN_MS);
    expect(resolveOmnicodeClaimJitterMs(9)).toBe(OMNICODE_CLAIM_JITTER_MAX_MS);
    expect(resolveOmnicodeClaimJitterMs(Number.NaN)).toBe(OMNICODE_CLAIM_JITTER_MIN_MS);
  });
});

describe("omnicode batch3: runOmnicodeClaimQueue（节奏器）", () => {
  function makeHarness() {
    const sleeps: number[] = [];
    const events: OmnicodeClaimPacerEvent[] = [];
    return {
      sleeps,
      events,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      onEvent: (event: OmnicodeClaimPacerEvent) => {
        events.push(event);
      },
    };
  }

  it("逐张执行：事件序列完整、张间抖动注入（末张不 sleep）、失败不阻断下一张", async () => {
    const harness = makeHarness();
    const executions: string[] = [];
    const result = await runOmnicodeClaimQueue({
      jobs: [
        { profileId: "p1", planId: "plan1" },
        { profileId: "p2", planId: "plan2" },
        { profileId: "p3", planId: "plan3" },
      ],
      mode: "manual",
      sleep: harness.sleep,
      random: () => 0.25,
      onEvent: harness.onEvent,
      execute: async (job) => {
        executions.push(job.profileId);
        if (job.profileId === "p1") throw new Error("network down"); // 单张异常 → failed 继续
        if (job.profileId === "p2") return { outcome: "success", grantedUnits: 120, planName: "GLM-4.6" };
        return { outcome: "failed", reasonKey: "omnicode.claim.failure.already_claimed" };
      },
    });
    expect(executions).toEqual(["p1", "p2", "p3"]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.aborted).toBe(false);
    expect(harness.sleeps).toHaveLength(2); // 张间抖动，末张后不 sleep
    expect(harness.sleeps.every((ms) => ms >= OMNICODE_CLAIM_JITTER_MIN_MS && ms <= OMNICODE_CLAIM_JITTER_MAX_MS)).toBe(true);
    expect(harness.events.map((event) => event.type)).toEqual([
      "started",
      "account_start",
      "account_result",
      "account_start",
      "account_result",
      "account_start",
      "account_result",
      "done",
    ]);
    // 历史条目：p2 成功带 planName+grantedUnits；p1 异常归 unknown；p3 带 already_claimed 键
    expect(result.entries[0]).toMatchObject({
      profileId: "p1",
      outcome: "failed",
      reasonKey: "omnicode.claim.failure.unknown",
      mode: "manual",
    });
    expect(result.entries[1]).toMatchObject({
      profileId: "p2",
      outcome: "success",
      planName: "GLM-4.6",
      grantedUnits: 120,
    });
    expect(result.entries[2]).toMatchObject({
      profileId: "p3",
      outcome: "failed",
      reasonKey: "omnicode.claim.failure.already_claimed",
    });
  });

  it("中断（skip）：abort 后剩余全记 skipped、aborted=true、不执行", async () => {
    const harness = makeHarness();
    const executions: string[] = [];
    let abortAfterFirst = false;
    const result = await runOmnicodeClaimQueue({
      jobs: [
        { profileId: "p1", planId: "plan1" },
        { profileId: "p2", planId: "plan2" },
      ],
      mode: "auto",
      sleep: harness.sleep,
      random: () => 0,
      onEvent: harness.onEvent,
      shouldAbort: () => abortAfterFirst,
      execute: async (job) => {
        executions.push(job.profileId);
        abortAfterFirst = true; // 第一张执行完即触发中断
        return { outcome: "success" };
      },
    });
    expect(executions).toEqual(["p1"]);
    expect(result).toMatchObject({ succeeded: 1, skipped: 1, aborted: true });
    expect(result.entries[1]).toMatchObject({
      profileId: "p2",
      outcome: "skipped",
      reasonKey: "omnicode.claim.failure.aborted",
      mode: "auto",
    });
  });

  it("进度回调抛错不影响执行（onEvent 异常被吞）", async () => {
    const result = await runOmnicodeClaimQueue({
      jobs: [{ profileId: "p1", planId: "plan1" }],
      mode: "manual",
      sleep: async () => undefined,
      onEvent: () => {
        throw new Error("renderer gone");
      },
      execute: async () => ({ outcome: "success" }),
    });
    expect(result.succeeded).toBe(1);
  });
});

// ─── consoleUiState：merge 白名单扩展 ───────────────────────────────────────────
describe("omnicode batch3: mergeOmnicodeConsoleUiState 白名单扩展", () => {
  it("autoClaimEnabled 仅显式布尔写入；缺省不动（默认关语义）", () => {
    expect(mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {}).autoClaimEnabled).toBeUndefined();
    const merged = mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, { autoClaimEnabled: true });
    expect(merged.autoClaimEnabled).toBe(true);
    expect(mergeOmnicodeConsoleUiState(merged, { autoClaimEnabled: false }).autoClaimEnabled).toBe(false);
    // 字符串 true 不写入
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        autoClaimEnabled: "yes" as unknown as boolean,
      }).autoClaimEnabled,
    ).toBeUndefined();
  });

  it("claimHistory：非法条目丢弃（缺 outcome/枚举越界/核心字段类型错），合法条目保留", () => {
    const merged = mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
      claimHistory: [
        { at: 1, profileId: "p1", planId: "a", outcome: "success", mode: "manual" },
        { at: 2, profileId: "p2", planId: "b", mode: "auto" }, // 缺 outcome → 丢弃
        { at: 3, profileId: "p3", planId: "c", outcome: "won", mode: "auto" }, // 枚举越界 → 丢弃
        { profileId: "p4", planId: "d", outcome: "failed", mode: "auto" }, // 缺 at → 丢弃
        { at: 4, profileId: "p5", planId: "e", outcome: "failed", mode: "manual", reasonKey: "omnicode.claim.failure.quota_exhausted" },
      ],
    });
    expect(merged.claimHistory).toHaveLength(2);
    expect(merged.claimHistory?.[0]).toMatchObject({ profileId: "p1", outcome: "success" });
    expect(merged.claimHistory?.[1]).toMatchObject({ profileId: "p5", outcome: "failed" });
  });

  it("claimHistory FIFO 上限 50：超出丢最旧；patch 缺省（undefined）不动现有历史", () => {
    const full = normalizeOmnicodeClaimHistory(
      Array.from({ length: 50 }, (_, index) => ({
        at: index,
        profileId: `p${index}`,
        planId: "plan",
        outcome: "success" as const,
        mode: "manual" as const,
      })),
    );
    expect(full).toHaveLength(50);
    const appended = appendOmnicodeClaimHistory(full, {
      at: 999,
      profileId: "new",
      planId: "plan",
      outcome: "success",
      mode: "manual",
    });
    expect(appended).toHaveLength(50);
    expect(appended[0]).toMatchObject({ profileId: "p1" }); // 最旧的 p0 被挤掉
    expect(appended[49]).toMatchObject({ profileId: "new" });
    // 旧档缺字段：claimHistory 缺省 → 不动
    expect(mergeOmnicodeConsoleUiState({ ...DEFAULT_OMNICODE_CONSOLE_UI_STATE, claimHistory: full }, {}).claimHistory).toHaveLength(50);
  });

  it("未知字段不落盘（白名单外丢弃）", () => {
    // [OmniCode] 批次3 停靠重构：旧 mode 字段已退役（不再属于合并白名单），
    // 白名单外丢弃断言改用 dockDefault 合法字段 + evil 未知字段同款口径。
    const merged = mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
      dockDefault: false,
      evil: "payload",
    } as never);
    expect(merged).toMatchObject({ dockDefault: false, previewEnabled: true });
    expect(Object.keys(merged)).not.toContain("evil");
    expect(Object.keys(merged)).not.toContain("mode");
  });
});

// ─── accountDashboard：TTL + 装配 + balance 尝试 ───────────────────────────────
describe("omnicode batch3: accountDashboard TTL/装配/balance 尝试", () => {
  it("TTL 判定：30min 内命中、超时 miss、force 一律 miss", () => {
    const cachedAt = 1_000_000;
    expect(resolveOmnicodeSnapshotCacheHit(cachedAt, cachedAt + 30 * 60 * 1000 - 1, false)).toBe(true);
    expect(resolveOmnicodeSnapshotCacheHit(cachedAt, cachedAt + 30 * 60 * 1000, false)).toBe(false);
    expect(resolveOmnicodeSnapshotCacheHit(cachedAt, cachedAt + 1, true)).toBe(false);
  });

  it("装配：ok 带余额；失败带原因键；缺 attempt 归 unknown", () => {
    expect(assembleOmnicodeAccountBalanceView(undefined)).toEqual({ balanceState: "unknown" });
    const failed = assembleOmnicodeAccountBalanceView({
      state: "failed",
      reasonKey: OMNICODE_BALANCE_REASON_HTTP,
      fetchedAt: 1,
    });
    expect(failed).toMatchObject({ balanceState: "failed", balanceErrorReasonKey: OMNICODE_BALANCE_REASON_HTTP });
    const ok = assembleOmnicodeAccountBalanceView({
      state: "ok",
      balance: { plans: [], balances: [], quotaTotal: 100 },
      fetchedAt: 2,
    });
    expect(ok).toMatchObject({ balanceState: "ok", balanceFetchedAt: 2 });
  });

  it("balance 尝试：真实 envelope 解析成功；非零 code 归 failed；传输失败带原因键", async () => {
    const good = (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            server_time: 10,
            plans: [{ name: "Plan", status: "active", ends_at: 20 }],
            balances: [{ show_name: "GLM", total_units: 100, used_units: 10, remaining_units: 90 }],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    await expect(
      fetchOmnicodeAccountBalanceAttempt({
        profileId: "p1",
        jwtToken: "jwt",
        deviceMid: "dm",
        fetchImpl: good,
      }),
    ).resolves.toMatchObject({
      state: "ok",
      balance: { planType: "Plan", quotaTotal: 100, quotaUsed: 10, quotaRemaining: 90 },
    });
    const rejected = (async () =>
      new Response(JSON.stringify({ code: 401 }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchOmnicodeAccountBalanceAttempt({
        profileId: "p1",
        jwtToken: "jwt",
        deviceMid: "dm",
        fetchImpl: rejected,
      }),
    ).resolves.toMatchObject({ state: "failed", reasonKey: OMNICODE_BALANCE_REASON_HTTP });
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(
      fetchOmnicodeAccountBalanceAttempt({
        profileId: "p1",
        jwtToken: "jwt",
        deviceMid: "dm",
        fetchImpl: down,
      }),
    ).resolves.toMatchObject({ state: "failed", reasonKey: OMNICODE_BALANCE_REASON_NETWORK });
  });
});

// ─── claimRunner：目标解析 + run 编排（profileRuntime mock + 真 console-ui.json）─
describe("omnicode batch3: claimRunner（领取执行编排）", () => {
  let consoleRoot: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    consoleRoot = await mkdtemp(join(tmpdir(), "omnicode-console-"));
    originalDataDir = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = consoleRoot;
    resetOmnicodeClaimRunnerForTest();
    resetOmnicodeAccountDashboardCacheForTest();
    profileState.profiles = [];
    profileState.records = {};
    profileState.dirs = {};
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
    else process.env.ZCODE_DATA_BASE_DIR = originalDataDir;
    resetOmnicodeClaimRunnerForTest();
    await rm(consoleRoot, { recursive: true, force: true });
  });

  function makeFakeFetch(routes: { urlPart: string; body: unknown }[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = input.toString();
      const route = routes.find((entry) => url.includes(entry.urlPart));
      if (!route) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify(route.body), { status: 200 });
    }) as unknown as typeof fetch;
  }

  // touch 主源夹具（探测先打 marketing/touch，命中 claim_zcode_plan 即可领）
  const touchDeliveryBody = (planId: string) => ({
    code: 0,
    data: {
      server_time: 1700000000,
      language: "zh-CN",
      deliveries: [
        {
          campaign_id: `camp-${planId}`,
          priority: 10,
          resource_position: "banner",
          banner: {
            background: {
              type: "image",
              image: { default: { src: "https://example.com/a.png", sha256: "a".repeat(64) } },
            },
            buttons: [
              {
                text: { format: "plaintext", content: "立即领取" },
                action: { type: "claim_zcode_plan", args: { plan_id: planId } },
              },
            ],
          },
        },
      ],
    },
  });

  it("目标解析：缺设备号账号 skipped（no_device_mid），有设备号+touch 命中 → job", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "omnicode-target-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "omnicode-target-b-"));
    try {
      for (const [dir, withMid] of [
        [rootA, true],
        [rootB, false],
      ] as const) {
        const v2Dir = join(dir, ".zcode", "v2");
        await mkdir(v2Dir, { recursive: true });
        await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
        const credentialsPath = join(v2Dir, "credentials.json");
        const cipher = createSystemCredentialCipher({
          filePath: credentialsPath,
          env: { ZCODE_CREDENTIAL_SECRET: SECRET },
        });
        const snapshot: Record<string, string> = {
          "oauth:active_provider": await cipher.encrypt("zai"),
          zcodejwttoken: await cipher.encrypt("jwt-target"),
        };
        await writeFile(credentialsPath, JSON.stringify(snapshot), "utf8");
        if (withMid) {
          await writeFile(
            join(v2Dir, "telemetry-state.json"),
            JSON.stringify({ deviceMid: "123e4567-e89b-12d3-a456-426614174000" }),
            "utf8",
          );
        }
      }
      profileState.profiles = [
        { id: "pa", name: "A", createdAt: "t" },
        { id: "pb", name: "B", createdAt: "t" },
      ];
      profileState.records = { pa: { dataBaseDirOverride: rootA }, pb: { dataBaseDirOverride: rootB } };
      const fetchImpl = makeFakeFetch([
        {
          urlPart: "/marketing/touch",
          body: touchDeliveryBody("egg-1"),
        },
      ]);
      const targets = await resolveOmnicodeClaimTargets({ fetchImpl });
      expect(targets.jobs).toEqual([{ profileId: "pa", planId: "egg-1" }]);
      expect(targets.skippedAccounts).toEqual([
        { profileId: "pb", reasonKey: "omnicode.claim.failure.no_device_mid" },
      ]);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it("领取执行：broadcast 事件序列 + claimHistory FIFO 落盘（mode 标注共用节奏器）", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicode-run-"));
    try {
      const v2Dir = join(root, ".zcode", "v2");
      await mkdir(v2Dir, { recursive: true });
      await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
      const credentialsPath = join(v2Dir, "credentials.json");
      const cipher = createSystemCredentialCipher({
        filePath: credentialsPath,
        env: { ZCODE_CREDENTIAL_SECRET: SECRET },
      });
      await writeFile(
        credentialsPath,
        JSON.stringify({
          "oauth:active_provider": await cipher.encrypt("zai"),
          zcodejwttoken: await cipher.encrypt("jwt-run"),
        }),
        "utf8",
      );
      await writeFile(
        join(v2Dir, "telemetry-state.json"),
        JSON.stringify({ deviceMid: "123e4567-e89b-12d3-a456-426614174001" }),
        "utf8",
      );
      profileState.profiles = [{ id: "pr", name: "R", createdAt: "t" }];
      profileState.records = { pr: { dataBaseDirOverride: root } };
      const fetchImpl = makeFakeFetch([
        {
          urlPart: "/marketing/touch",
          body: touchDeliveryBody("egg-2"),
        },
        {
          urlPart: "/billing/claim",
          body: {
            code: 0,
            data: {
              plan: {
                plan_id: "egg-2",
                status: "active",
                entitlements: [{ show_name: "GLM-4.6", grant_units: 88 }],
              },
            },
          },
        },
      ]);
      const events: string[] = [];
      const options: OmnicodeClaimRunOptions = {
        mode: "manual",
        broadcast: (payload) => {
          events.push(payload.type === "account_result" ? `result:${payload.outcome}` : payload.type);
        },
        fetchImpl,
        sleep: async () => undefined,
        random: () => 0,
      };
      const started = await startOmnicodeAccountClaimRun(options);
      expect(started).toMatchObject({ ok: true, total: 1 });
      expect(typeof (started as { runId?: string }).runId).toBe("string");
      await vi.waitFor(() => {
        expect(events).toEqual(["started", "account_start", "result:success", "done"]);
        expect(hasOmnicodeClaimRunInFlight()).toBe(false);
      });
      // 历史 FIFO 落盘到 console-ui.json（ZCODE_DATA_BASE_DIR 指向的临时目录）
      const persisted = JSON.parse(
        await readFile(join(consoleRoot, "console-ui.json"), "utf8"),
      ) as { claimHistory?: { profileId: string; planId: string; grantedUnits?: number; mode?: string }[] };
      expect(persisted.claimHistory).toHaveLength(1);
      expect(persisted.claimHistory?.[0]).toMatchObject({
        profileId: "pr",
        planId: "egg-2",
        grantedUnits: 88,
        mode: "manual",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("连发保护：run 进行中拒绝（in_progress）；无目标 → no_targets", async () => {
    // 无 profile → 无目标
    const noTargets = await startOmnicodeAccountClaimRun({
      mode: "manual",
      broadcast: () => undefined,
      fetchImpl: makeFakeFetch([]),
    });
    expect(noTargets).toEqual({ ok: false, reason: "no_targets" });
    // 构造一个慢 run 占位（2 张 → 张间 sleep 被 gate 卡住，run 保持 in-flight）
    const root = await mkdtemp(join(tmpdir(), "omnicode-busy-"));
    try {
      const v2Dir = join(root, ".zcode", "v2");
      await mkdir(v2Dir, { recursive: true });
      await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
      const credentialsPath = join(v2Dir, "credentials.json");
      const cipher = createSystemCredentialCipher({
        filePath: credentialsPath,
        env: { ZCODE_CREDENTIAL_SECRET: SECRET },
      });
      await writeFile(
        credentialsPath,
        JSON.stringify({ zcodejwttoken: await cipher.encrypt("jwt-busy") }),
        "utf8",
      );
      await writeFile(
        join(v2Dir, "telemetry-state.json"),
        JSON.stringify({ deviceMid: "123e4567-e89b-12d3-a456-426614174002" }),
        "utf8",
      );
      profileState.profiles = [
        { id: "pb1", name: "B1", createdAt: "t" },
        { id: "pb2", name: "B2", createdAt: "t" },
      ];
      profileState.records = { pb1: { dataBaseDirOverride: root }, pb2: { dataBaseDirOverride: root } };
      const fetchImpl = makeFakeFetch([
        {
          urlPart: "/marketing/touch",
          body: touchDeliveryBody("egg-3"),
        },
      ]);
      // 阻塞 sleep 使第一个 run 挂起（第 1 张执行完后进入张间 sleep）
      let releaseSleep: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
      const first = await startOmnicodeAccountClaimRun({
        mode: "manual",
        broadcast: () => undefined,
        fetchImpl,
        sleep: () => gate,
      });
      expect(first).toMatchObject({ ok: true, total: 2 });
      expect(hasOmnicodeClaimRunInFlight()).toBe(true);
      const second = await startOmnicodeAccountClaimRun({
        mode: "auto",
        broadcast: () => undefined,
        fetchImpl,
      });
      expect(second).toEqual({ ok: false, reason: "in_progress" });
      releaseSleep?.();
      await vi.waitFor(() => expect(hasOmnicodeClaimRunInFlight()).toBe(false));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

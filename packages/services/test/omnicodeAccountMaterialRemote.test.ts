// [OmniCode] 模式二 R2 单测：附加账号材料 bridge-proxy 来源提供者 + 组合提供者（spec:
// docs/omnicode/multi-account-sessions.md §5）。覆盖：
// - 请求通道：载荷过 shared request schema 后才出进程（非法 accountId 不 postMessage）；
//   postMessage 载荷形态 = HostResponseTypes.OmnicodeAccountMaterialRequest + requestId。
// - 应答处理：ok=true + 合法 base64 材料快照 → 映射 OmnicodeAccountOverrideMaterial；
//   schema 不符 / base64 损坏 / JSON 非法 / accountId 串号 → null（fail-closed）。
// - TTL 缓存：TTL 内命中不再 postMessage（调用计数）；过期重取；null 结果同样缓存。
// - 超时/缺席：transport null（CLI/远端 Host）→ 恒 null；应答迟到（超时后到达）丢弃。
// - 组合提供者：remote 命中即用（fallback 不触）；remote 缺 → local 兜底；两级都缺 →
//   null（fail-closed，绝不回落主账号材料）。
// 注：transport 用注入 stub（不发真消息），材料字段为合成夹具值（非真实凭据形态）。
import { describe, expect, it, vi } from "vitest";
import {
  createOmnicodeAccountRemoteFirstMaterialProvider,
  createOmnicodeAccountRemoteMaterialProvider,
  decodeOmnicodeAccountMaterialReply,
  type OmnicodeAccountMaterialTransport,
} from "../src/omnicode/accountMaterialRemote.js";
import type {
  OmnicodeAccountMaterialProvider,
  OmnicodeAccountOverrideMaterial,
} from "../src/omnicode/accountOverride.js";

const syntheticFixture = (part: string) => `omnicode-r2-test-fixture:${part}`;

function materialFileData(accountId: string): Record<string, unknown> {
  return {
    accountId,
    family: "zai",
    selections: { zai: { kind: "start-plan" } },
    accountIdentity: syntheticFixture(`identity-${accountId}`),
    startPlanMaterial: {
      family: "zai",
      loginProvider: "zai",
      zcodeUserId: syntheticFixture(`user-${accountId}`),
      sessionRevision: null,
      accountIdentity: syntheticFixture(`identity-${accountId}`),
      zcodeJwtToken: syntheticFixture(`jwt-${accountId}`),
    },
    familyMaterial: {
      family: "zai",
      loginProvider: "zai",
      zcodeUserId: syntheticFixture(`user-${accountId}`),
      sessionRevision: null,
      accountIdentity: syntheticFixture(`identity-${accountId}`),
      accessToken: syntheticFixture(`access-${accountId}`),
      zcodeJwtToken: syntheticFixture(`jwt-${accountId}`),
    },
    deviceMid: syntheticFixture(`mid-${accountId}`),
  };
}

const encodeBase64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

interface TransportHarness {
  transport: OmnicodeAccountMaterialTransport;
  postCount: () => number;
  /** 取最近一次 postMessage 的请求 id（供测试回放应答）。 */
  lastRequestId: () => string;
  emitResult: (requestId: string, result: unknown) => void;
}

function createTransportHarness(): TransportHarness {
  let listener: ((e: { data: unknown }) => void) | null = null;
  const posted: unknown[] = [];
  const transport: OmnicodeAccountMaterialTransport = {
    postMessage(message: unknown) {
      posted.push(message);
    },
    on(_event, cb) {
      listener = cb;
    },
  };
  return {
    transport,
    postCount: () => posted.length,
    lastRequestId: () =>
      (posted.at(-1) as { requestId?: string } | undefined)?.requestId ?? "",
    emitResult: (requestId, result) => {
      listener?.({ data: result });
    },
  };
}

function staticProvider(
  value: OmnicodeAccountOverrideMaterial | null,
  counter?: { calls: number },
): OmnicodeAccountMaterialProvider {
  return {
    async load() {
      if (counter) counter.calls += 1;
      return value;
    },
  };
}

describe("模式二 R2：decodeOmnicodeAccountMaterialReply（纯函数）", () => {
  it("合法材料快照 base64 → OmnicodeAccountOverrideMaterial", () => {
    const decoded = decodeOmnicodeAccountMaterialReply(
      encodeBase64(materialFileData("acct-p12345678")),
      "acct-p12345678",
    );
    expect(decoded).not.toBeNull();
    expect(decoded?.accountId).toBe("acct-p12345678");
    expect(decoded?.family).toBe("zai");
    expect(decoded?.familyMaterial?.accessToken).toBe(syntheticFixture("access-acct-p12345678"));
    expect(decoded?.deviceMid).toBe(syntheticFixture("mid-acct-p12345678"));
  });

  it("base64 损坏 / JSON 非法 / schema 不符 → null", () => {
    expect(decodeOmnicodeAccountMaterialReply("!!!not-base64!!!", "acct-p1")).toBeNull();
    expect(
      decodeOmnicodeAccountMaterialReply(Buffer.from("{broken", "utf8").toString("base64"), "x"),
    ).toBeNull();
    expect(decodeOmnicodeAccountMaterialReply(encodeBase64({ nope: 1 }), "x")).toBeNull();
  });

  it("accountId 串号（应答材料 ≠ 请求键）→ null（防串号）", () => {
    expect(
      decodeOmnicodeAccountMaterialReply(encodeBase64(materialFileData("acct-p99999999")), "acct-p12345678"),
    ).toBeNull();
  });
});

describe("模式二 R2：remote 提供者（请求通道 + TTL 缓存）", () => {
  it("load 成功路径：合法载荷出进程 → 应答映射材料", async () => {
    const harness = createTransportHarness();
    const provider = createOmnicodeAccountRemoteMaterialProvider({ transport: harness.transport });
    const pendingLoad = provider.load("acct-p12345678");
    const requestId = harness.lastRequestId();
    harness.emitResult(requestId, {
      type: "omnicode-account-material-result",
      requestId,
      ok: true,
      dataBase64: encodeBase64(materialFileData("acct-p12345678")),
    });
    const material = await pendingLoad;
    expect(material?.accountId).toBe("acct-p12345678");
    expect(harness.postCount()).toBe(1);
  });

  it("非法 accountId（形态不符 schema）不出进程，直接 null", async () => {
    const harness = createTransportHarness();
    const provider = createOmnicodeAccountRemoteMaterialProvider({ transport: harness.transport });
    expect(await provider.load("../evil")).toBeNull();
    expect(await provider.load("")).toBeNull();
    expect(harness.postCount()).toBe(0);
  });

  it("ok=false 结构化失败 → null；错误键不进材料", async () => {
    const harness = createTransportHarness();
    const provider = createOmnicodeAccountRemoteMaterialProvider({ transport: harness.transport });
    const pendingLoad = provider.load("acct-p12345678");
    harness.emitResult(harness.lastRequestId(), {
      type: "omnicode-account-material-result",
      requestId: harness.lastRequestId(),
      ok: false,
      error: "omnicode_account_unknown",
    });
    expect(await pendingLoad).toBeNull();
  });

  it("TTL 缓存：TTL 内命中不再发请求（null 结果同样缓存）；过期重取", async () => {
    let clock = 1_000;
    const harness = createTransportHarness();
    const provider = createOmnicodeAccountRemoteMaterialProvider({
      transport: harness.transport,
      cacheTtlMs: 60_000,
      now: () => clock,
    });
    // 第一轮：未命中 → 发请求 → 回 ok=false（null 缓存）。
    let pendingLoad = provider.load("acct-p12345678");
    harness.emitResult(harness.lastRequestId(), {
      type: "omnicode-account-material-result",
      requestId: harness.lastRequestId(),
      ok: false,
      error: "omnicode_account_unknown",
    });
    expect(await pendingLoad).toBeNull();
    expect(harness.postCount()).toBe(1);
    // TTL 内第二次 load：命中缓存（null），不再 postMessage。
    expect(await provider.load("acct-p12345678")).toBeNull();
    expect(harness.postCount()).toBe(1);
    // 过期：重新发请求 → 回合法材料。
    clock += 60_001;
    pendingLoad = provider.load("acct-p12345678");
    harness.emitResult(harness.lastRequestId(), {
      type: "omnicode-account-material-result",
      requestId: harness.lastRequestId(),
      ok: true,
      dataBase64: encodeBase64(materialFileData("acct-p12345678")),
    });
    const material = await pendingLoad;
    expect(material?.accountId).toBe("acct-p12345678");
    expect(harness.postCount()).toBe(2);
    // 命中正值缓存：TTL 内不再发请求。
    expect((await provider.load("acct-p12345678"))?.accountIdentity).toBe(
      syntheticFixture("identity-acct-p12345678"),
    );
    expect(harness.postCount()).toBe(2);
  });

  it("transport 缺席（CLI/远端 Host 无 main 通道）→ 恒 null，零 postMessage", async () => {
    const provider = createOmnicodeAccountRemoteMaterialProvider({ transport: null });
    expect(await provider.load("acct-p12345678")).toBeNull();
  });

  it("应答超时安全网 → null（迟到应答丢弃，不悬挂）", async () => {
    vi.useFakeTimers();
    try {
      const harness = createTransportHarness();
      const provider = createOmnicodeAccountRemoteMaterialProvider({
        transport: harness.transport,
        requestTimeoutMs: 5_000,
      });
      const pendingLoad = provider.load("acct-p12345678");
      const assertion = expect(pendingLoad).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      // 超时后到达的应答（迟到/陌生 requestId）直接丢弃。
      harness.emitResult(harness.lastRequestId(), {
        type: "omnicode-account-material-result",
        requestId: harness.lastRequestId(),
        ok: true,
        dataBase64: encodeBase64(materialFileData("acct-p12345678")),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("陌生/畸形应答消息（requestId 不匹配 / schema 不符）静默丢弃", async () => {
    const harness = createTransportHarness();
    const provider = createOmnicodeAccountRemoteMaterialProvider({ transport: harness.transport });
    const pendingLoad = provider.load("acct-p12345678");
    harness.emitResult("stranger-id", {
      type: "omnicode-account-material-result",
      requestId: "stranger-id",
      ok: true,
      dataBase64: encodeBase64(materialFileData("acct-p12345678")),
    });
    harness.emitResult(harness.lastRequestId(), { totally: "unexpected" });
    harness.emitResult(harness.lastRequestId(), {
      type: "omnicode-account-material-result",
      requestId: harness.lastRequestId(),
      ok: true,
      dataBase64: encodeBase64(materialFileData("acct-p12345678")),
    });
    expect((await pendingLoad)?.accountId).toBe("acct-p12345678");
  });

  it("postMessage 抛错（Host 退出竞态）→ null，不抛穿", async () => {
    const transport: OmnicodeAccountMaterialTransport = {
      postMessage() {
        throw new Error("port closed");
      },
      on() {},
    };
    const provider = createOmnicodeAccountRemoteMaterialProvider({ transport });
    expect(await provider.load("acct-p12345678")).toBeNull();
  });
});

describe("模式二 R2：组合提供者（remote 优先 / local 兜底）", () => {
  const remoteMaterial: OmnicodeAccountOverrideMaterial = {
    accountId: "acct-p12345678",
    family: "zai",
    selections: { zai: { kind: "start-plan" } },
    accountIdentity: syntheticFixture("identity-remote"),
    startPlanMaterial: null,
    familyMaterial: null,
    deviceMid: syntheticFixture("mid-remote"),
  };
  const localMaterial: OmnicodeAccountOverrideMaterial = {
    accountId: "acct-p12345678",
    family: "bigmodel",
    selections: { bigmodel: { kind: "start-plan" } },
    accountIdentity: syntheticFixture("identity-local"),
    startPlanMaterial: null,
    familyMaterial: null,
    deviceMid: null,
  };

  it("remote 命中即用（fallback 不触）——零重登目标", async () => {
    const fallbackCalls = { calls: 0 };
    const composite = createOmnicodeAccountRemoteFirstMaterialProvider({
      remote: staticProvider(remoteMaterial),
      fallback: staticProvider(localMaterial, fallbackCalls),
    });
    const material = await composite.load("acct-p12345678");
    expect(material?.accountIdentity).toBe(syntheticFixture("identity-remote"));
    expect(fallbackCalls.calls).toBe(0);
  });

  it("remote 未命中 → local 兜底；两级都缺 → null（fail-closed）", async () => {
    const fallbackCalls = { calls: 0 };
    const composite = createOmnicodeAccountRemoteFirstMaterialProvider({
      remote: staticProvider(null),
      fallback: staticProvider(localMaterial, fallbackCalls),
    });
    expect((await composite.load("acct-p12345678"))?.accountIdentity).toBe(
      syntheticFixture("identity-local"),
    );
    expect(fallbackCalls.calls).toBe(1);
    const bothMiss = createOmnicodeAccountRemoteFirstMaterialProvider({
      remote: staticProvider(null),
      fallback: staticProvider(null),
    });
    expect(await bothMiss.load("acct-p12345678")).toBeNull();
  });
});

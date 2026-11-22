// [OmniCode] 模式二 R3/R4 契约单测（spec: docs/omnicode/multi-account-sessions.md §6/§7）：
// - 附加账号目录元数据契约：条目 schema 形态/白名单、strict 拒绝多余键（凭据字段进不来）、
//   accountId/sourceProfileId 形态防线、应答载荷结构化错误键；
// - 槽位用量契约：running/limit 非负整数、应答载荷校验；
// - 双端消息 union 注册：main↔Host 的目录/槽位消息在 hostIncomingMessageSchema /
//   hostResponseMessageSchema 均可路由识别（shared-asset-fetch 先例同款）；
// - v4 sendText payload 的 omnicodeAccountId（additive 可选）：合法形态接受、非法形态拒绝、
//   缺省不受影响（官方路径逐字不变）；
// - R4 全局偏好新键：omnicodeSmartScheduling 白名单过滤（布尔放行/非法丢弃/敏感键丢弃）。
import { describe, expect, it } from "vitest";
import { commandPayloadSchemas } from "../src/zcode-protocol-v4/command.js";
import {
  filterOmnicodeGlobalPrefsFromPatch,
  hostIncomingMessageSchema,
  hostResponseMessageSchema,
  omnicodeAccountDirectoryEntrySchema,
  omnicodeAccountDirectoryListRequestPayloadSchema,
  omnicodeAccountDirectoryListResultPayloadSchema,
  omnicodeAccountSlotsResultPayloadSchema,
} from "../src/index.js";

/** 测试夹具专用：合成"明显非真实凭据"的字符串值（拼接生成，规避真实凭据形态）。 */
const synthetic = (part: string) => `omnicode-r3-test-fixture:${part}`;

const validEntry = {
  accountId: "acct-p0r3test01",
  sourceProfileId: "p0r3test01",
  family: "zai",
  displayName: "工作号实例",
} as const;

describe("模式二 R3 附加账号目录元数据契约", () => {
  it("合法条目通过；形状逐字段锁定", () => {
    const parsed = omnicodeAccountDirectoryEntrySchema.parse(validEntry);
    expect(parsed.accountId).toBe(validEntry.accountId);
    expect(parsed.family).toBe("zai");
  });

  it("strict：任何额外键（含凭据形字段）整条拒绝——材料永不进本契约", () => {
    expect(
      omnicodeAccountDirectoryEntrySchema.safeParse({
        ...validEntry,
        // 测试夹具合成值：证明凭据形字段进不了元数据契约，非真实凭据。
        accessToken: synthetic("leaked-token"),
        zcodeJwtToken: synthetic("leaked-jwt"),
        deviceMid: synthetic("leaked-mid"),
      }).success,
    ).toBe(false);
  });

  it("accountId/sourceProfileId 形态防线（防串号/目录穿越）", () => {
    expect(
      omnicodeAccountDirectoryEntrySchema.safeParse({
        ...validEntry,
        accountId: "../escape",
      }).success,
    ).toBe(false);
    expect(
      omnicodeAccountDirectoryEntrySchema.safeParse({
        ...validEntry,
        sourceProfileId: "UPPER-CASE",
      }).success,
    ).toBe(false);
  });

  it("目录查询请求载荷 strict（无参数）", () => {
    expect(omnicodeAccountDirectoryListRequestPayloadSchema.safeParse({}).success).toBe(true);
    expect(
      omnicodeAccountDirectoryListRequestPayloadSchema.safeParse({ accountId: "x" }).success,
    ).toBe(false);
  });

  it("目录查询应答载荷：ok=true 带 accounts；ok=false 只带结构化错误键", () => {
    const ok = omnicodeAccountDirectoryListResultPayloadSchema.safeParse({
      ok: true,
      accounts: [validEntry],
    });
    expect(ok.success).toBe(true);
    const failed = omnicodeAccountDirectoryListResultPayloadSchema.safeParse({
      ok: false,
      error: "omnicode_account_directory_unavailable",
    });
    expect(failed.success).toBe(true);
    // 账号条目上限 32（防桥载荷放大）。
    const overflow = omnicodeAccountDirectoryListResultPayloadSchema.safeParse({
      ok: true,
      accounts: Array.from({ length: 33 }, () => validEntry),
    });
    expect(overflow.success).toBe(false);
  });
});

describe("模式二 R3 槽位用量契约", () => {
  it("running/limit 非负整数；负数/小数拒绝", () => {
    expect(
      omnicodeAccountSlotsResultPayloadSchema.safeParse({
        ok: true,
        slots: [{ accountId: "acct-p0r3test01", running: 1, limit: 3 }],
      }).success,
    ).toBe(true);
    expect(
      omnicodeAccountSlotsResultPayloadSchema.safeParse({
        ok: true,
        slots: [{ accountId: "acct-p0r3test01", running: -1, limit: 3 }],
      }).success,
    ).toBe(false);
    expect(
      omnicodeAccountSlotsResultPayloadSchema.safeParse({
        ok: true,
        slots: [{ accountId: "acct-p0r3test01", running: 1.5, limit: 3 }],
      }).success,
    ).toBe(false);
  });

  it("槽位应答 strict：多余键拒绝（元数据 only 红线）", () => {
    expect(
      omnicodeAccountSlotsResultPayloadSchema.safeParse({
        ok: true,
        slots: [],
        accessToken: synthetic("leaked"),
      }).success,
    ).toBe(false);
  });
});

describe("模式二 R3 main↔Host 消息 union 注册", () => {
  it("hostIncomingMessageSchema 识别目录应答 + 槽位查询（main → host）", () => {
    expect(
      hostIncomingMessageSchema.safeParse({
        type: "omnicode-account-directory-list-result",
        requestId: synthetic("req"),
        ok: true,
        accounts: [validEntry],
      }).success,
    ).toBe(true);
    expect(
      hostIncomingMessageSchema.safeParse({
        type: "omnicode-account-slots-request",
        requestId: synthetic("req"),
      }).success,
    ).toBe(true);
  });

  it("hostResponseMessageSchema 识别目录查询（host → main）", () => {
    expect(
      hostResponseMessageSchema.safeParse({
        type: "omnicode-account-directory-list-request",
        requestId: synthetic("req"),
        request: {},
      }).success,
    ).toBe(true);
    expect(
      hostResponseMessageSchema.safeParse({
        type: "omnicode-account-slots-result",
        requestId: synthetic("req"),
        ok: true,
        slots: [{ accountId: "acct-p0r3test01", running: 0, limit: 3 }],
      }).success,
    ).toBe(true);
  });
});

describe("模式二 R3 v4 sendText omnicodeAccountId（additive 可选）", () => {
  it("合法形态接受；缺省不受影响（官方路径逐字不变）", () => {
    const base = { text: "hello" };
    const official = commandPayloadSchemas.sendText.parse(base);
    expect("omnicodeAccountId" in official).toBe(false);
    const bound = commandPayloadSchemas.sendText.parse({
      ...base,
      omnicodeAccountId: "acct-p0r3test01",
    });
    expect(bound.omnicodeAccountId).toBe("acct-p0r3test01");
  });

  it("非法形态拒绝（防串号）", () => {
    expect(
      commandPayloadSchemas.sendText.safeParse({ text: "hi", omnicodeAccountId: "bad id!" }).success,
    ).toBe(false);
    expect(
      commandPayloadSchemas.sendText.safeParse({ text: "hi", omnicodeAccountId: "" }).success,
    ).toBe(false);
  });
});

describe("模式二 R4 全局偏好新键 omnicodeSmartScheduling", () => {
  it("布尔放行；非布尔丢弃；缺席键不产生", () => {
    expect(filterOmnicodeGlobalPrefsFromPatch({ omnicodeSmartScheduling: true })).toEqual({
      omnicodeSmartScheduling: true,
    });
    expect(filterOmnicodeGlobalPrefsFromPatch({ omnicodeSmartScheduling: "yes" })).toEqual({});
    expect(filterOmnicodeGlobalPrefsFromPatch({})).toEqual({});
  });

  it("敏感键仍被丢弃（既有红线不回退）", () => {
    const filtered = filterOmnicodeGlobalPrefsFromPatch({
      omnicodeSmartScheduling: false,
      dataBaseDir: synthetic("escape"),
      providerFamilyDomain: "bigmodel",
      __proto__: { polluted: true },
    } as Record<string, unknown>);
    expect(filtered).toEqual({ omnicodeSmartScheduling: false });
  });
});

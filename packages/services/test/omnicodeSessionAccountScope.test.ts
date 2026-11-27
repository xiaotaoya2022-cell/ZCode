// [OmniCode] 模式二 R1.5（单实例多账号并发会话）会话作用域接线单测（spec:
// docs/omnicode/multi-account-sessions.md §4/§10-R1.5）：
// - 包裹决策纯函数：omnicode 门控关 → 不包裹；未绑定/空白 accountId → 不包裹；
//   绑定且门控开 → 包裹；
// - 会话→附加账号绑定注册表：roundtrip/workspace 隔离/unbind/门控关 no-op/覆盖/FIFO 有界；
// - 作用域包裹执行器：未绑定/门控关 → 官方上下文逐字透传；绑定 → runWithOmnicodeAccountScope
//   作用域（含跨 await 传播）；gateActive 缺省读 OMNICODE_PROFILE_ID env；
// - 端到端接线纯部分：registry 决策 → 作用域 → accountOverride 覆盖边界按附加账号材料作答
//   （fallback 不触）；无绑定 → fallback 原样触发（官方路径）；
// - R2 预留协议占位（bridge-proxy 附加账号材料 main↔Host 消息）：载荷 schema 校验 +
//   双端 union 路由识别（shared-asset-fetch 先例同款）。
// 注：全部凭据形字段为测试夹具合成值（syntheticFixture 拼接生成，非真实凭据形态）。
import { describe, expect, it } from "vitest";
import {
  hostIncomingMessageSchema,
  hostResponseMessageSchema,
} from "@zcode/shared";
import {
  createOmnicodeAccountOverride,
  getOmnicodeAccountScopeAccountId,
  type OmnicodeAccountOverrideMaterial,
} from "../src/omnicode/accountOverride.js";
import {
  createOmnicodeSessionAccountRegistry,
  isOmnicodeSessionScopeGateActive,
  runWithOmnicodeSessionAccountScope,
  shouldWrapOmnicodeAccountScope,
} from "../src/omnicode/sessionAccountScope.js";

/** 测试夹具专用：合成"明显非真实凭据"的字符串值（拼接生成，规避真实凭据形态）。 */
const syntheticFixture = (part: string) => `omnicode-r15-test-fixture:${part}`;

const gateOn = () => true;
const gateOff = () => false;

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

describe("模式二 R1.5：包裹决策纯函数", () => {
  it("omnicode 门控关 → 恒不包裹（绑定与否均不包裹）", () => {
    expect(shouldWrapOmnicodeAccountScope({ gateActive: false, accountId: "acct" })).toBe(false);
    expect(shouldWrapOmnicodeAccountScope({ gateActive: false, accountId: null })).toBe(false);
  });

  it("门控开但未绑定/空白 accountId → 不包裹（官方路径）", () => {
    expect(shouldWrapOmnicodeAccountScope({ gateActive: true, accountId: null })).toBe(false);
    expect(shouldWrapOmnicodeAccountScope({ gateActive: true, accountId: "" })).toBe(false);
    expect(shouldWrapOmnicodeAccountScope({ gateActive: true, accountId: "   " })).toBe(false);
  });

  it("绑定且门控开 → 包裹", () => {
    expect(shouldWrapOmnicodeAccountScope({ gateActive: true, accountId: "omni-acct" })).toBe(true);
  });

  it("缺省门控 = OMNICODE_PROFILE_ID env", () => {
    const previous = process.env.OMNICODE_PROFILE_ID;
    try {
      delete process.env.OMNICODE_PROFILE_ID;
      expect(isOmnicodeSessionScopeGateActive()).toBe(false);
      process.env.OMNICODE_PROFILE_ID = "profile-1";
      expect(isOmnicodeSessionScopeGateActive()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OMNICODE_PROFILE_ID;
      else process.env.OMNICODE_PROFILE_ID = previous;
    }
  });
});

describe("模式二 R1.5：会话→附加账号绑定注册表", () => {
  it("bind→resolve 往返；workspace 隔离；重复绑定覆盖", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    registry.bind({ workspaceKey: "ws-a", sessionId: "task-1", accountId: "acct-1" });
    expect(registry.resolve({ workspaceKey: "ws-a", sessionId: "task-1" })).toBe("acct-1");
    // 同 taskId 跨 workspace 不串号（tasks-index 主键同构：workspace_key + task_id）。
    expect(registry.resolve({ workspaceKey: "ws-b", sessionId: "task-1" })).toBeNull();
    // workspaceKey 缺省按空桶命名空间。
    registry.bind({ sessionId: "task-2", accountId: "acct-2" });
    expect(registry.resolve({ sessionId: "task-2" })).toBe("acct-2");
    // 重复绑定覆盖旧值（会话内换账号，下一次请求生效）。
    registry.bind({ workspaceKey: "ws-a", sessionId: "task-1", accountId: "acct-1b" });
    expect(registry.resolve({ workspaceKey: "ws-a", sessionId: "task-1" })).toBe("acct-1b");
  });

  it("unbind 解除绑定；未绑定/非法键 no-op", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    registry.bind({ sessionId: "task-1", accountId: "acct-1" });
    registry.unbind({ sessionId: "task-1" });
    expect(registry.resolve({ sessionId: "task-1" })).toBeNull();
    expect(registry.size()).toBe(0);
    registry.unbind({ sessionId: "never-bound" });
    expect(registry.size()).toBe(0);
    // 非法键（空 sessionId）bind/resolve 恒 no-op/null。
    registry.bind({ sessionId: "  ", accountId: "acct" });
    expect(registry.size()).toBe(0);
    expect(registry.resolve({ sessionId: "" })).toBeNull();
  });

  it("omnicode 门控关 → bind 恒 no-op、resolve 恒 null（官方零内存占用）", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOff });
    registry.bind({ sessionId: "task-1", accountId: "acct-1" });
    expect(registry.size()).toBe(0);
    expect(registry.resolve({ sessionId: "task-1" })).toBeNull();
    expect(registry.isActive()).toBe(false);
  });

  it("有界 LRU-by-resolve：超容量淘汰最久未 resolve 的绑定、最新绑定存活（R3.5 容量 512→2048）", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    for (let index = 0; index < 2056; index += 1) {
      registry.bind({ sessionId: `task-${index}`, accountId: `acct-${index}` });
    }
    expect(registry.size()).toBe(2048);
    // task-0..task-7 为最久未 resolve 的 8 条 → 被新绑定挤出。
    expect(registry.resolve({ sessionId: "task-0" })).toBeNull();
    expect(registry.resolve({ sessionId: "task-7" })).toBeNull();
    expect(registry.resolve({ sessionId: "task-8" })).toBe("acct-8");
    expect(registry.resolve({ sessionId: "task-2055" })).toBe("acct-2055");
  });

  it("LRU-by-resolve：resolve 命中即 touch——活跃绑定不被后续新绑定淘汰（终审 P2-1）", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    registry.bind({ sessionId: "task-active", accountId: "acct-active" });
    // 活跃会话每请求凭据解析都 resolve 命中（touch 移队尾）。
    for (let round = 0; round < 2100; round += 1) {
      registry.bind({ sessionId: `task-${round}`, accountId: `acct-${round}` });
      registry.resolve({ sessionId: "task-active" });
    }
    // 2048 上限满，但活跃绑定每轮都被 touch → 永不淘汰（计费归属不漂移）。
    expect(registry.size()).toBe(2048);
    expect(registry.resolve({ sessionId: "task-active" })).toBe("acct-active");
    // 从未 resolve 的最早绑定早已按 LRU 序被淘汰。
    expect(registry.resolve({ sessionId: "task-0" })).toBeNull();
    // 最老的未活跃绑定（task-0..task-52，共 53 条=首条 active 占位+每轮挤出 1 条）
    // 已被挤出；窗口内最老存活 = task-53；2100 轮最后一轮 task-2099 重 bind 覆盖自身。
    expect(registry.resolve({ sessionId: "task-2099" })).toBe("acct-2099");
    expect(registry.resolve({ sessionId: "task-53" })).toBe("acct-53");
    expect(registry.resolve({ sessionId: "task-52" })).toBeNull();
  });

  it("LRU 淘汰序以最近 resolve 为准而非 bind 序：老绑定后 resolve 反超新绑定", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    registry.bind({ sessionId: "task-old", accountId: "acct-old" });
    for (let index = 0; index < 2048; index += 1) {
      registry.bind({ sessionId: `task-${index}`, accountId: `acct-${index}` });
    }
    // task-old 早已被挤出（2048 条新绑定后）。
    expect(registry.resolve({ sessionId: "task-old" })).toBeNull();
    // 重新绑定后立刻 resolve touch，再灌满新绑定 → 仍存活。
    registry.bind({ sessionId: "task-old", accountId: "acct-old" });
    registry.resolve({ sessionId: "task-old" });
    registry.bind({ sessionId: "task-extra", accountId: "acct-extra" });
    expect(registry.resolve({ sessionId: "task-old" })).toBe("acct-old");
    // 队首（最久未 resolve）= task-0（此后无 touch）被挤出。
    expect(registry.resolve({ sessionId: "task-0" })).toBeNull();
  });
});

describe("模式二 R1.5：作用域包裹执行器", () => {
  it("未绑定 accountId → 官方上下文执行（作用域未激活）", async () => {
    const result = await runWithOmnicodeSessionAccountScope({
      accountId: null,
      gateActive: true,
      fn: async () => getOmnicodeAccountScopeAccountId(),
    });
    expect(result).toBeNull();
  });

  it("门控关 → 官方上下文执行（即便有绑定）", async () => {
    const result = await runWithOmnicodeSessionAccountScope({
      accountId: "omni-acct-alpha",
      gateActive: false,
      fn: async () => getOmnicodeAccountScopeAccountId(),
    });
    expect(result).toBeNull();
  });

  it("绑定且门控开 → fn 内作用域绑定该账号；跨 await 续体保持作用域", async () => {
    const result = await runWithOmnicodeSessionAccountScope({
      accountId: "omni-acct-alpha",
      gateActive: true,
      fn: async () => {
        expect(getOmnicodeAccountScopeAccountId()).toBe("omni-acct-alpha");
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(getOmnicodeAccountScopeAccountId()).toBe("omni-acct-alpha");
        return getOmnicodeAccountScopeAccountId();
      },
    });
    expect(result).toBe("omni-acct-alpha");
    // 作用域只在 fn 内生效，返回后回到官方上下文。
    expect(getOmnicodeAccountScopeAccountId()).toBeNull();
  });

  it("gateActive 缺省读 OMNICODE_PROFILE_ID env（与 R1 门控同源）", async () => {
    const previous = process.env.OMNICODE_PROFILE_ID;
    try {
      delete process.env.OMNICODE_PROFILE_ID;
      const unwrapped = await runWithOmnicodeSessionAccountScope({
        accountId: "omni-acct-alpha",
        fn: async () => getOmnicodeAccountScopeAccountId(),
      });
      expect(unwrapped).toBeNull();
      process.env.OMNICODE_PROFILE_ID = "profile-1";
      const wrapped = await runWithOmnicodeSessionAccountScope({
        accountId: "omni-acct-alpha",
        fn: async () => getOmnicodeAccountScopeAccountId(),
      });
      expect(wrapped).toBe("omni-acct-alpha");
    } finally {
      if (previous === undefined) delete process.env.OMNICODE_PROFILE_ID;
      else process.env.OMNICODE_PROFILE_ID = previous;
    }
  });
});

describe("模式二 R1.5：registry→决策→作用域→覆盖边界 端到端纯接线", () => {
  function buildOverride(materials: Map<string, OmnicodeAccountOverrideMaterial | null>) {
    let fallbackCalls = 0;
    const override = createOmnicodeAccountOverride({
      materialProvider: {
        load: async (accountId) => materials.get(accountId) ?? null,
      },
      isActive: gateOn,
    });
    return {
      override,
      fallbackCallCount: () => fallbackCalls,
      fallback: () => {
        fallbackCalls += 1;
        return Promise.resolve(null);
      },
    };
  }

  it("绑定会话 → 覆盖边界按附加账号材料作答，官方 fallback 不触", async () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    const materials = new Map([["omni-acct-alpha", materialFixture()]]);
    const { override, fallbackCallCount, fallback } = buildOverride(materials);
    registry.bind({ workspaceKey: "ws-a", sessionId: "task-1", accountId: "omni-acct-alpha" });

    const accountId = registry.resolve({ workspaceKey: "ws-a", sessionId: "task-1" });
    const startPlan = await runWithOmnicodeSessionAccountScope({
      accountId,
      gateActive: registry.isActive(),
      fn: () => override.loadStartPlanMaterial("zai", fallback),
    });
    expect(startPlan?.zcodeJwtToken).toBe(syntheticFixture("start-plan-jwt"));
    expect(fallbackCallCount()).toBe(0);
  });

  it("未绑定会话 → 官方 fallback 原样触发（行为逐字不变）", async () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    const materials = new Map([["omni-acct-alpha", materialFixture()]]);
    const { override, fallbackCallCount, fallback } = buildOverride(materials);

    const accountId = registry.resolve({ workspaceKey: "ws-a", sessionId: "task-x" });
    const startPlan = await runWithOmnicodeSessionAccountScope({
      accountId,
      gateActive: registry.isActive(),
      fn: () => override.loadStartPlanMaterial("zai", fallback),
    });
    expect(startPlan).toBeNull();
    expect(fallbackCallCount()).toBe(1);
  });

  it("绑定但材料缺失 → fail-closed null（绝不回落主账号材料）", async () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    const { override, fallbackCallCount, fallback } = buildOverride(new Map());
    registry.bind({ sessionId: "task-1", accountId: "omni-acct-missing" });

    const accountId = registry.resolve({ sessionId: "task-1" });
    const startPlan = await runWithOmnicodeSessionAccountScope({
      accountId,
      gateActive: registry.isActive(),
      fn: () => override.loadStartPlanMaterial("zai", fallback),
    });
    expect(startPlan).toBeNull();
    expect(fallbackCallCount()).toBe(0);
  });
});

describe("模式二 R2 预留：bridge-proxy 附加账号材料协议占位", () => {
  it("请求载荷 schema：合法 accountId 通过；路径穿越形态拒绝", () => {
    const request = {
      type: "omnicode-account-material-request",
      requestId: "req-1",
      request: { accountId: "omni-acct-alpha" },
    };
    const parsed = hostResponseMessageSchema.parse(request);
    expect(parsed.type).toBe("omnicode-account-material-request");
    expect(
      hostResponseMessageSchema.safeParse({
        ...request,
        request: { accountId: "../escape" },
      }).success,
    ).toBe(false);
    expect(
      hostResponseMessageSchema.safeParse({
        ...request,
        request: { accountId: "" },
      }).success,
    ).toBe(false);
  });

  it("应答占位（ok=false 结构化错误）过 main→host union；ok=true 需 dataBase64 形态", () => {
    const placeholderReply = {
      type: "omnicode-account-material-result",
      requestId: "req-1",
      ok: false,
      error: "omnicode_account_material_unavailable",
    };
    expect(hostIncomingMessageSchema.parse(placeholderReply).type).toBe(
      "omnicode-account-material-result",
    );
    expect(
      hostIncomingMessageSchema.safeParse({ ...placeholderReply, extra: 1 }).success,
    ).toBe(false);
    const materialReply = {
      type: "omnicode-account-material-result",
      requestId: "req-1",
      ok: true,
      dataBase64: Buffer.from("{}", "utf8").toString("base64"),
    };
    expect(hostIncomingMessageSchema.parse(materialReply).type).toBe(
      "omnicode-account-material-result",
    );
  });
});

// [OmniCode] 2026-11-28 紧急修复配套：绑定来源（explicit/smart）入册 + resolveEntry。
// 真机实证：智能调度把 bigmodel 附加账号绑到 zai-start-plan 会话 → override fail-closed
// → 凭据不可用永久卡死；自愈处置需区分来源（smart 释放回落，explicit 保持红线）。
describe("omnicode session account scope: bind source + resolveEntry", () => {
  it("bind 缺省 source=explicit；显式传 smart 入册；resolveEntry 带来源且 touch 语义同 resolve", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: () => true });
    registry.bind({ sessionId: "s1", accountId: "acct-a" });
    expect(registry.resolveEntry({ sessionId: "s1" })).toEqual({
      accountId: "acct-a",
      source: "explicit",
    });
    registry.bind({ sessionId: "s2", accountId: "acct-b", source: "smart" });
    expect(registry.resolveEntry({ sessionId: "s2" })).toEqual({
      accountId: "acct-b",
      source: "smart",
    });
    // resolve 仍返回 accountId（旧消费方零改动）
    expect(registry.resolve({ sessionId: "s2" })).toBe("acct-b");
    // 门控关 → bind no-op
    const off = createOmnicodeSessionAccountRegistry({ isActive: () => false });
    off.bind({ sessionId: "s3", accountId: "acct-c", source: "smart" });
    expect(off.resolveEntry({ sessionId: "s3" })).toBeNull();
  });

  it("重复绑定覆盖旧值含来源（smart 覆盖 explicit 反之亦然）；unbind 清条目", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: () => true });
    registry.bind({ sessionId: "s4", accountId: "acct-x", source: "smart" });
    registry.bind({ sessionId: "s4", accountId: "acct-y" });
    expect(registry.resolveEntry({ sessionId: "s4" })).toEqual({
      accountId: "acct-y",
      source: "explicit",
    });
    registry.unbindBySessionId("s4");
    expect(registry.resolveEntry({ sessionId: "s4" })).toBeNull();
  });
});

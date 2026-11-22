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

  it("有界 FIFO：最旧绑定淘汰、最新绑定存活", () => {
    const registry = createOmnicodeSessionAccountRegistry({ isActive: gateOn });
    for (let index = 0; index < 520; index += 1) {
      registry.bind({ sessionId: `task-${index}`, accountId: `acct-${index}` });
    }
    expect(registry.size()).toBe(512);
    expect(registry.resolve({ sessionId: "task-0" })).toBeNull();
    expect(registry.resolve({ sessionId: "task-7" })).toBeNull();
    expect(registry.resolve({ sessionId: "task-8" })).toBe("acct-8");
    expect(registry.resolve({ sessionId: "task-519" })).toBe("acct-519");
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

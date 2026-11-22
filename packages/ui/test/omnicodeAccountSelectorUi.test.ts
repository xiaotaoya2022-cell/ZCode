// [OmniCode] 模式二 R3 选择器账号层 / 徽标纯逻辑单测（spec:
// docs/omnicode/multi-account-sessions.md §6/§7）：
// - buildComposerOmnicodeAccountGroups：主账号行固定第一、附加账号目录序、槽位徽标携带、
//   空目录（仅主账号行）、空槽位（无徽标字段）；
// - 会话账号选择 store：scopeKey 形态、读写往返、null=回主账号、订阅通知、scope 隔离；
// - 显示名解析：命中/未命中（目录晚到自愈形态）/主账号 null；
// - 门控两态的纯判定输入：目录空/桥缺席 → 账号层不渲染（useOmnicodeComposerAccountMenu
//   的 useMemo 判定分支以纯逻辑等价锁定）。
import { describe, expect, it, vi } from "vitest";
import {
  buildComposerOmnicodeAccountGroups,
  OMNICODE_ACCOUNT_GROUP_KEY_PREFIX,
} from "@/lib/composerPlanGroups.js";
import {
  omnicodeAccountScopeKey,
  readOmnicodeAccountSelection,
  resolveOmnicodeAccountDisplayName,
  subscribeOmnicodeAccountSelection,
  writeOmnicodeAccountSelection,
} from "@/omnicode/omnicodeAccountUi.js";

const entryA = {
  accountId: "acct-p0r3test01",
  sourceProfileId: "p0r3test01",
  family: "zai" as const,
  displayName: "工作号",
};
const entryB = {
  accountId: "acct-p0r3test02",
  sourceProfileId: "p0r3test02",
  family: "bigmodel" as const,
  displayName: "生活号",
};

describe("模式二 R3 buildComposerOmnicodeAccountGroups", () => {
  it("主账号行固定第一；附加账号按目录序；槽位徽标随行携带", () => {
    const groups = buildComposerOmnicodeAccountGroups({
      accounts: [entryA, entryB],
      slots: [{ accountId: entryA.accountId, running: 1, limit: 3 }],
      primaryLabel: "主账号",
    });
    expect(groups[0]).toMatchObject({
      key: `${OMNICODE_ACCOUNT_GROUP_KEY_PREFIX}primary`,
      account: { accountId: null, displayName: "主账号" },
    });
    expect(groups.map((group) => group.account.accountId)).toEqual([
      null,
      entryA.accountId,
      entryB.accountId,
    ]);
    expect(groups[1]?.account).toMatchObject({ running: 1, limit: 3 });
    // 无槽位数据的账号不带徽标字段。
    expect("running" in (groups[2]?.account ?? {})).toBe(false);
  });

  it("空目录 → 仅主账号行（仍可显示主账号标签）", () => {
    const groups = buildComposerOmnicodeAccountGroups({
      accounts: [],
      slots: [],
      primaryLabel: "主账号",
    });
    expect(groups.length).toBe(1);
    expect(groups[0]?.account.accountId).toBeNull();
  });
});

describe("模式二 R3 会话账号选择 store", () => {
  it("scopeKey 形态：workspacePath+identity+sessionId|draft", () => {
    expect(
      omnicodeAccountScopeKey({ workspacePath: "F:\\work", sessionId: null }),
    ).toBe("F:\\work\u0000\u0000draft");
    expect(
      omnicodeAccountScopeKey({
        workspacePath: "F:\\work",
        workspaceIdentity: "remote:x",
        sessionId: "t1",
      }),
    ).toBe("F:\\work\u0000remote:x\u0000t1");
  });

  it("读写往返；null 写回 = 回主账号（删除登记）", () => {
    const scopeKey = omnicodeAccountScopeKey({ workspacePath: "F:\\work", sessionId: "t9" });
    writeOmnicodeAccountSelection(scopeKey, entryA.accountId);
    expect(readOmnicodeAccountSelection(scopeKey)).toBe(entryA.accountId);
    writeOmnicodeAccountSelection(scopeKey, null);
    expect(readOmnicodeAccountSelection(scopeKey)).toBeNull();
  });

  it("scope 隔离 + 订阅通知", () => {
    const scope1 = omnicodeAccountScopeKey({ workspacePath: "F:\\a", sessionId: "t1" });
    const scope2 = omnicodeAccountScopeKey({ workspacePath: "F:\\b", sessionId: "t1" });
    const listener = vi.fn();
    const unsubscribe = subscribeOmnicodeAccountSelection(listener);
    try {
      writeOmnicodeAccountSelection(scope1, entryB.accountId);
      expect(listener).toHaveBeenCalled();
      expect(readOmnicodeAccountSelection(scope2)).toBeNull();
    } finally {
      unsubscribe();
    }
    // 退订后不再通知。
    const callsBefore = listener.mock.calls.length;
    writeOmnicodeAccountSelection(scope1, null);
    expect(listener.mock.calls.length).toBe(callsBefore);
  });
});

describe("模式二 R3 显示名解析（徽标/选择器共用）", () => {
  it("命中返回显示名；主账号 null → null；未命中（目录晚到）→ null", () => {
    expect(resolveOmnicodeAccountDisplayName(entryA.accountId, [entryA, entryB])).toBe("工作号");
    expect(resolveOmnicodeAccountDisplayName(null, [entryA])).toBeNull();
    expect(resolveOmnicodeAccountDisplayName("acct-pmissing", [entryA])).toBeNull();
  });
});

describe("模式二 R3 选择器账号层门控两态（纯判定等价）", () => {
  it("目录空 / 桥缺席 → 账号层不渲染（undefined）；非空且桥可用 → 返回菜单", () => {
    const buildMenu = (input: {
      bridgeAvailable: boolean;
      accounts: readonly typeof entryA[];
    }) =>
      input.bridgeAvailable && input.accounts.length > 0
        ? { groups: buildComposerOmnicodeAccountGroups({
            accounts: input.accounts,
            slots: [],
            primaryLabel: "主账号",
          }) }
        : undefined;
    expect(buildMenu({ bridgeAvailable: false, accounts: [entryA] })).toBeUndefined();
    expect(buildMenu({ bridgeAvailable: true, accounts: [] })).toBeUndefined();
    const menu = buildMenu({ bridgeAvailable: true, accounts: [entryA] });
    expect(menu?.groups[0]?.account.accountId).toBeNull();
    expect(menu?.groups[1]?.account.accountId).toBe(entryA.accountId);
  });
});

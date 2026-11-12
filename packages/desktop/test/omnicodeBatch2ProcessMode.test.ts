// [OmniCode] 批次2 B2-1 单测：进程模式判据 / 工作区路由决策 / 收养可用性与命名（纯函数）。
// spec: docs/omnicode/profile-runtime.md §批次2：进程模式与身份（D7）。
import { describe, expect, it } from "vitest";
import {
  isOmnicodeManagerProcess,
  isOmnicodeProfileInstanceEnv,
  resolveOmnicodeInstanceIdFromEnv,
} from "@zcode/shared";
import {
  nextOmnicodeAdoptionProfileName,
  resolveOmnicodeConsoleAdoptionAvailable,
  resolveOmnicodeWorkspaceOpenRoute,
} from "../src/main/omnicode/profileRuntime.js";

describe("omnicode batch2 process mode (D7)", () => {
  it("resolveOmnicodeInstanceIdFromEnv 仅认白名单 profileId，空/非法归一 null", () => {
    expect(resolveOmnicodeInstanceIdFromEnv({ OMNICODE_PROFILE_ID: "pabc123def4" })).toBe(
      "pabc123def4",
    );
    expect(resolveOmnicodeInstanceIdFromEnv({ OMNICODE_PROFILE_ID: "pabc" })).toBeNull();
    expect(resolveOmnicodeInstanceIdFromEnv({ OMNICODE_PROFILE_ID: "xabc123def4" })).toBeNull();
    expect(resolveOmnicodeInstanceIdFromEnv({ OMNICODE_PROFILE_ID: "  " })).toBeNull();
    expect(resolveOmnicodeInstanceIdFromEnv({})).toBeNull();
    expect(resolveOmnicodeInstanceIdFromEnv({ OMNICODE_PROFILE_ID: " pabc123def4 " })).toBe(
      "pabc123def4",
    );
  });

  it("isOmnicodeManagerProcess：omnicode flavor ∧ 无实例身份（官方 flavor 恒 false）", () => {
    expect(isOmnicodeManagerProcess("omnicode", {})).toBe(true);
    expect(isOmnicodeManagerProcess("omnicode", { OMNICODE_PROFILE_ID: "pabc123def4" })).toBe(
      false,
    );
    expect(isOmnicodeManagerProcess("omnicode", { OMNICODE_PROFILE_ID: "bad" })).toBe(true);
    expect(isOmnicodeManagerProcess("production", {})).toBe(false);
    expect(isOmnicodeManagerProcess("preview", { OMNICODE_PROFILE_ID: "pabc123def4" })).toBe(
      false,
    );
  });

  it("isOmnicodeProfileInstanceEnv 与新判据对非法 id 的口径一致（非法=非实例）", () => {
    expect(isOmnicodeProfileInstanceEnv({ OMNICODE_PROFILE_ID: "pabc123def4" })).toBe(true);
    expect(isOmnicodeProfileInstanceEnv({ OMNICODE_PROFILE_ID: "bad" })).toBe(false);
    expect(resolveOmnicodeInstanceIdFromEnv({ OMNICODE_PROFILE_ID: "bad" })).toBeNull();
  });
});

describe("omnicode batch2 workspace open route (T4)", () => {
  it("恰一实例直转 / 多实例进选择 / 零实例引导新建", () => {
    expect(resolveOmnicodeWorkspaceOpenRoute([])).toEqual({ kind: "none" });
    expect(resolveOmnicodeWorkspaceOpenRoute(["p1111111111"])).toEqual({
      kind: "single",
      profileId: "p1111111111",
    });
    expect(resolveOmnicodeWorkspaceOpenRoute(["p1111111111", "p2222222222"])).toEqual({
      kind: "choose",
      profileIds: ["p1111111111", "p2222222222"],
    });
  });
});

describe("omnicode batch2 console adoption (T5)", () => {
  it("无凭据或已被收养 → 不可收养", () => {
    expect(resolveOmnicodeConsoleAdoptionAvailable(false, [])).toBe(false);
    expect(resolveOmnicodeConsoleAdoptionAvailable(true, ["~/.omnicode/console"])).toBe(false);
  });

  it("有凭据且未被收养 → 可收养", () => {
    expect(resolveOmnicodeConsoleAdoptionAvailable(true, [])).toBe(true);
  });

  it("收养默认名被占用时自增避让（大小写不敏感，与 clone 风格一致）", () => {
    expect(nextOmnicodeAdoptionProfileName([], "实例-收养")).toBe("实例-收养");
    expect(nextOmnicodeAdoptionProfileName(["其他"], "实例-收养")).toBe("实例-收养");
    expect(nextOmnicodeAdoptionProfileName(["实例-收养"], "实例-收养")).toBe("实例-收养 2");
    expect(
      nextOmnicodeAdoptionProfileName(["实例-收养", "实例-收养 2"], "实例-收养"),
    ).toBe("实例-收养 3");
    expect(nextOmnicodeAdoptionProfileName(["INSTANCE-ADOPTED"], "Instance-Adopted")).toBe(
      "Instance-Adopted 2",
    );
  });
});

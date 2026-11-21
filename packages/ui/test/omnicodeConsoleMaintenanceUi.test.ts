// [OmniCode] 新功能批次（2026-11-21 审计会话）单测：管理器维护面纯函数（ui/console 域）。
// - filterOmnicodeInstancesForQuery：名称子串（大小写不敏感）/seq 序号整串（"3" 不匹配
//   13；"#3" 输入也按序号匹配——grid 侧 input 原样传入，这里锁定数字形态判定）/
//   空查询全量/无匹配空集；
// - formatOmnicodeByteSize：B 整数阶/KB..TB 阶梯/负数与 NaN 出占位；
// - groupOmnicodeWorkspaceLocksByHolder：按持有者聚合（displayName 缺省回退 profileId）、
//   同持有多工作区聚合、组间组内保持入参顺序。
import { describe, expect, it } from "vitest";
import type { OmnicodeProfileSummaryInfo, OmnicodeWorkspaceLockSummaryEntry } from "@zcode/shared";
import { filterOmnicodeInstancesForQuery } from "@/console/instanceGridFilter.js";
import {
  formatOmnicodeByteSize,
  groupOmnicodeWorkspaceLocksByHolder,
} from "@/console/consoleMaintenanceModel.js";

function profile(overrides: Partial<OmnicodeProfileSummaryInfo> = {}): OmnicodeProfileSummaryInfo {
  return {
    id: "paaaaaaaa",
    name: "工作实例",
    createdAt: "2026-11-01T00:00:00.000Z",
    running: false,
    seq: 1,
    ...overrides,
  };
}

describe("新功能批次：实例网格过滤", () => {
  const profiles = [
    profile({ id: "pa", name: "Frontend Dev", seq: 1 }),
    profile({ id: "pb", name: "后端调试", seq: 3 }),
    profile({ id: "pc", name: "13号实验", seq: 13 }),
    profile({ id: "pd", name: "文档", seq: 31 }),
  ];

  it("空查询=全量；名称子串大小写不敏感（含中文）", () => {
    expect(filterOmnicodeInstancesForQuery(profiles, "  ")).toHaveLength(4);
    expect(filterOmnicodeInstancesForQuery(profiles, "frontend").map((p) => p.id)).toEqual(["pa"]);
    expect(filterOmnicodeInstancesForQuery(profiles, "后端").map((p) => p.id)).toEqual(["pb"]);
    expect(filterOmnicodeInstancesForQuery(profiles, "DEV").map((p) => p.id)).toEqual(["pa"]);
  });

  it("序号整串匹配是 OR 语义：'3' 命中 #3 与名称含 '3' 的实例；'13' 只命中名称与 #13", () => {
    // "3"：pb=seq 3；pc=名称"13号实验"含"3"（名称子串）——两者都命中是预期 OR 语义
    expect(filterOmnicodeInstancesForQuery(profiles, "3").map((p) => p.id)).toEqual(["pb", "pc"]);
    // "13"：pc=名称含"13"且 seq=13；pd seq=31 不中（序号整串不前缀匹配）
    expect(filterOmnicodeInstancesForQuery(profiles, "13").map((p) => p.id)).toEqual(["pc"]);
    expect(filterOmnicodeInstancesForQuery(profiles, "31").map((p) => p.id)).toEqual(["pd"]);
    expect(filterOmnicodeInstancesForQuery(profiles, "99")).toEqual([]);
  });

  it("序号缺失的实例不被数字查询命中；无匹配空集；名称与序号都不命中时为空", () => {
    const noSeq = [profile({ id: "pe", name: "无序号", seq: undefined })];
    expect(filterOmnicodeInstancesForQuery(noSeq, "1")).toEqual([]);
    expect(filterOmnicodeInstancesForQuery(profiles, "不存在")).toEqual([]);
  });
});

describe("新功能批次：字节格式化", () => {
  it("B 整数阶与 KB..TB 阶梯；非合法输入出占位", () => {
    expect(formatOmnicodeByteSize(0)).toBe("0 B");
    expect(formatOmnicodeByteSize(1023)).toBe("1023 B");
    expect(formatOmnicodeByteSize(1024)).toBe("1 KB");
    expect(formatOmnicodeByteSize(1536)).toBe("1.5 KB");
    expect(formatOmnicodeByteSize(1024 * 1024 * 123)).toBe("123 MB");
    expect(formatOmnicodeByteSize(1024 ** 4)).toBe("1 TB");
    expect(formatOmnicodeByteSize(-1)).toBe("—");
    expect(formatOmnicodeByteSize(Number.NaN)).toBe("—");
  });
});

describe("新功能批次：锁占用按持有者分组", () => {
  function lock(overrides: Partial<OmnicodeWorkspaceLockSummaryEntry> = {}): OmnicodeWorkspaceLockSummaryEntry {
    return {
      workspacePath: "F:\\work\\demo",
      profileId: "paaaaaaaa",
      pid: 1234,
      displayName: "实例A",
      ...overrides,
    };
  }

  it("同持有多工作区聚合为一组；displayName 缺省回退 profileId；保持入参顺序", () => {
    const groups = groupOmnicodeWorkspaceLocksByHolder([
      lock({ workspacePath: "F:\\a", profileId: "pa", displayName: "实例A" }),
      lock({ workspacePath: "F:\\b", profileId: "pb", displayName: undefined }),
      lock({ workspacePath: "F:\\c", profileId: "pa", displayName: "实例A" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ holderLabel: "实例A", profileId: "pa" });
    expect(groups[0].entries.map((e) => e.workspacePath)).toEqual(["F:\\a", "F:\\c"]);
    expect(groups[1]).toMatchObject({ holderLabel: "pb", profileId: "pb" });
    expect(groups[1].entries).toHaveLength(1);
  });

  it("displayName 空串按缺省回退（trim 语义）；空列表出空组", () => {
    const groups = groupOmnicodeWorkspaceLocksByHolder([
      lock({ profileId: "pc", displayName: "   " }),
    ]);
    expect(groups[0].holderLabel).toBe("pc");
    expect(groupOmnicodeWorkspaceLocksByHolder([])).toEqual([]);
  });
});

// [OmniCode] 新功能批次（2026-11-21 审计会话）单测：托盘快捷编排模型——平铺全部/还原
// 窗口双标签（中英）随既有实例区模型输出，实例项与启停全部语义零回归
//（omnicodeBatch25Extras.test.ts 已覆盖原模型；这里只锁新增字段）。
import { describe, expect, it } from "vitest";
import { buildOmnicodeTraySectionModel } from "../src/main/omnicode/trayMenu.js";

describe("新功能批次：托盘快捷编排模型", () => {
  it("平铺/还原双标签随模型输出（中英双語）", () => {
    const zh = buildOmnicodeTraySectionModel({
      instances: [{ profileId: "pa", name: "工作" }],
      profileCount: 2,
      isZh: true,
    });
    expect(zh.arrangeAllLabel).toBe("平铺全部窗口");
    expect(zh.restoreAllLabel).toBe("还原窗口位置");
    const en = buildOmnicodeTraySectionModel({ instances: [], profileCount: 0, isZh: false });
    expect(en.arrangeAllLabel).toBe("Arrange all windows");
    expect(en.restoreAllLabel).toBe("Restore window positions");
  });

  it("既有模型语义零回归（实例项/启停全部 enabled）", () => {
    const model = buildOmnicodeTraySectionModel({
      instances: [
        { profileId: "pa", name: "A" },
        { profileId: "pb", name: "B" },
      ],
      profileCount: 3,
      isZh: true,
    });
    expect(model.instanceItems).toEqual([
      { profileId: "pa", label: "● A" },
      { profileId: "pb", label: "● B" },
    ]);
    expect(model.launchAllEnabled).toBe(true);
    expect(model.stopAllEnabled).toBe(true);
    const empty = buildOmnicodeTraySectionModel({ instances: [], profileCount: 0, isZh: true });
    expect(empty.launchAllEnabled).toBe(false);
    expect(empty.stopAllEnabled).toBe(false);
  });
});

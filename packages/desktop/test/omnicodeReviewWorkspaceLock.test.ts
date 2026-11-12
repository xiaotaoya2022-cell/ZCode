// [OmniCode] B2 评审修复单测（锁域）：观察者 tab 升级可写（P1-1）+ 锁 displayName 链路（C5/P1-5）。
// spec: docs/omnicode/profile-runtime.md §批次2 D8（B2 评审修复修订）。
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireWorkspaceLock,
  assertWorkspaceNotLockedByOther,
  getWorkspaceLockHash,
  listWorkspaceLockDecorations,
  readWorkspaceLockOwner,
} from "../../services/src/omnicode/workspaceLocks.js";
import { createTabStore, isWorkspaceTabObserver } from "../../ui/src/store/tabStore.js";
import { collectOpenLocalWorkspacePaths } from "../../ui/src/hooks/useTabPersistence.js";

const SELF = "pself00001";
const OTHER = "pother0001";

let sharedRoot: string;

beforeEach(() => {
  sharedRoot = mkdtempSync(join(tmpdir(), "omnicode-review-lock-"));
  process.env.OMNICODE_SHARED_ROOT = sharedRoot;
});

afterEach(() => {
  delete process.env.OMNICODE_SHARED_ROOT;
  rmSync(sharedRoot, { recursive: true, force: true });
});

describe("omnicode review fix P1-1: observer tab upgrade to writable", () => {
  const WORKSPACE = "C:\\ws\\observer-demo";

  it("观察者打开 → 正常打开（守卫放行）→ 观察者标记清除且锁集合恢复包含该工作区", () => {
    const store = createTabStore();
    // 1) 只读观察者打开（锁冲突对话框「只读打开」路径）
    const observerTabId = store.getState().addTab(WORKSPACE, {
      omnicodeObserver: { holderProfileId: OTHER, holderDisplayName: "工作号 A" },
    });
    const observerTab = store.getState().tabs.find((tab) => tab.id === observerTabId);
    expect(observerTab).toBeDefined();
    expect(isWorkspaceTabObserver(observerTab!)).toBe(true);
    // 观察者 tab 不进锁集合（既有语义回归）
    expect(collectOpenLocalWorkspacePaths(store.getState())).toEqual([]);

    // 2) 锁释放后正常打开：handleSelectProject 成功分支先 clear 再 addTab（merge 复用同 tab）
    store.getState().clearOmnicodeObserver(WORKSPACE);
    store.getState().addTab(WORKSPACE);
    const upgradedTab = store.getState().tabs.find((tab) => tab.id === observerTabId);
    expect(upgradedTab).toBeDefined();
    expect(isWorkspaceTabObserver(upgradedTab!)).toBe(false);
    // 清除后锁集合采集恢复包含该工作区（Host 协调器据此获取锁，双开缺口封死）
    expect(collectOpenLocalWorkspacePaths(store.getState())).toEqual([WORKSPACE]);
  });

  it("未清除时 merge 保留观察者标记（缺陷现状锁定：clear 是升级链路的必要步骤）", () => {
    const store = createTabStore();
    store.getState().addTab(WORKSPACE, { omnicodeObserver: { holderProfileId: OTHER } });
    store.getState().addTab(WORKSPACE);
    const tab = store.getState().tabs[0];
    expect(isWorkspaceTabObserver(tab!)).toBe(true);
    expect(collectOpenLocalWorkspacePaths(store.getState())).toEqual([]);
  });

  it("clearOmnicodeObserver 幂等：非观察者/不存在路径无副作用", () => {
    const store = createTabStore();
    store.getState().addTab("C:\\ws\\plain");
    const before = store.getState().tabs;
    store.getState().clearOmnicodeObserver("C:\\ws\\not-open");
    store.getState().clearOmnicodeObserver("C:\\ws\\plain");
    expect(store.getState().tabs).toBe(before); // 无变更不产生新引用
  });
});

describe("omnicode review fix C5/P1-5: lock displayName chain", () => {
  // sharedRoot 在 beforeEach 才建——路径一律用例内计算
  const namedWorkspace = (): string => join(sharedRoot, "ws-named");
  const DISPLAY_NAME = "工作号 B";

  it("acquire 带 displayName → 锁文件/owner/装饰携带；老锁（无 displayName）回退 undefined", () => {
    expect(acquireWorkspaceLock(namedWorkspace(), OTHER, process.pid, DISPLAY_NAME).ok).toBe(true);
    const entry = JSON.parse(
      readFileSync(
        join(sharedRoot, "workspace-locks", `${getWorkspaceLockHash(namedWorkspace())}.json`),
        "utf8",
      ),
    ) as { profileId: string; displayName?: string };
    expect(entry.profileId).toBe(OTHER);
    expect(entry.displayName).toBe(DISPLAY_NAME);

    const owner = readWorkspaceLockOwner(namedWorkspace());
    expect(owner?.profileId).toBe(OTHER);
    expect(owner?.displayName).toBe(DISPLAY_NAME);

    const decoration = listWorkspaceLockDecorations().find((item) => item.workspacePath === namedWorkspace());
    expect(decoration).toMatchObject({ profileId: OTHER, displayName: DISPLAY_NAME, ownedBySelf: false });

    // 老锁文件兼容：无 displayName 的锁 → 装饰/owner 缺省该字段（UI 回退 profileId）
    const legacyWorkspace = join(sharedRoot, "ws-legacy");
    expect(acquireWorkspaceLock(legacyWorkspace, SELF, process.pid).ok).toBe(true);
    const legacyOwner = readWorkspaceLockOwner(legacyWorkspace);
    expect(legacyOwner?.profileId).toBe(SELF);
    expect(legacyOwner?.displayName).toBeUndefined();
  });

  it("结构化拒绝错误 data 携带 displayName（锁冲突对话框展示实例名的数据源）", () => {
    expect(acquireWorkspaceLock(namedWorkspace(), OTHER, process.pid, DISPLAY_NAME).ok).toBe(true);
    let caught: unknown;
    try {
      assertWorkspaceNotLockedByOther(namedWorkspace(), SELF);
    } catch (error) {
      caught = error;
    }
    const coded = caught as {
      code?: string;
      message?: string;
      data?: { profileId: string; displayName?: string };
    } | undefined;
    expect(coded?.code).toBe("omnicode.workspace-locked-by-other");
    expect(coded?.data?.profileId).toBe(OTHER);
    expect(coded?.data?.displayName).toBe(DISPLAY_NAME);
    // 用户可读 message 同时含实例名与 profileId
    expect(coded?.message).toContain(DISPLAY_NAME);
    expect(coded?.message).toContain(OTHER);
  });

  it("displayName 非法值（空串/超长/非字符串）不写入锁文件", () => {
    const longName = "x".repeat(121);
    expect(acquireWorkspaceLock(join(sharedRoot, "ws-bad-1"), SELF, process.pid, "   ").ok).toBe(true);
    expect(acquireWorkspaceLock(join(sharedRoot, "ws-bad-2"), SELF, process.pid, longName).ok).toBe(true);
    expect(readWorkspaceLockOwner(join(sharedRoot, "ws-bad-1"))?.displayName).toBeUndefined();
    expect(readWorkspaceLockOwner(join(sharedRoot, "ws-bad-2"))?.displayName).toBeUndefined();
  });
});

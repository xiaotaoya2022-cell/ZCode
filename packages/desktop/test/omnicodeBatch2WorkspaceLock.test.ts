// [OmniCode] 批次2 B2-2 单测：工作区锁全入口强制 + 只读观察者模式（spec: docs/omnicode/profile-runtime.md §批次2 D8）。
// 覆盖：① 守卫判定纯函数（无锁/自持/他持拒绝/他持+观察者）② assertWorkspaceNotLockedByOther
// 结构化拒绝与无主锁懒清理 ③ 锁装饰 ownedBySelf 判定（restore 预检数据源）与锁 hash
// 大小写/尾分隔符归一 ④ workspaceLockCoordinator 多 tab 集合对账（获取/释放/判负不夺锁/dispose 全释放）。
// 锁目录经 OMNICODE_SHARED_ROOT 指向临时目录（getOmnicodeSharedRoot 每次调用现读 env）。
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireWorkspaceLock,
  assertWorkspaceNotLockedByOther,
  getWorkspaceLockHash,
  listWorkspaceLockDecorations,
  releaseWorkspaceLock,
  resolveWorkspaceOpenGuardDecision,
} from "../../services/src/omnicode/workspaceLocks.js";
import { attachWorkspaceLockCoordinator } from "../../services/src/omnicode/workspaceLockCoordinator.js";
import type { ObservableSettingService } from "../../services/src/setting/observableSettingService.js";
import type { AppSettings } from "@zcode/shared";

const SELF = "pself00001";
const OTHER = "pother0001";

let sharedRoot: string;

beforeEach(() => {
  sharedRoot = mkdtempSync(join(tmpdir(), "omnicode-b2-2-locks-"));
  process.env.OMNICODE_SHARED_ROOT = sharedRoot;
});

afterEach(() => {
  delete process.env.OMNICODE_SHARED_ROOT;
  rmSync(sharedRoot, { recursive: true, force: true });
});

function lockFilePathFor(workspacePath: string): string {
  return join(sharedRoot, "workspace-locks", `${getWorkspaceLockHash(workspacePath)}.json`);
}

function readLockEntry(workspacePath: string): { profileId: string } | undefined {
  const path = lockFilePathFor(workspacePath);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as { profileId: string };
}

async function flushAsync(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("omnicode B2-2 open guard decision (pure)", () => {
  const owner = { profileId: OTHER, pid: 4321, workspacePath: "C:\\ws\\demo" };

  it("无锁 → open", () => {
    expect(resolveWorkspaceOpenGuardDecision({ lockOwner: undefined, selfProfileId: SELF })).toEqual(
      { kind: "open" },
    );
  });

  it("自持（同 profileId，含同实例多窗口）→ open", () => {
    expect(
      resolveWorkspaceOpenGuardDecision({
        lockOwner: { ...owner, profileId: SELF },
        selfProfileId: SELF,
      }),
    ).toEqual({ kind: "open" });
  });

  it("被他实例持有 → reject（携带 owner 供对话框展示）", () => {
    expect(resolveWorkspaceOpenGuardDecision({ lockOwner: owner, selfProfileId: SELF })).toEqual({
      kind: "reject",
      owner,
    });
  });

  it("被他实例持有且用户选只读打开 → observer（不获取锁）", () => {
    expect(
      resolveWorkspaceOpenGuardDecision({
        lockOwner: owner,
        selfProfileId: SELF,
        observerRequested: true,
      }),
    ).toEqual({ kind: "observer", owner });
  });
});

describe("omnicode B2-2 assertWorkspaceNotLockedByOther (structured rejection)", () => {
  it("被其他实例持有 → 抛 omnicode.workspace-locked-by-other + owner data", () => {
    const workspacePath = join(sharedRoot, "ws-a");
    const acquired = acquireWorkspaceLock(workspacePath, OTHER, process.pid);
    expect(acquired.ok).toBe(true);
    let caught: unknown;
    try {
      assertWorkspaceNotLockedByOther(workspacePath, SELF);
    } catch (error) {
      caught = error;
    }
    const coded = caught as { code?: string; data?: { profileId: string } } | undefined;
    expect(caught).toBeDefined();
    expect(coded?.code).toBe("omnicode.workspace-locked-by-other");
    expect(coded?.data?.profileId).toBe(OTHER);
  });

  it("自持 / 无锁 → 放行", () => {
    const selfPath = join(sharedRoot, "ws-self");
    const freePath = join(sharedRoot, "ws-free");
    expect(acquireWorkspaceLock(selfPath, SELF, process.pid).ok).toBe(true);
    expect(() => assertWorkspaceNotLockedByOther(selfPath, SELF)).not.toThrow();
    expect(() => assertWorkspaceNotLockedByOther(freePath, SELF)).not.toThrow();
  });

  it("无主锁（心跳超时）读取时懒清理，不视为占用", () => {
    const workspacePath = join(sharedRoot, "ws-stale");
    const lockPath = lockFilePathFor(workspacePath);
    mkdirSync(join(sharedRoot, "workspace-locks"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        workspacePath,
        profileId: OTHER,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: Date.now() - 60_000,
      }),
      "utf8",
    );
    expect(() => assertWorkspaceNotLockedByOther(workspacePath, SELF)).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("omnicode B2-2 lock decorations (restore precheck data source)", () => {
  it("锁 hash 大小写不敏感 + 尾分隔符归一（restore 预检宽松比对的前提）", () => {
    const path = join(sharedRoot, "WS-Mixed-Case");
    expect(getWorkspaceLockHash(path)).toBe(getWorkspaceLockHash(path.toLowerCase()));
    expect(getWorkspaceLockHash(path)).toBe(getWorkspaceLockHash(`${path}\\`));
    expect(getWorkspaceLockHash(path)).not.toBe(getWorkspaceLockHash(join(sharedRoot, "other")));
  });

  it("ownedBySelf 按环境身份判定：自持 true / 他持 false（restore 预检据此过滤）", () => {
    const previousProfileId = process.env.OMNICODE_PROFILE_ID;
    const lockedPath = join(sharedRoot, "ws-locked");
    const selfPath = join(sharedRoot, "ws-self-2");
    expect(acquireWorkspaceLock(lockedPath, OTHER, process.pid).ok).toBe(true);
    expect(acquireWorkspaceLock(selfPath, SELF, process.pid).ok).toBe(true);
    try {
      process.env.OMNICODE_PROFILE_ID = SELF;
      const decorations = listWorkspaceLockDecorations();
      expect(decorations.find((entry) => entry.workspacePath === lockedPath)).toMatchObject({
        profileId: OTHER,
        ownedBySelf: false,
      });
      expect(decorations.find((entry) => entry.workspacePath === selfPath)).toMatchObject({
        profileId: SELF,
        ownedBySelf: true,
      });
    } finally {
      if (previousProfileId === undefined) delete process.env.OMNICODE_PROFILE_ID;
      else process.env.OMNICODE_PROFILE_ID = previousProfileId;
    }
  });
});

describe("omnicode B2-2 coordinator set reconciliation (multi-tab regression)", () => {
  function createFakeSettingService(initial: AppSettings): {
    settingService: ObservableSettingService;
    patch(next: Partial<AppSettings>): Promise<void>;
  } {
    let settings: AppSettings = initial;
    const listeners = new Set<(event: { keys: readonly (keyof AppSettings)[] }) => void>();
    const settingService = {
      get: async () => settings,
      onDidUpdate: (listener: (event: { keys: readonly (keyof AppSettings)[] }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as ObservableSettingService;
    return {
      settingService,
      async patch(next: Partial<AppSettings>) {
        settings = { ...settings, ...next };
        for (const listener of listeners) listener({ keys: Object.keys(next) as (keyof AppSettings)[] });
        await flushAsync();
      },
    };
  }

  it("集合新增获取 / 消失释放 / 他实例持有不夺锁不误标自持 / dispose 全释放", async () => {
    const w1 = join(sharedRoot, "tab-w1");
    const w2 = join(sharedRoot, "tab-w2");
    const w3 = join(sharedRoot, "tab-w3"); // 预置被他实例持有
    expect(acquireWorkspaceLock(w3, OTHER, process.pid).ok).toBe(true);

    const saveProject = vi.fn();
    const { settingService, patch } = createFakeSettingService({
      lastActiveWorkspace: null,
      openLocalWorkspaces: [],
    } as unknown as AppSettings);
    const coordinator = attachWorkspaceLockCoordinator({
      settingService,
      projectService: { saveProject },
      readLocalProjectPaths: async () => [],
      profileId: SELF,
      pid: process.pid,
    });
    await flushAsync();

    // 多 tab 集合 [W1, W2]：两把锁都归本实例
    await patch({ openLocalWorkspaces: [w1, w2] });
    expect(readLockEntry(w1)?.profileId).toBe(SELF);
    expect(readLockEntry(w2)?.profileId).toBe(SELF);

    // 关 tab（集合变为 [W2]）：W1 锁随集合释放，W2 保留
    await patch({ openLocalWorkspaces: [w2] });
    expect(existsSync(lockFilePathFor(w1))).toBe(false);
    expect(readLockEntry(w2)?.profileId).toBe(SELF);

    // 集合加入被他实例持有的 W3：判负不阻断（软语义保持）、不夺锁、锁文件仍归对方
    await patch({ openLocalWorkspaces: [w2, w3] });
    expect(readLockEntry(w3)?.profileId).toBe(OTHER);

    // dispose（实例关闭）：本实例持有的锁全释放；对方锁不受影响
    coordinator.dispose();
    expect(existsSync(lockFilePathFor(w2))).toBe(false);
    expect(readLockEntry(w3)?.profileId).toBe(OTHER);
    releaseWorkspaceLock(w3, OTHER, process.pid);
  });

  it("旧 renderer 兼容：无集合字段时退回 lastActiveWorkspace 单活动语义", async () => {
    const w1 = join(sharedRoot, "legacy-w1");
    const w2 = join(sharedRoot, "legacy-w2");
    const { settingService, patch } = createFakeSettingService({
      lastActiveWorkspace: { kind: "local", workspacePath: w1 },
    } as unknown as AppSettings);
    const coordinator = attachWorkspaceLockCoordinator({
      settingService,
      projectService: { saveProject: vi.fn() },
      readLocalProjectPaths: async () => [],
      profileId: SELF,
      pid: process.pid,
    });
    await flushAsync();
    // 装配时的保守初始锁 = lastActiveWorkspace
    expect(readLockEntry(w1)?.profileId).toBe(SELF);

    await patch({ lastActiveWorkspace: { kind: "local", workspacePath: w2 } });
    expect(existsSync(lockFilePathFor(w1))).toBe(false);
    expect(readLockEntry(w2)?.profileId).toBe(SELF);
    coordinator.dispose();
  });
});

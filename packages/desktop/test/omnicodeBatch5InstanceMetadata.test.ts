// [OmniCode] 实例元数据批次单测（spec: docs/omnicode/profile-runtime.md §实例元数据）：
// - profileRegistry：seq（新建 = max+1；读档缺失回填写回）+ rename（id/seq/覆盖字段稳定，
//   重名拒绝，trim 非空）——profileId 稳定性红线（改名后凭据/数据根/锁/dock 覆盖表按旧 id）。
// - 排序纯函数（shared omnicodeInstanceSort）：seq/name/custom 三模式 + customOrder
//   归一 + 拖拽落点语义（before/after）。
// - console-ui.json merge 白名单扩展（sortMode/customOrder）+ 落盘读档往返（P1-1 教训：
//   漏字段 = 持久化断裂，必须带读档往返测试）。
// - 托盘品牌名：omnicode 管理器 tooltip/open 文案分支 + 官方分支原样（desktopMenuMessages）。
// - 桥 rename 命令：manager → 实例帧（title = "ZCode [新名]"）。
// - 锁 displayName 热更新：心跳重写锁文件 displayName + 最新注册表名读取（env 快照过期兜底）。
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// electron 仅在桥广播路径使用（BrowserWindow.getAllWindows）——mock 掉使 main 侧
// 模块可在 node 测试进程导入执行。
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
// 本文件验证 omnicode 管理器行为：把编译期 flavor 覆写为 omnicode（其余导出保持原样）
vi.mock("@zcode/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/shared")>();
  return { ...original, ZCODE_PRODUCT_FLAVOR: "omnicode" as const };
});

import {
  formatDesktopMenuMessage,
  desktopMenuMessageIds,
  desktopMenuMessages,
  moveOmnicodeInstanceInCustomOrder,
  normalizeOmnicodeInstanceCustomOrder,
  normalizeOmnicodeInstanceSortMode,
  sortOmnicodeInstances,
  type OmnicodeConsoleUiStatePatch,
} from "@zcode/shared";
import {
  createOmnicodeProfile,
  deriveOmnicodeProfileSeqBackfill,
  getOmnicodeProfileRecord,
  listOmnicodeProfiles,
  renameOmnicodeProfile,
} from "../src/main/omnicode/profileRuntime.js";
import {
  buildOmnicodeInstanceWindowTitle,
  sendOmnicodeInstanceRename,
} from "../src/main/omnicode/instanceManager.js";
import {
  ensureOmnicodeInstanceBridgeServerStarted,
} from "../src/main/omnicode/instanceBridgeServer.js";
import {
  buildOmnicodeTraySectionModel,
  getOmnicodeTrayRunningCount,
} from "../src/main/omnicode/trayMenu.js";
import {
  DEFAULT_OMNICODE_CONSOLE_UI_STATE,
  loadOmnicodeConsoleUiStateMigrating,
  mergeOmnicodeConsoleUiState,
  writeOmnicodeConsoleUiState,
} from "../src/main/omnicode/consoleUiState.js";
import {
  acquireWorkspaceLock,
  heartbeatWorkspaceLock,
  readLatestOmnicodeProfileDisplayName,
  readWorkspaceLockOwner,
} from "../../services/src/omnicode/workspaceLocks.js";
// 协调器从实现文件导入（锁域测试同款，与 omnicodeBatch2WorkspaceLock.test.ts 一致）。
import { attachWorkspaceLockCoordinator } from "../../services/src/omnicode/workspaceLockCoordinator.js";

const PID_A = "paaaaaaaaaa1";
const PID_B = "pbbbbbbbbbb2";
const PID_C = "pcccccccccc3";

/** 轮询等待（异步对账/心跳路径的确定性收口；超时直接 fail 断言）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor 超时：条件未满足");
}

// ─── 排序纯函数（shared omnicodeInstanceSort） ─────────────────────────────────

describe("omnicode batch5: sortOmnicodeInstances 三模式", () => {
  const items = [
    { id: PID_A, name: "张三", seq: 3, createdAt: "2026-01-03T00:00:00Z" },
    { id: PID_B, name: "Alpha", seq: 1, createdAt: "2026-01-01T00:00:00Z" },
    { id: PID_C, name: "_beta", seq: 2, createdAt: "2026-01-02T00:00:00Z" },
  ];

  it("seq 模式（默认）：按 seq 升序；缺失排尾并以 createdAt 兜底", () => {
    const sorted = sortOmnicodeInstances(items, { mode: "seq" });
    expect(sorted.map((item) => item.id)).toEqual([PID_B, PID_C, PID_A]);
    const withMissing = sortOmnicodeInstances(
      [
        { id: PID_A, name: "a", createdAt: "2026-01-05T00:00:00Z" },
        { id: PID_B, name: "b", seq: 9, createdAt: "2026-01-01T00:00:00Z" },
        { id: PID_C, name: "c", createdAt: "2026-01-02T00:00:00Z" },
      ],
      { mode: "seq" },
    );
    // 缺失 seq 项按 createdAt 升序补尾
    expect(withMissing.map((item) => item.id)).toEqual([PID_B, PID_C, PID_A]);
  });

  it("未知/缺省模式回退 seq（防御；落盘值已由 merge 收敛）", () => {
    const sorted = sortOmnicodeInstances(items, { mode: undefined });
    expect(sorted.map((item) => item.id)).toEqual([PID_B, PID_C, PID_A]);
    expect(sortOmnicodeInstances(items).map((item) => item.id)).toEqual([PID_B, PID_C, PID_A]);
  });

  it("name 模式：localeCompare('zh')（拉丁字母序 + 中文拼音序）", () => {
    const zh = sortOmnicodeInstances(
      [
        { id: PID_A, name: "王五", seq: 3 },
        { id: PID_B, name: "李四", seq: 1 },
        { id: PID_C, name: "阿明", seq: 2 },
      ],
      { mode: "name" },
    );
    // zh collation：阿 a < 李 l < 王 w
    expect(zh.map((item) => item.id)).toEqual([PID_C, PID_B, PID_A]);
    const latin = sortOmnicodeInstances(
      [
        { id: PID_A, name: "beta", seq: 3 },
        { id: PID_B, name: "Alpha", seq: 1 },
        { id: PID_C, name: "gamma", seq: 2 },
      ],
      { mode: "name" },
    );
    expect(latin.map((item) => item.id)).toEqual([PID_B, PID_A, PID_C]);
  });

  it("custom 模式：customOrder 决定顺序，未登记项按 seq 补尾", () => {
    const sorted = sortOmnicodeInstances(items, {
      mode: "custom",
      customOrder: [PID_C, PID_A],
    });
    // PID_B 未登记 → 按 seq 补尾
    expect(sorted.map((item) => item.id)).toEqual([PID_C, PID_A, PID_B]);
    const full = sortOmnicodeInstances(items, {
      mode: "custom",
      customOrder: [PID_B, PID_A, PID_C],
    });
    expect(full.map((item) => item.id)).toEqual([PID_B, PID_A, PID_C]);
  });

  it("sortOmnicodeInstances 不改变输入数组", () => {
    const input = [...items];
    sortOmnicodeInstances(items, { mode: "name" });
    expect(items.map((item) => item.id)).toEqual(input.map((item) => item.id));
  });
});

describe("omnicode batch5: customOrder 归一 + 拖拽落点语义", () => {
  it("normalizeOmnicodeInstanceCustomOrder：非法形态/非法键/重复键收敛；缺省 undefined=不变", () => {
    expect(normalizeOmnicodeInstanceCustomOrder(undefined)).toBeUndefined();
    expect(normalizeOmnicodeInstanceCustomOrder("nope")).toBeUndefined();
    expect(normalizeOmnicodeInstanceCustomOrder([])).toEqual([]);
    expect(normalizeOmnicodeInstanceCustomOrder([PID_A, "bad-id", PID_A, PID_B])).toEqual([
      PID_A,
      PID_B,
    ]);
  });

  it("normalizeOmnicodeInstanceSortMode：仅三合法值，其余 undefined", () => {
    expect(normalizeOmnicodeInstanceSortMode("seq")).toBe("seq");
    expect(normalizeOmnicodeInstanceSortMode("name")).toBe("name");
    expect(normalizeOmnicodeInstanceSortMode("custom")).toBe("custom");
    expect(normalizeOmnicodeInstanceSortMode("rank")).toBeUndefined();
    expect(normalizeOmnicodeInstanceSortMode(undefined)).toBeUndefined();
  });

  it("拖拽落点：目标上半区 = before（插入目标前），下半区 = after（插入目标后）", () => {
    const order = [PID_A, PID_B, PID_C];
    expect(moveOmnicodeInstanceInCustomOrder(order, order, PID_C, PID_A, "before")).toEqual([
      PID_C,
      PID_A,
      PID_B,
    ]);
    expect(moveOmnicodeInstanceInCustomOrder(order, order, PID_C, PID_A, "after")).toEqual([
      PID_A,
      PID_C,
      PID_B,
    ]);
    expect(moveOmnicodeInstanceInCustomOrder(order, order, PID_A, PID_C, "after")).toEqual([
      PID_B,
      PID_C,
      PID_A,
    ]);
  });

  it("拖拽 no-op：拖到自身返回归一基线；order 缺项自动补齐（收敛为全覆盖）；拖到目标后 = 移到其后", () => {
    const order = [PID_A];
    expect(moveOmnicodeInstanceInCustomOrder(order, [PID_A, PID_B], PID_A, PID_A, "before")).toEqual([
      PID_A,
      PID_B,
    ]);
    // A 拖到 B「之后」= 移到 B 后面（真实换位，非 no-op）
    expect(moveOmnicodeInstanceInCustomOrder(order, [PID_A, PID_B], PID_A, PID_B, "after")).toEqual([
      PID_B,
      PID_A,
    ]);
  });
});

// ─── profileRegistry：seq + rename（真实临时目录 fs） ──────────────────────────

describe("omnicode batch5: profileRegistry seq", () => {
  let profileRoot: string;
  let originalProfileRoot: string | undefined;

  beforeEach(async () => {
    profileRoot = await mkdtemp(join(tmpdir(), "omnicode-profile-seq-"));
    originalProfileRoot = process.env.OMNICODE_PROFILE_ROOT;
    process.env.OMNICODE_PROFILE_ROOT = profileRoot;
  });
  afterEach(async () => {
    if (originalProfileRoot === undefined) delete process.env.OMNICODE_PROFILE_ROOT;
    else process.env.OMNICODE_PROFILE_ROOT = originalProfileRoot;
    await rm(profileRoot, { recursive: true, force: true });
  });

  it("新建实例 seq = 当前 max+1（1、2、3 递增）", async () => {
    const first = await createOmnicodeProfile("实例一");
    const second = await createOmnicodeProfile("实例二");
    const third = await createOmnicodeProfile("实例三");
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
  });

  it("读档缺失 seq 回填：旧档（无 seq）list 时按 createdAt 推导并写回 profile.json", async () => {
    // 直接造旧档形态（无 seq 字段）
    await mkdir(join(profileRoot, PID_A), { recursive: true });
    await mkdir(join(profileRoot, PID_B), { recursive: true });
    await writeFile(
      join(profileRoot, PID_A, "profile.json"),
      JSON.stringify({ id: PID_A, name: "旧甲", createdAt: "2026-01-02T00:00:00Z" }),
      "utf8",
    );
    await writeFile(
      join(profileRoot, PID_B, "profile.json"),
      JSON.stringify({ id: PID_B, name: "旧乙", createdAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    const summaries = await listOmnicodeProfiles();
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    expect(byId.get(PID_B)?.seq).toBe(1); // createdAt 更早 → 回填 1
    expect(byId.get(PID_A)?.seq).toBe(2);
    // 回填已写回 profile.json（best-effort 异步写，轮询收敛；幂等：下次读档不再变化）
    await waitFor(async () => (await getOmnicodeProfileRecord(PID_A))?.seq === 2);
    const recordA = await getOmnicodeProfileRecord(PID_A);
    expect(recordA?.seq).toBe(2);
  });

  it("deriveOmnicodeProfileSeqBackfill：已有合法 seq 保持原值，缺失项从 max+1 连续分配", () => {
    const assigned = deriveOmnicodeProfileSeqBackfill([
      { id: PID_A, createdAt: "2026-01-01T00:00:00Z", seq: 5 },
      { id: PID_B, createdAt: "2026-01-02T00:00:00Z" },
      { id: PID_C, createdAt: "2026-01-03T00:00:00Z" },
    ]);
    expect(assigned.get(PID_B)).toBe(6);
    expect(assigned.get(PID_C)).toBe(7);
    expect(assigned.has(PID_A)).toBe(false);
  });

  it("profileId 稳定性红线：rename 后 id/seq/dataBaseDirOverride 不变（dock 覆盖表/凭据/数据根/锁全部按旧 id 工作）", async () => {
    const created = await createOmnicodeProfile("稳定性", undefined, {
      dataBaseDirOverride: "F:/fake/adopted-root",
    });
    const renamed = await renameOmnicodeProfile(created.id, "稳定性-改");
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe("稳定性-改");
    expect(renamed.seq).toBe(created.seq);
    const record = await getOmnicodeProfileRecord(created.id);
    expect(record?.dataBaseDirOverride).toBe("F:/fake/adopted-root");
    // 目录仍按旧 id 解析（profileId 稳定性——收养路径不建 .zcode/v2，electron-userdata 在自身目录）
    expect(existsSync(join(profileRoot, created.id, "electron-userdata"))).toBe(true);
  });

  it("rename 重名拒绝（trim 后同名不区分大小写）+ 空名拒绝 + 同名幂等不写盘", async () => {
    const a = await createOmnicodeProfile("Alpha");
    const b = await createOmnicodeProfile("Beta");
    await expect(renameOmnicodeProfile(b.id, "alpha")).rejects.toThrow(/已存在/);
    await expect(renameOmnicodeProfile(b.id, "  Alpha  ")).rejects.toThrow(/已存在/);
    await expect(renameOmnicodeProfile(b.id, "   ")).rejects.toThrow(/不能为空/);
    const same = await renameOmnicodeProfile(b.id, "Beta");
    expect(same.id).toBe(b.id);
    expect(same.name).toBe("Beta");
    expect(a.id).not.toBe(b.id);
  });
});

// ─── console-ui.json merge 白名单扩展 + 读档往返（P1-1 教训回归） ────────────────

describe("omnicode batch5: console-ui sortMode/customOrder 持久化", () => {
  let consoleRoot: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    consoleRoot = await mkdtemp(join(tmpdir(), "omnicode-console-sort-"));
    originalDataDir = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = consoleRoot;
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
    else process.env.ZCODE_DATA_BASE_DIR = originalDataDir;
    await rm(consoleRoot, { recursive: true, force: true });
  });

  it("merge 白名单：sortMode 仅合法枚举；customOrder 显式携带才更新（undefined=不变，空数组=清空）", () => {
    expect(mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {}).sortMode).toBeUndefined();
    const merged = mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
      sortMode: "custom",
      customOrder: [PID_A, PID_B, "bad", PID_A],
    });
    expect(merged.sortMode).toBe("custom");
    expect(merged.customOrder).toEqual([PID_A, PID_B]);
    // 非法 sortMode 不写入
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        sortMode: "rank" as unknown as "seq",
      }).sortMode,
    ).toBeUndefined();
    // undefined = 不变；空数组 = 清空
    expect(mergeOmnicodeConsoleUiState(merged, {}).customOrder).toEqual([PID_A, PID_B]);
    expect(mergeOmnicodeConsoleUiState(merged, { customOrder: [] }).customOrder).toEqual([]);
  });

  it("P1-1 回归：落盘 JSON 整体过 merge（读档路径）时 sortMode/customOrder 存活", () => {
    const persisted = {
      ...DEFAULT_OMNICODE_CONSOLE_UI_STATE,
      dockedByProfileId: { [PID_A]: false },
      sortMode: "name",
      customOrder: [PID_B, PID_A],
    } as unknown as OmnicodeConsoleUiStatePatch;
    const loaded = mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, persisted);
    expect(loaded.sortMode).toBe("name");
    expect(loaded.customOrder).toEqual([PID_B, PID_A]);
    expect(loaded.dockedByProfileId).toEqual({ [PID_A]: false });
  });

  it("读档往返：写 sortMode/customOrder → loadOmnicodeConsoleUiStateMigrating 读回保留", async () => {
    const current = await loadOmnicodeConsoleUiStateMigrating();
    const merged = mergeOmnicodeConsoleUiState(current.state, {
      sortMode: "custom",
      customOrder: [PID_C, PID_A, PID_B],
    });
    await writeOmnicodeConsoleUiState(merged);
    // 读档（进程重启语义）：排序态存活（P1-1 教训的直证——漏白名单字段在这里断）
    const reloaded = await loadOmnicodeConsoleUiStateMigrating();
    expect(reloaded.state.sortMode).toBe("custom");
    expect(reloaded.state.customOrder).toEqual([PID_C, PID_A, PID_B]);
    // 既有字段（dock 覆盖表）同批写不丢
    const patched = mergeOmnicodeConsoleUiState(reloaded.state, {
      dockInstance: { profileId: PID_A, docked: false },
    });
    await writeOmnicodeConsoleUiState(patched);
    const again = await loadOmnicodeConsoleUiStateMigrating();
    expect(again.state.sortMode).toBe("custom");
    expect(again.state.dockedByProfileId).toEqual({ [PID_A]: false });
  });

  it("落盘文件自证：console-ui.json 原文含 sortMode/customOrder 键", async () => {
    await writeOmnicodeConsoleUiState({
      ...DEFAULT_OMNICODE_CONSOLE_UI_STATE,
      sortMode: "name",
      customOrder: [PID_A],
    });
    const raw = JSON.parse(await readFile(join(consoleRoot, "console-ui.json"), "utf8")) as {
      sortMode?: string;
      customOrder?: string[];
    };
    expect(raw.sortMode).toBe("name");
    expect(raw.customOrder).toEqual([PID_A]);
  });
});

// ─── 托盘品牌名（omnicode 分支文案 + 官方原样红线） ─────────────────────────────

describe("omnicode batch5: 托盘品牌名", () => {
  it("omnicode tooltip 文案模板：'OmniCode · N 个实例运行中'（zh/en 双语，N 动态插值）", () => {
    expect(
      formatDesktopMenuMessage("zh-CN", desktopMenuMessageIds.trayTooltipOmniCodeRunning, { count: 3 }),
    ).toBe("OmniCode · 3 个实例运行中");
    expect(
      formatDesktopMenuMessage("en-US", desktopMenuMessageIds.trayTooltipOmniCodeRunning, { count: 0 }),
    ).toBe("OmniCode · 0 instances running");
  });

  it("官方红线：tray.tooltip / tray.menu.openZCode 官方文案原样（未被本批改动）", () => {
    expect(desktopMenuMessages["zh-CN"]["tray.tooltip"]).toBe("ZCode");
    expect(desktopMenuMessages["en-US"]["tray.tooltip"]).toBe("ZCode");
    expect(desktopMenuMessages["zh-CN"]["tray.menu.openZCode"]).toBe("打开 ZCode");
    expect(desktopMenuMessages["en-US"]["tray.menu.openZCode"]).toBe("Open ZCode");
    // omnicode 专属键独立存在（不占用官方键）
    expect(desktopMenuMessages["zh-CN"]["tray.menu.openOmniCode"]).toBe("打开 OmniCode");
    expect(desktopMenuMessages["en-US"]["tray.tooltip.omnicodeRunning"]).toContain("{count}");
  });

  it("托盘运行数提供者：未装配返回 0（不抛错；desktopTray 官方分支原样兜底）", () => {
    expect(getOmnicodeTrayRunningCount()).toBe(0);
  });

  it("托盘实例区模型保持给定顺序（排序由 shared 函数在上游完成）", () => {
    const model = buildOmnicodeTraySectionModel({
      instances: [
        { profileId: PID_B, name: "B" },
        { profileId: PID_A, name: "A" },
      ],
      profileCount: 3,
      isZh: true,
    });
    expect(model.instanceItems.map((item) => item.label)).toEqual(["● B", "● A"]);
    expect(model.launchAllEnabled).toBe(true);
    expect(model.stopAllEnabled).toBe(true);
  });
});

// ─── 桥 rename 命令（manager → 实例帧） ────────────────────────────────────────

describe("omnicode batch5: 桥 rename 热更新链", () => {
  it("标题构造：'ZCode [新名]'；空名/纯空白 → 空串（不投递）", () => {
    expect(buildOmnicodeInstanceWindowTitle("甲")).toBe("ZCode [甲]");
    expect(buildOmnicodeInstanceWindowTitle("  甲 ")).toBe("ZCode [甲]");
    expect(buildOmnicodeInstanceWindowTitle("")).toBe("");
    expect(buildOmnicodeInstanceWindowTitle("   ")).toBe("");
  });

  it("sendOmnicodeInstanceRename 经桥下发 rename 帧（title = 'ZCode [新名]'）；未连接返回 false", async () => {
    const bridge = await ensureOmnicodeInstanceBridgeServerStarted();
    const received: { type?: string; title?: string }[] = [];
    let resolveConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${bridge.port}/?token=${bridge.token}&profileId=${PID_A}`,
      );
      socket.on("message", (data) => {
        try {
          const parsed = JSON.parse(String(data)) as { type?: string; title?: string };
          received.push(parsed);
          if (parsed.type === "rename") resolveConnected();
        } catch {
          /* 忽略坏帧 */
        }
      });
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    try {
      // 先验证未运行实例/未连接路径（PID_B 未连接 → false，不抛错）
      expect(sendOmnicodeInstanceRename(PID_B, "乙")).toBe(false);
      const delivered = sendOmnicodeInstanceRename(PID_A, "改名后");
      expect(delivered).toBe(true);
      await Promise.race([connected, new Promise((resolve) => setTimeout(resolve, 2000))]);
      const renameFrame = received.find((frame) => frame.type === "rename");
      expect(renameFrame?.title).toBe("ZCode [改名后]");
    } finally {
      ws.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});

// ─── 锁 displayName 热更新（心跳重写 + 最新注册表名） ───────────────────────────

describe("omnicode batch5: 锁占用者名热更新", () => {
  let sharedRoot: string;
  let profileRoot: string;
  const originalSharedRoot = process.env.OMNICODE_SHARED_ROOT;
  const originalProfileRoot = process.env.OMNICODE_PROFILE_ROOT;
  const originalProfileId = process.env.OMNICODE_PROFILE_ID;

  beforeEach(async () => {
    sharedRoot = await mkdtemp(join(tmpdir(), "omnicode-lock-name-"));
    profileRoot = await mkdtemp(join(tmpdir(), "omnicode-lock-profiles-"));
    process.env.OMNICODE_SHARED_ROOT = sharedRoot;
    process.env.OMNICODE_PROFILE_ROOT = profileRoot;
  });
  afterEach(async () => {
    if (originalSharedRoot === undefined) delete process.env.OMNICODE_SHARED_ROOT;
    else process.env.OMNICODE_SHARED_ROOT = originalSharedRoot;
    if (originalProfileRoot === undefined) delete process.env.OMNICODE_PROFILE_ROOT;
    else process.env.OMNICODE_PROFILE_ROOT = originalProfileRoot;
    if (originalProfileId === undefined) delete process.env.OMNICODE_PROFILE_ID;
    else process.env.OMNICODE_PROFILE_ID = originalProfileId;
    await rm(sharedRoot, { recursive: true, force: true });
    await rm(profileRoot, { recursive: true, force: true });
  });

  it("heartbeatWorkspaceLock 携带新 displayName 时重写锁文件（改名 → 心跳内锁名自愈）", () => {
    expect(
      acquireWorkspaceLock("F:/ws/lock-a", PID_A, process.pid, "旧名").ok,
    ).toBe(true);
    expect(readWorkspaceLockOwner("F:/ws/lock-a")?.displayName).toBe("旧名");
    expect(heartbeatWorkspaceLock("F:/ws/lock-a", PID_A, process.pid, "新名")).toBe(true);
    expect(readWorkspaceLockOwner("F:/ws/lock-a")?.displayName).toBe("新名");
    // 不传名（undefined）时保留既有 displayName（向后兼容）
    expect(heartbeatWorkspaceLock("F:/ws/lock-a", PID_A, process.pid)).toBe(true);
    expect(readWorkspaceLockOwner("F:/ws/lock-a")?.displayName).toBe("新名");
  });

  it("readLatestOmnicodeProfileDisplayName：读 profile.json 最新 name（env 快照过期兜底）", async () => {
    // 无实例身份 → undefined（官方/管理器路径不读档）
    delete process.env.OMNICODE_PROFILE_ID;
    expect(readLatestOmnicodeProfileDisplayName()).toBeUndefined();
    // 实例身份 + 旧 env 快照（OMNICODE_PROFILE_NAME 过期）→ 注册表最新名优先
    process.env.OMNICODE_PROFILE_ID = PID_A;
    await mkdir(join(profileRoot, PID_A), { recursive: true });
    await writeFile(
      join(profileRoot, PID_A, "profile.json"),
      JSON.stringify({ id: PID_A, name: "注册表新名", createdAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    expect(readLatestOmnicodeProfileDisplayName()).toBe("注册表新名");
    // 改名后（重写 profile.json）再次读取即时反映
    await writeFile(
      join(profileRoot, PID_A, "profile.json"),
      JSON.stringify({ id: PID_A, name: "二次改名", createdAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    expect(readLatestOmnicodeProfileDisplayName()).toBe("二次改名");
    // 坏档 fail-open → undefined（调用方回退静态 env 值）
    await writeFile(join(profileRoot, PID_A, "profile.json"), "{broken", "utf8");
    expect(readLatestOmnicodeProfileDisplayName()).toBeUndefined();
  });

  it("协调器 resolveDisplayName：打开集合对账获取锁时消费动态名（静态 env 快照过期场景）", async () => {
    process.env.OMNICODE_PROFILE_ID = PID_A;
    let dynamicName = "动态旧名";
    let settingsListener: ((event: { keys: string[] }) => void) | null = null;
    let currentSettings: Record<string, unknown> = {};
    const coordinator = attachWorkspaceLockCoordinator({
      settingService: {
        onDidUpdate: (listener: (event: { keys: string[] }) => void) => {
          settingsListener = listener;
          return () => undefined;
        },
        get: async () => currentSettings as never,
      } as never,
      projectService: { saveProject: async () => undefined },
      readLocalProjectPaths: async () => [],
      profileId: PID_A,
      displayName: "env静态旧名",
      resolveDisplayName: () => dynamicName,
      pid: process.pid,
    });
    try {
      // 打开集合变更 → 集合对账获取锁（displayName 取 resolveDisplayName 最新值）
      currentSettings = { openLocalWorkspaces: ["F:/ws/lock-c"] };
      settingsListener?.({ keys: ["openLocalWorkspaces"] });
      await waitFor(() => readWorkspaceLockOwner("F:/ws/lock-c") !== undefined);
      expect(readWorkspaceLockOwner("F:/ws/lock-c")?.displayName).toBe("动态旧名");
      // 改名（注册表变化 → 解析器返回新值）→ 心跳期锁文件 displayName 自愈
      dynamicName = "动态新名";
      expect(heartbeatWorkspaceLock("F:/ws/lock-c", PID_A, process.pid, dynamicName)).toBe(true);
      expect(readWorkspaceLockOwner("F:/ws/lock-c")?.displayName).toBe("动态新名");
    } finally {
      coordinator.dispose();
    }
  });
});

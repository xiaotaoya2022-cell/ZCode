// [OmniCode] Profile Runtime：多实例 Profile 注册表（文件事实源）。
// spec: docs/omnicode/profile-runtime.md ｜ 运行态编排见 ./instanceManager.ts
// 批次1 P1-6：profile.json 读写改原子化（写=temp+fsync+rename，读=损坏隔离+.bak 回滚）；
// P2-10：目录所有权标记防误删；P0-3：lastPid 持久化供控制台重启后重建运行态。
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { readJsonWithRecovery, writeJsonAtomic, writeOwnerMark, checkOwnerMarkForDelete } from "./atomicJson.js";

export interface OmnicodeProfileRecord {
  id: string;
  name: string;
  createdAt: string;
  notes?: string;
  /** 最近一次启动确认成功的实例进程 pid（批次1 P0-3：运行态重建的加速提示，真相以进程表扫描为准）。 */
  lastPid?: number;
  lastLaunchedAt?: string;
}

export interface OmnicodeProfileSummary {
  id: string;
  name: string;
  createdAt: string;
  notes?: string;
}

/** Profile 数据根：默认 `~/.omnicode/profiles`，可用 `OMNICODE_PROFILE_ROOT` 覆盖（spec §目录与数据模型）。 */
export function getOmnicodeProfileRoot(): string {
  const override = process.env.OMNICODE_PROFILE_ROOT?.trim();
  return override ? override : join(homedir(), ".omnicode", "profiles");
}

export function getOmnicodeProfileDir(profileId: string): string {
  return join(getOmnicodeProfileRoot(), profileId);
}

export function resolveProfileIdFromArgv(argv: readonly string[]): string | undefined {
  const prefix = "--omnicode-profile=";
  const raw = argv.find((entry) => entry.startsWith(prefix));
  if (!raw) return undefined;
  return raw.slice(prefix.length).trim() || undefined;
}

export function assertValidProfileId(profileId: string): void {
  // 仅允许生成器产出的形态（p + base36 时间戳 + 随机后缀），兼作目录穿越防护；
  // 所有参与 spawn/execFile 参数构造的 profileId 必须先过此白名单（spec §产品规则 8）
  if (!/^p[0-9a-z]{8,20}$/u.test(profileId)) {
    throw new Error(`[omnicode] 非法 profileId: ${profileId}`);
  }
}

function getProfileFilePath(profileId: string): string {
  return join(getOmnicodeProfileDir(profileId), "profile.json");
}

async function readProfileRecord(profileId: string): Promise<OmnicodeProfileRecord | undefined> {
  const filePath = getProfileFilePath(profileId);
  const parsed = await readJsonWithRecovery<OmnicodeProfileRecord>(filePath);
  if (!parsed) return undefined;
  if (parsed.id !== profileId) {
    throw new Error(`[omnicode] profile.json 身份不一致: ${parsed.id} != ${profileId}`);
  }
  return parsed;
}

/** 批次1 P0-3：启动确认成功后由 instanceManager 调用；控制台重启后据此重建运行态。 */
export async function recordProfileLaunched(profileId: string, pid: number): Promise<void> {
  assertValidProfileId(profileId);
  const record = await readProfileRecord(profileId);
  if (!record) return;
  const updated: OmnicodeProfileRecord = {
    ...record,
    lastPid: pid,
    lastLaunchedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(getProfileFilePath(profileId), updated);
}

/** 批次1 P0-3：实例确认停止后清除提示 pid（运行态真相以进程表扫描为准）。 */
export async function clearProfileLaunched(profileId: string): Promise<void> {
  assertValidProfileId(profileId);
  const record = await readProfileRecord(profileId);
  if (!record) return;
  const updated: OmnicodeProfileRecord = { ...record, lastPid: undefined };
  await writeJsonAtomic(getProfileFilePath(profileId), updated);
}

function toSummary(record: OmnicodeProfileRecord): OmnicodeProfileSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    ...(record.notes ? { notes: record.notes } : {}),
  };
}

function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function listOmnicodeProfiles(): Promise<OmnicodeProfileSummary[]> {
  const root = getOmnicodeProfileRoot();
  if (!existsSync(root)) return [];
  const summaries: OmnicodeProfileSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await readProfileRecord(entry.name);
      if (record) summaries.push(toSummary(record));
    } catch (error) {
      // 单个损坏的 profile 不拖垮列表；唯一事实源是 profile.json，坏档目录跳过
      console.warn(`[omnicode] 跳过无法解析的 profile 目录 ${entry.name}:`, error);
    }
  }
  summaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return summaries;
}

export async function createOmnicodeProfile(name: string, notes?: string): Promise<OmnicodeProfileSummary> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("[omnicode] Profile 名称不能为空");
  const profileId = newProfileId();
  const profileDir = getOmnicodeProfileDir(profileId);
  await mkdir(join(profileDir, ".zcode", "v2"), { recursive: true });
  await mkdir(join(profileDir, "electron-userdata"), { recursive: true });
  await mkdir(join(profileDir, "electron-session"), { recursive: true });
  const record: OmnicodeProfileRecord = {
    id: profileId,
    name: trimmedName,
    createdAt: new Date().toISOString(),
    ...(notes?.trim() ? { notes: notes.trim() } : {}),
  };
  await writeJsonAtomic(join(profileDir, "profile.json"), record);
  // 批次1 P2-10：目录所有权标记（防误删用户数据——只有本仓创建的目录才允许整目录删除）
  await writeOwnerMark(profileDir, profileId);
  return toSummary(record);
}

export async function removeOmnicodeProfile(profileId: string): Promise<void> {
  assertValidProfileId(profileId);
  const profileDir = getOmnicodeProfileDir(profileId);
  if (!existsSync(getProfileFilePath(profileId))) {
    throw new Error(`[omnicode] profile 不存在: ${profileId}`);
  }
  // 批次1 P2-10：删除防护——标记指向别的实例时拒绝（数据属他人）；标记缺失（旧档）放行但留痕
  const verdict = checkOwnerMarkForDelete(profileDir, profileId);
  if (!verdict.allowed) {
    throw new Error(`[omnicode] 拒绝删除 profile 目录: ${verdict.reason}`);
  }
  if (verdict.legacy) {
    console.warn(`[omnicode] 删除无所有权标记的旧 profile 目录（放行）: ${profileId}`);
  }
  // 运行态检查在 IPC/编排层执行（instanceManager 拥有运行态）；此处只负责文件删除
  await rm(profileDir, { recursive: true, force: true });
}

export async function cloneOmnicodeProfile(sourceId: string, newName: string): Promise<OmnicodeProfileSummary> {
  assertValidProfileId(sourceId);
  const source = await readProfileRecord(sourceId);
  if (!source) throw new Error(`[omnicode] 源 profile 不存在: ${sourceId}`);
  const sourceDir = getOmnicodeProfileDir(sourceId);
  // 克隆 = 元数据延续 + 业务数据拷贝。排除项（spec §产品规则 6）：
  // electron-userdata / electron-session（Chromium 存储无复制语义，新实例重新登录）、
  // .zcode/v2/credentials.json 与其锁文件（登录态不随克隆，避免同一密文在两个身份间漂移）、
  // profile.json（保留目标的全新身份）。
  const target = await createOmnicodeProfile(newName, source.notes);
  const targetDir = getOmnicodeProfileDir(target.id);
  const excludedTopLevel = new Set(["electron-userdata", "electron-session"]);
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = source.slice(sourceDir.length).replaceAll("\\", "/").replace(/^\/+/, "");
      if (!relative) return true;
      const topLevel = relative.split("/")[0] ?? "";
      if (excludedTopLevel.has(topLevel)) return false;
      if (relative === "profile.json") return false;
      if (relative === ".zcode/v2/credentials.json") return false;
      if (relative === ".zcode/v2/credentials.json.lock") return false;
      return true;
    },
  });
  return target;
}

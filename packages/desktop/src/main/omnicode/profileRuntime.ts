// [OmniCode] Profile Runtime：多实例 Profile 注册表（文件事实源）。
// spec: docs/omnicode/profile-runtime.md ｜ 运行态编排见 ./instanceManager.ts
// 批次1 P1-6：profile.json 读写改原子化（写=temp+fsync+rename，读=损坏隔离+.bak 回滚）；
// P2-10：目录所有权标记防误删；P0-3：lastPid 持久化供控制台重启后重建运行态。
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { isOmnicodeInstanceSeq } from "@zcode/shared";
import { readJsonWithRecovery, writeJsonAtomic, writeOwnerMark, checkOwnerMarkForDelete } from "./atomicJson.js";

export interface OmnicodeProfileRecord {
  id: string;
  name: string;
  createdAt: string;
  notes?: string;
  /**
   * [OmniCode] 实例元数据批次：序号（正整数；新建 = 当前 max+1，读档缺失由
   * listOmnicodeProfiles 回填并写回）。仅排序依据（sortOmnicodeInstances seq 模式），
   * 不影响昵称显示；profileId 稳定性红线不受影响（seq 与 id 无关）。
   */
  seq?: number;
  /**
   * [OmniCode] 批次2 B2-1（T5 收养）：业务数据根覆盖（.zcode 树所在目录，零拷贝指向
   * 旧控制台数据根等外部目录）。electron-userdata/session 仍用 profile 自身目录——
   * 仅 .zcode 数据根（凭据/会话库/setting.json）与 credential-secret 随该目录走。
   */
  dataBaseDirOverride?: string;
  /** 最近一次启动确认成功的实例进程 pid（批次1 P0-3：运行态重建的加速提示，真相以进程表扫描为准）。 */
  lastPid?: number;
  lastLaunchedAt?: string;
}

export interface OmnicodeProfileSummary {
  id: string;
  name: string;
  createdAt: string;
  notes?: string;
  /** [OmniCode] 实例元数据批次：排序序号（读档缺失已回填；仅排序依据）。 */
  seq?: number;
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

/**
 * [OmniCode] 批次2 B2-1（T5）：按 id 读取完整 profile 记录（含 dataBaseDirOverride）。
 * instanceManager.doLaunch 与收养检查消费；profileId 非法/不存在时抛错或返回 undefined
 * （与 readProfileRecord 同语义）。
 */
export async function getOmnicodeProfileRecord(
  profileId: string,
): Promise<OmnicodeProfileRecord | undefined> {
  assertValidProfileId(profileId);
  return readProfileRecord(profileId);
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
    ...(isOmnicodeInstanceSeq(record.seq) ? { seq: record.seq } : {}),
  };
}

function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * [OmniCode] 实例元数据批次：读档缺失 seq 回填（纯决策，供单测）。
 * 已有合法 seq 的记录保持原值；缺失记录按 createdAt 升序从 max(现有 seq)+1 起连续
 * 分配（补齐后仍单调）。返回 map（profileId → 回填后 seq）只含缺失项。
 */
export function deriveOmnicodeProfileSeqBackfill(
  records: readonly { id: string; createdAt: string; seq?: number }[],
): Map<string, number> {
  let maxSeq = 0;
  const missing: { id: string; createdAt: string }[] = [];
  for (const record of records) {
    if (isOmnicodeInstanceSeq(record.seq)) {
      maxSeq = Math.max(maxSeq, record.seq);
    } else {
      missing.push({ id: record.id, createdAt: record.createdAt });
    }
  }
  missing.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const assigned = new Map<string, number>();
  let cursor = maxSeq;
  for (const entry of missing) {
    cursor += 1;
    assigned.set(entry.id, cursor);
  }
  return assigned;
}

export async function listOmnicodeProfiles(): Promise<OmnicodeProfileSummary[]> {
  const root = getOmnicodeProfileRoot();
  if (!existsSync(root)) return [];
  const records: OmnicodeProfileRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await readProfileRecord(entry.name);
      if (record) records.push(record);
    } catch (error) {
      // 单个损坏的 profile 不拖垮列表；唯一事实源是 profile.json，坏档目录跳过
      console.warn(`[omnicode] 跳过无法解析的 profile 目录 ${entry.name}:`, error);
    }
  }
  // [OmniCode] 实例元数据批次：seq 缺失回填（旧档升级路径）——按 createdAt 兜底推导
  // 并 best-effort 写回 profile.json（写失败仅告警，下次读档仍会回填，幂等）；
  // 排序事实源收敛到 seq（无 seq 的档位由 createdAt 决定回填值，行为可预期）。
  const backfill = deriveOmnicodeProfileSeqBackfill(records);
  for (const [profileId, seq] of backfill) {
    const record = records.find((entry) => entry.id === profileId);
    if (!record) continue;
    const updated: OmnicodeProfileRecord = { ...record, seq };
    void writeJsonAtomic(getProfileFilePath(profileId), updated).catch((error) => {
      console.warn(`[omnicode] profile.json seq 回填写回失败（不阻断）: ${profileId}`, error);
    });
    record.seq = seq;
  }
  const summaries = records.map(toSummary);
  summaries.sort(
    (a, b) =>
      (a.seq ?? Number.POSITIVE_INFINITY) - (b.seq ?? Number.POSITIVE_INFINITY) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  return summaries;
}

export async function createOmnicodeProfile(
  name: string,
  notes?: string,
  options?: { dataBaseDirOverride?: string },
): Promise<OmnicodeProfileSummary> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("[omnicode] Profile 名称不能为空");
  const profileId = newProfileId();
  const profileDir = getOmnicodeProfileDir(profileId);
  // [OmniCode] 实例元数据批次：新建 seq = 当前 max+1（无 profile 时从 1 起；并发创建
  // 同号可接受——seq 仅排序依据，createdAt 兜底稳定 tie-break，不需要强唯一）。
  const seq = await nextOmnicodeProfileSeq();
  // 收养（批次2 B2-1）：.zcode 数据根由 override 指向旧目录，profile 自身目录只建
  // 注册表/Chromium 存储；默认（无 override）仍建自身 .zcode/v2。
  const dataBaseDirOverride = options?.dataBaseDirOverride?.trim() || undefined;
  if (!dataBaseDirOverride) {
    await mkdir(join(profileDir, ".zcode", "v2"), { recursive: true });
  }
  await mkdir(join(profileDir, "electron-userdata"), { recursive: true });
  await mkdir(join(profileDir, "electron-session"), { recursive: true });
  const record: OmnicodeProfileRecord = {
    id: profileId,
    name: trimmedName,
    createdAt: new Date().toISOString(),
    seq,
    ...(notes?.trim() ? { notes: notes.trim() } : {}),
    ...(dataBaseDirOverride ? { dataBaseDirOverride } : {}),
  };
  await writeJsonAtomic(join(profileDir, "profile.json"), record);
  // 批次1 P2-10：目录所有权标记（防误删用户数据——只有本仓创建的目录才允许整目录删除）
  await writeOwnerMark(profileDir, profileId);
  return toSummary(record);
}

/**
 * [OmniCode] 实例元数据批次：下一个新建实例的 seq（当前 max+1）。读档失败的坏档不参与
 * max 计算（与 listOmnicodeProfiles 的跳过语义一致）；无 profile 时返回 1。
 */
async function nextOmnicodeProfileSeq(): Promise<number> {
  const root = getOmnicodeProfileRoot();
  if (!existsSync(root)) return 1;
  let max = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await readProfileRecord(entry.name);
      if (record && isOmnicodeInstanceSeq(record.seq)) {
        max = Math.max(max, record.seq);
      }
    } catch {
      // 坏档不阻断（seq 是排序提示，非身份事实）
    }
  }
  return max + 1;
}

/**
 * [OmniCode] 实例元数据批次：重命名实例（profileId 稳定性红线：id/seq/createdAt/
 * dataBaseDirOverride/凭据/数据根/锁全部按旧 id 不变，仅 name 更新）。
 * 校验：trim 非空 + 限长 + 重名拒绝（trim 后同名不区分大小写，与收养避让同口径）。
 * 未知 profile 抛错（与 remove 同语义）。
 */
export async function renameOmnicodeProfile(
  profileId: string,
  newName: string,
): Promise<OmnicodeProfileSummary> {
  assertValidProfileId(profileId);
  const trimmedName = newName.trim();
  if (!trimmedName) throw new Error("[omnicode] Profile 名称不能为空");
  if (trimmedName.length > 100) throw new Error("[omnicode] Profile 名称过长（上限 100 字符）");
  const record = await readProfileRecord(profileId);
  if (!record) throw new Error(`[omnicode] profile 不存在: ${profileId}`);
  if (record.name === trimmedName) {
    return toSummary(record); // 同名幂等（无变化不写盘）
  }
  const profiles = await listOmnicodeProfiles();
  const duplicate = profiles.some(
    (profile) =>
      profile.id !== profileId &&
      profile.name.trim().toLowerCase() === trimmedName.toLowerCase(),
  );
  if (duplicate) {
    throw new Error(`[omnicode] 实例名称已存在: ${trimmedName}`);
  }
  const updated: OmnicodeProfileRecord = { ...record, name: trimmedName };
  await writeJsonAtomic(getProfileFilePath(profileId), updated);
  return toSummary(updated);
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

// ─── [OmniCode] 批次2 B2-1：旧控制台收养 + 工作区路由纯函数（spec §批次2 D7） ───

/**
 * 收养可用性（纯决策，供单测）：旧控制台数据根存在凭据文件，且尚无 profile 已指向它。
 * 已收养过的根不再重复提示（重复收养 = 两个实例写同一 .zcode 会话库，串流事故源）。
 */
export function resolveOmnicodeConsoleAdoptionAvailable(
  hasConsoleCredentials: boolean,
  adoptedConsoleDirs: readonly string[],
): boolean {
  if (!hasConsoleCredentials) return false;
  return adoptedConsoleDirs.length === 0;
}

/**
 * 收养 profile 默认名（纯函数）：基础名被占用时追加 " 2"/" 3"/…（与 clone 的
 * `${name} 2` 风格一致）。renderer 也可自带 localized 基础名走同一决策。
 */
export function nextOmnicodeAdoptionProfileName(
  existingNames: readonly string[],
  baseName: string,
): string {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  if (!taken.has(baseName.trim().toLowerCase())) return baseName;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

/** 管理器（控制台）数据根：与 desktopDataBaseDirBootstrap/credentialBackups 同一解析规则。 */
export function getOmnicodeConsoleDataBaseDir(): string {
  return process.env.ZCODE_DATA_BASE_DIR?.trim() || join(homedir(), ".omnicode", "console");
}

/** 旧控制台数据根是否存在凭据文件（收养价值所在：登录态 + 历史会话）。 */
export function hasOmnicodeConsoleCredentials(consoleDataBaseDir: string): boolean {
  return existsSync(join(consoleDataBaseDir, ".zcode", "v2", "credentials.json"));
}

/** 是否已有 profile 的 dataBaseDirOverride 指向目标目录（路径比较归一化，防重复收养）。 */
export async function isOmnicodeDataBaseDirAdopted(targetDir: string): Promise<boolean> {
  const normalizedTarget = resolve(targetDir);
  const root = getOmnicodeProfileRoot();
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const record = await readProfileRecord(entry.name);
      if (
        record?.dataBaseDirOverride &&
        resolve(record.dataBaseDirOverride) === normalizedTarget
      ) {
        return true;
      }
    } catch {
      // 单个坏档不阻断判定（与 listOmnicodeProfiles 同策略）
    }
  }
  return false;
}

/** 收养入口：新建 profile 零拷贝指向旧控制台数据根（名称自增避让既有 profile）。 */
export async function adoptOmnicodeConsoleAsProfile(
  baseName: string,
  consoleDataBaseDir: string,
): Promise<OmnicodeProfileSummary> {
  const normalizedDir = resolve(consoleDataBaseDir);
  if (!hasOmnicodeConsoleCredentials(normalizedDir)) {
    throw new Error("[omnicode] 旧控制台数据根没有凭据文件，无需收养");
  }
  if (await isOmnicodeDataBaseDirAdopted(normalizedDir)) {
    throw new Error("[omnicode] 该数据根已被收养（拒绝重复收养：两个实例写同一会话库）");
  }
  const profiles = await listOmnicodeProfiles();
  const name = nextOmnicodeAdoptionProfileName(
    profiles.map((profile) => profile.name),
    // [OmniCode] B2 评审修复（P2-11①）：main 侧无 i18n 机制，空名兜底改为语言无关字面量
    // （正常路径 renderer 传本地化名称；本地化兜底由 UI 层负责）
    baseName.trim() || "instance-adopted",
  );
  return createOmnicodeProfile(name, undefined, { dataBaseDirOverride: normalizedDir });
}

/**
 * [OmniCode] 批次2 B2-1（T4）：管理器"打开工作区"路由决策（纯函数，供单测）。
 * 恰一实例在跑 → 直转；多实例 → 原生选择框（候选列表）；零实例 → 引导"新建并打开"。
 */
export type OmnicodeWorkspaceOpenRoute =
  | { kind: "single"; profileId: string }
  | { kind: "choose"; profileIds: string[] }
  | { kind: "none" };

export function resolveOmnicodeWorkspaceOpenRoute(
  runningProfileIds: readonly string[],
): OmnicodeWorkspaceOpenRoute {
  if (runningProfileIds.length === 1) {
    return { kind: "single", profileId: runningProfileIds[0]! };
  }
  if (runningProfileIds.length > 1) {
    return { kind: "choose", profileIds: [...runningProfileIds] };
  }
  return { kind: "none" };
}

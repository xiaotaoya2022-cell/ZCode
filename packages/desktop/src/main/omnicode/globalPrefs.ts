// [OmniCode] 批次4 全局偏好层：管理器/实例双身份同步协调器（spec:
// docs/omnicode/global-preferences.md）。
//
// 存储分层（spec §存储）：
// - 管理器 setting.json（~/.omnicode/console/.zcode/v2/setting.json）= setting.json 层
//   全局偏好（locale/localePreference/shortcutBindings）的单一事实源；
// - theme 的官方存储是各进程 localStorage（"zcode-theme"），appSettingsSchema 的 zod
//   strip 不允许它进 setting.json——theme 走桥命令 + 管理器侧 omnicode-global-prefs.json
//   侧车（omnicode 自有文件，官方代码零接触），apply 时经各进程自身 state:theme 广播
//   落各自的 localStorage。
//
// 同步链路（spec §同步语义）：
// - 下行：管理器观察点（BroadcastHub state:* 广播 + SyncAppSettings patch）→ 白名单过滤
//   → 桥命令 applyGlobalPrefs 广播到全部已回连实例（sourceInstanceId=manager）；
// - 上行：实例观察点（同款两路）→ 桥消息 reportGlobalPrefs 上报 → 管理器写自己的全局层
//   → 再下行广播（带源实例 id，源实例收到回声自行忽略——环形抑制）；
// - spawn 注入：启动前把管理器全局层白名单键写入实例 setting.json（未运行实例下次启动
//   生效）；theme 依赖连接即推的全量快照补齐。
//
// 失败语义：全部 fire-and-forget——桥未连接/写入失败只记日志，绝不阻塞管理器，不做重试。
// 官方红线：本模块只被 omnicode 分支/装配点调用；官方 flavor 不初始化协调器（no-op）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  filterOmnicodeGlobalPrefsFromPatch,
  isLocale,
  isOmnicodeGlobalPrefsEchoSelf,
  isOmnicodeRemoteCrossAccountValue,
  isOmnicodeThemePreference,
  isEmptyOmnicodeGlobalPrefsPayload,
  OMNICODE_GLOBAL_PREFS_MANAGER_SOURCE_ID,
  OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY,
  sanitizeOmnicodeGlobalPrefsPayload,
  type Locale,
  type LocalePreference,
  type OmnicodeGlobalPrefsPayload,
} from "@zcode/shared";
import { readJsonWithRecovery, writeJsonAtomic } from "./atomicJson.js";
import { getOmnicodeConsoleDataBaseDir } from "./profileRuntime.js";

const STATE_LOCALE_CHANNEL = "state:locale";
const STATE_THEME_CHANNEL = "state:theme";
/** 管理器全局层 theme 侧车（管理器数据根；omnicode 自有文件，官方零接触）。 */
export const OMNICODE_GLOBAL_PREFS_SIDECAR_FILE = "omnicode-global-prefs.json";

export type OmnicodeGlobalPrefsIdentity = "manager" | "instance" | "official";

export interface OmnicodeGlobalPrefsLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * 协调器依赖注入面（index.ts 装配时提供；纯函数与 IO 解耦，可单测）。
 * getSettings/updateSettings 面向本进程 mainSettingService——管理器与实例的
 * setting.json 都由此读写（官方写队列 + 文件锁，安全并发）。
 */
export interface OmnicodeGlobalPrefsCoordinatorDeps {
  identity: OmnicodeGlobalPrefsIdentity;
  getOwnProfileId: () => string;
  getSettings: () => Promise<{ locale?: Locale; localePreference?: LocalePreference; shortcutBindings?: Record<string, string[]> }>;
  updateSettings: (patch: { locale?: Locale; localePreference?: LocalePreference; shortcutBindings?: Record<string, string[]> }) => Promise<void>;
  /** main 侧注入 state:* 广播到本进程全部 host（BroadcastHub.relayFromOmnicodeMain）。 */
  injectStateBroadcast: (channel: string, payload: unknown) => boolean;
  /** 管理器：向单个已回连实例投递桥命令；返回是否投出（未连接=false，不重试）。 */
  sendApplyToInstance: (profileId: string, command: { type: "applyGlobalPrefs"; prefs: OmnicodeGlobalPrefsPayload; sourceInstanceId: string }) => boolean;
  /** 管理器：当前已回连实例集合（下行广播的目标面）。 */
  getConnectedInstanceProfileIds: () => string[];
  /** 实例：向管理器上报桥消息；返回是否投出（未连接=false，不重试）。 */
  sendReportToManager: (message: { type: "reportGlobalPrefs"; prefs: OmnicodeGlobalPrefsPayload; sourceInstanceId: string }) => boolean;
  /** 快捷键热应用（重建应用菜单 accelerator + 通知各窗口刷新设置快照）。 */
  refreshShortcutApplication: () => void;
  /** 本进程当前界面语言（system 偏好的 resolvedLocale 解析）。 */
  resolveCurrentApplicationLocale: () => Locale;
  logger: OmnicodeGlobalPrefsLogger;
}

interface CoordinatorState {
  deps: OmnicodeGlobalPrefsCoordinatorDeps;
  /** 上报/下行观察点重入抑制：同一载荷短窗内去重（ring 之外的第二道防线）。 */
  lastDispatchedJson: string | null;
}

let coordinator: CoordinatorState | null = null;

/** 装配协调器（幂等：重复装配更新依赖）。official 身份装配成 no-op（观察点直通返回）。 */
export function initOmnicodeGlobalPrefsCoordinator(deps: OmnicodeGlobalPrefsCoordinatorDeps): void {
  coordinator = { deps, lastDispatchedJson: null };
}

export function getOmnicodeGlobalPrefsIdentity(): OmnicodeGlobalPrefsIdentity {
  return coordinator?.deps.identity ?? "official";
}

function isCoordinatorActive(): boolean {
  return coordinator !== null && coordinator.deps.identity !== "official";
}

// ─── 管理器全局层读取（spawn 注入 / 连接即推快照） ───

/**
 * 读管理器全局层快照：setting.json 白名单键（经本进程 mainSettingService）+ theme 侧车。
 * 仅管理器身份可用；其余身份/未装配返回空载荷。
 */
export async function readOmnicodeManagerGlobalPrefsSnapshot(): Promise<OmnicodeGlobalPrefsPayload> {
  if (!coordinator || coordinator.deps.identity !== "manager") return {};
  const prefs: OmnicodeGlobalPrefsPayload = {};
  try {
    const settings = await coordinator.deps.getSettings();
    if (settings.localePreference !== undefined) {
      prefs.localePreference = settings.localePreference;
    }
    if (settings.locale !== undefined) {
      prefs.locale = settings.locale;
    }
    if (settings.shortcutBindings !== undefined) {
      prefs.shortcutBindings = settings.shortcutBindings;
    }
  } catch (error) {
    coordinator.deps.logger.warn("[omnicode] 全局层 setting.json 读取失败（快照降级）:", error);
  }
  const theme = await readOmnicodeGlobalPrefsSidecarTheme();
  if (theme) {
    prefs.theme = theme;
  }
  // [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关进快照（侧车层键，缺席=缺省关）。
  const remoteCrossAccount = await readOmnicodeGlobalPrefsSidecarRemoteCrossAccount();
  if (remoteCrossAccount !== undefined) {
    prefs.omnicodeRemoteCrossAccount = remoteCrossAccount;
  }
  return prefs;
}

/**
 * [OmniCode] 批次4：theme 侧车读档。文件不存在/损坏/字段非法 → undefined（无主题记忆）。
 * 与 console-ui.json 同一读写内核（atomicJson：原子写 + 损坏自愈）。
 */
export async function readOmnicodeGlobalPrefsSidecarTheme(): Promise<OmnicodeGlobalPrefsPayload["theme"]> {
  const sidecarPath = join(getOmnicodeConsoleDataBaseDir(), OMNICODE_GLOBAL_PREFS_SIDECAR_FILE);
  if (!existsSync(sidecarPath)) return undefined;
  const raw = await readJsonWithRecovery<{ theme?: unknown }>(sidecarPath);
  return raw !== undefined && isOmnicodeThemePreference(raw.theme) ? raw.theme : undefined;
}

/**
 * [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关键侧车读档（spec: docs/omnicode/
 * remote-aggregation.md §7）。文件不存在/损坏/字段非法 → undefined（缺省关）。
 */
export async function readOmnicodeGlobalPrefsSidecarRemoteCrossAccount(): Promise<
  OmnicodeGlobalPrefsPayload["omnicodeRemoteCrossAccount"]
> {
  const sidecarPath = join(getOmnicodeConsoleDataBaseDir(), OMNICODE_GLOBAL_PREFS_SIDECAR_FILE);
  if (!existsSync(sidecarPath)) return undefined;
  const raw = await readJsonWithRecovery<Record<string, unknown>>(sidecarPath);
  const value = raw?.[OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY];
  return isOmnicodeRemoteCrossAccountValue(value) ? value : undefined;
}

async function writeOmnicodeGlobalPrefsSidecarTheme(theme: OmnicodeGlobalPrefsPayload["theme"]): Promise<void> {
  const sidecarPath = join(getOmnicodeConsoleDataBaseDir(), OMNICODE_GLOBAL_PREFS_SIDECAR_FILE);
  const existing = existsSync(sidecarPath)
    ? await readJsonWithRecovery<Record<string, unknown>>(sidecarPath)
    : undefined;
  const next: Record<string, unknown> = { ...(existing ?? {}), version: 1 };
  if (theme === undefined) {
    delete next.theme;
  } else {
    next.theme = theme;
  }
  await writeJsonAtomic(sidecarPath, next);
}

/**
 * [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关侧车写档（保留既有 theme 键原样——同一
 * omnicode 自有文件，原子写互不覆盖）。
 */
async function writeOmnicodeGlobalPrefsSidecarRemoteCrossAccount(
  value: OmnicodeGlobalPrefsPayload["omnicodeRemoteCrossAccount"],
): Promise<void> {
  const sidecarPath = join(getOmnicodeConsoleDataBaseDir(), OMNICODE_GLOBAL_PREFS_SIDECAR_FILE);
  const existing = existsSync(sidecarPath)
    ? await readJsonWithRecovery<Record<string, unknown>>(sidecarPath)
    : undefined;
  const next: Record<string, unknown> = { ...existing, version: 1 };
  if (value === undefined) {
    delete next[OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY];
  } else {
    next[OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY] = value;
  }
  await writeJsonAtomic(sidecarPath, next);
}

// ─── 跨账号聚合开关（R4：读取端模块缓存，spec: docs/omnicode/remote-aggregation.md §7）───
// 键值经既有 globalPrefs 下发链到达实例（applyGlobalPrefs 桥命令）：管理器侧事实源 =
// omnicode-global-prefs.json 侧车；实例侧 = 内存缓存（setting.json schema strip 不收该
// 键——红线上同 theme 的侧车裁定）。读取端：宿主（管理器 remoteForwardHost 目录过滤
// deps）与被聚合实例（快照探针同开关的本地读取面）统一经 getOmnicodeRemoteCrossAccountPref。

let remoteCrossAccountPrefCache: boolean | undefined;

/**
 * 跨账号聚合开关当前值（缺省 false = 仅同账号聚合，spec §7 默认关）。
 * 管理器与实例共用：管理器经侧车 seed/自身变更维护；实例经 applyGlobalPrefs 下行维护。
 */
export function getOmnicodeRemoteCrossAccountPref(): boolean {
  return remoteCrossAccountPrefCache ?? false;
}

/**
 * 跨账号聚合开关写入端（管理器设置面；实例改值走上行 reportGlobalPrefs 既有链路）。
 * 更新缓存 + 落侧车 + dispatch 下行广播（fire-and-forget，失败不重试——同步链既有语义）。
 */
export async function setOmnicodeRemoteCrossAccountPref(value: boolean): Promise<void> {
  remoteCrossAccountPrefCache = value;
  if (coordinator?.deps.identity === "manager") {
    try {
      await writeOmnicodeGlobalPrefsSidecarRemoteCrossAccount(value);
    } catch (error) {
      coordinator.deps.logger.warn("[omnicode] 跨账号聚合开关侧车写入失败（不阻断同步）:", error);
    }
    void dispatchOmnicodeGlobalPrefsChange({ omnicodeRemoteCrossAccount: value });
  }
}

/**
 * 管理器装配即从侧车 seed 开关缓存（fire-and-forget；读失败保持缺省关）。
 * 目录查询是事件驱动重推——seed 迟到不影响正确性（下一次广播/连接快照收敛）。
 */
export async function seedOmnicodeRemoteCrossAccountPrefFromSidecar(): Promise<void> {
  try {
    const value = await readOmnicodeGlobalPrefsSidecarRemoteCrossAccount();
    if (value !== undefined) {
      remoteCrossAccountPrefCache = value;
    }
  } catch {
    // 读失败保持缺省关（fail-open 缺省值；下一次变更/连接快照收敛）。
  }
}

/** 测试复位：清空开关缓存（与协调器复位同约定，跨用例隔离）。 */
export function resetOmnicodeRemoteCrossAccountPrefForTest(): void {
  remoteCrossAccountPrefCache = undefined;
}

// ─── 观察点（main/index.ts 装配的两路变更来源） ───

/**
 * 观察点 1：BroadcastHub relay 的 renderer 发起 state:* 广播（官方跨窗口同步既有路径）。
 * 只关心 state:locale / state:theme；白名单过滤后按身份路由（管理器=下行，实例=上行）。
 * 注入路径不经过 relay（relayFromOmnicodeMain 独立方法），本观察点看不到自己的注入，
 * 天然无回环。
 */
export function noteOmnicodeRendererStateBroadcastForGlobalPrefs(
  channel: string,
  payload: unknown,
): void {
  if (!isCoordinatorActive() || !coordinator) return;
  if (channel === STATE_THEME_CHANNEL) {
    if (typeof payload !== "string" || !isOmnicodeThemePreference(payload)) return;
    void dispatchOmnicodeGlobalPrefsChange({ theme: payload });
    return;
  }
  if (channel === STATE_LOCALE_CHANNEL) {
    const fields = resolveOmnicodeLocaleFieldsFromStatePayload(payload);
    if (!fields) return;
    void dispatchOmnicodeGlobalPrefsChange(fields);
  }
}

/** state:locale 载荷（IntlProvider {preference, resolvedLocale} / store 字符串）→ 同步键。 */
export function resolveOmnicodeLocaleFieldsFromStatePayload(
  payload: unknown,
): Pick<OmnicodeGlobalPrefsPayload, "locale" | "localePreference"> | null {
  if (typeof payload === "string") {
    if (!isLocale(payload)) return null;
    return { locale: payload, localePreference: payload };
  }
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { preference?: unknown; resolvedLocale?: unknown };
  const { preference } = candidate;
  if (preference === "system") {
    // system 偏好不携带源进程的解析结果（resolvedLocale 是机器级事实，各进程自解析）。
    return { localePreference: "system" };
  }
  if (isLocale(preference)) {
    return { locale: preference, localePreference: preference };
  }
  return null;
}

/**
 * 观察点 2：SyncAppSettings patch（useSettingService.update 后的 main 即时通道，官方
 * shortcutBindings 菜单重建即走此路）。白名单过滤（红线：白名单外键零触碰）后按身份路由。
 */
export function noteOmnicodeAppSettingsPatchForGlobalPrefs(patch: unknown): void {
  if (!isCoordinatorActive() || !coordinator) return;
  const filtered = filterOmnicodeGlobalPrefsFromPatch(
    patch && typeof patch === "object" ? (patch as Record<string, unknown>) : undefined,
  );
  if (isEmptyOmnicodeGlobalPrefsPayload(filtered)) return;
  void dispatchOmnicodeGlobalPrefsChange(filtered);
}

/**
 * 观察点载荷 → 同步动作。短窗去重：完全相同的载荷 JSON 不重复广播（IntlProvider 与
 * store 双发送者/系统主题切换等可能造成同值重复观察，去重避免广播抖动；不同值不受影响）。
 * 去重状态由 dispatch 与上行接收两条路径共享（report 落地后同样记录），避免
 * A→B→A 序列因过期去重键漏播（见 shouldDispatchOmnicodeGlobalPrefs）。
 */
async function dispatchOmnicodeGlobalPrefsChange(prefs: OmnicodeGlobalPrefsPayload): Promise<void> {
  if (!coordinator) return;
  const { deps } = coordinator;
  const normalized = normalizeOmnicodeGlobalPrefsForDispatch(prefs);
  if (isEmptyOmnicodeGlobalPrefsPayload(normalized)) return;
  if (!shouldDispatchOmnicodeGlobalPrefs(normalized)) return;
  if (deps.identity === "manager") {
    broadcastOmnicodeGlobalPrefsDownstream(normalized, OMNICODE_GLOBAL_PREFS_MANAGER_SOURCE_ID);
    // 管理器自身改 theme 也要落侧车（与上行接收路径同一写盘内核）：manager 的 renderer
    // 已自写 localStorage，但快照读的是侧车——只广播不落盘时，任一实例回连即被推回旧
    // 主题（跨实例漂移，直到某实例用户再改主题才收敛）。fire-and-forget，不阻断广播。
    if (normalized.theme !== undefined) {
      void writeOmnicodeGlobalPrefsSidecarTheme(normalized.theme).catch((error) => {
        deps.logger.warn("[omnicode] manager theme 侧车写入失败（不阻断同步）:", error);
      });
    }
    // [OmniCode] 丙1 远程聚合 R4：管理器自身改跨账号聚合开关 → 缓存即时生效 + 落侧车
    //（与 theme 同一写盘内核；缓存先更新——目录过滤 deps 同步读缓存，不等落盘）。
    if (normalized.omnicodeRemoteCrossAccount !== undefined) {
      remoteCrossAccountPrefCache = normalized.omnicodeRemoteCrossAccount;
      void writeOmnicodeGlobalPrefsSidecarRemoteCrossAccount(normalized.omnicodeRemoteCrossAccount).catch(
        (error) => {
          deps.logger.warn("[omnicode] 跨账号聚合开关侧车写入失败（不阻断同步）:", error);
        },
      );
    }
    return;
  }
  // 实例：上行上报（fire-and-forget；未连接丢弃——下次变更再报，连接即推快照兜底收敛）。
  const sourceInstanceId = deps.getOwnProfileId();
  if (!sourceInstanceId) return;
  const delivered = deps.sendReportToManager({
    type: "reportGlobalPrefs",
    prefs: normalized,
    sourceInstanceId,
  });
  deps.logger.info(
    `[omnicode] 全局偏好上行上报: sourceInstanceId=${sourceInstanceId} keys=${Object.keys(normalized).join(",")} delivered=${delivered}`,
  );
}

/**
 * dispatch 归一：system 偏好剥离 locale（不写死源进程的解析结果），其余键原样。
 */
export function normalizeOmnicodeGlobalPrefsForDispatch(
  prefs: OmnicodeGlobalPrefsPayload,
): OmnicodeGlobalPrefsPayload {
  if (prefs.localePreference === "system") {
    const { locale: _locale, ...rest } = prefs;
    return rest;
  }
  return prefs;
}

/**
 * 去重裁决（比较 + 记录一体化）。返回 false = 与上一次已广播载荷完全相同（无状态变化，
 * 跳过重复广播）。上行接收路径在落地后同样更新记录，保证 A→B→A 序列不会被过期键漏播。
 */
function shouldDispatchOmnicodeGlobalPrefs(normalized: OmnicodeGlobalPrefsPayload): boolean {
  if (!coordinator) return false;
  const payloadJson = JSON.stringify(normalized);
  if (coordinator.lastDispatchedJson === payloadJson) return false;
  coordinator.lastDispatchedJson = payloadJson;
  return true;
}

/**
 * 管理器下行：桥命令广播到全部已回连实例（sourceInstanceId 随命令携带，源实例回声
 * 自行忽略）。fire-and-forget：未连接/投递失败只记日志，不重试不阻塞。
 */
export function broadcastOmnicodeGlobalPrefsDownstream(
  prefs: OmnicodeGlobalPrefsPayload,
  sourceInstanceId: string,
): { delivered: string[]; missed: string[] } {
  if (!coordinator) return { delivered: [], missed: [] };
  const { deps } = coordinator;
  if (isEmptyOmnicodeGlobalPrefsPayload(prefs)) return { delivered: [], missed: [] };
  const delivered: string[] = [];
  const missed: string[] = [];
  for (const profileId of deps.getConnectedInstanceProfileIds()) {
    const ok = deps.sendApplyToInstance(profileId, { type: "applyGlobalPrefs", prefs, sourceInstanceId });
    if (ok) delivered.push(profileId);
    else missed.push(profileId);
  }
  deps.logger.info(
    `[omnicode] 全局偏好下行广播: source=${sourceInstanceId} keys=${Object.keys(prefs).join(",")} delivered=[${delivered.join(",")}] missed=[${missed.join(",")}]`,
  );
  return { delivered, missed };
}

// ─── 上行接收（管理器侧） ───

/**
 * 上行 sourceInstanceId 认证绑定：桥握手已验的 profileId 是唯一可信身份，客户端
 * 自报 sourceInstanceId 不可信（同机实例可伪造他人 id → 该实例把下行误判回声、
 * 漏收本次同步；连接快照兜底收敛，但有界漂移窗口）。真身非空即覆盖自报值；
 * 空真身（理论不可达）回退自报值，保持既有兜底形态。
 */
export function bindOmnicodeGlobalPrefsSourceInstanceId(
  authenticatedProfileId: string,
  reportedSourceInstanceId: string,
): string {
  return authenticatedProfileId || reportedSourceInstanceId || "";
}

export interface OmnicodeGlobalPrefsApplyResult {
  status: "applied" | "echo-ignored" | "noop";
  appliedKeys: string[];
  deferredKeys: string[];
}

/**
 * 管理器收到实例上行 reportGlobalPrefs：写自己的全局层（setting.json 白名单键经
 * mainSettingService + theme 侧车）→ 本进程热应用（state:* 注入 + 快捷键刷新）→
 * 下行广播到全部已回连实例（带源实例 id，源实例收到回声自行忽略）。
 */
export async function handleOmnicodeGlobalPrefsReportFromInstance(
  rawPrefs: unknown,
  rawSourceInstanceId: unknown,
): Promise<OmnicodeGlobalPrefsApplyResult> {
  if (!coordinator) return { status: "noop", appliedKeys: [], deferredKeys: [] };
  const prefs = sanitizeOmnicodeGlobalPrefsPayload(rawPrefs);
  const sourceInstanceId = typeof rawSourceInstanceId === "string" ? rawSourceInstanceId : "";
  if (isEmptyOmnicodeGlobalPrefsPayload(prefs)) {
    coordinator.deps.logger.warn("[omnicode] 全局偏好上行载荷为空/全非法，忽略");
    return { status: "noop", appliedKeys: [], deferredKeys: [] };
  }
  // 同值重复上报不落地（与 dispatch 共享去重状态；A→B→A 序列见
  // shouldDispatchOmnicodeGlobalPrefs 注释）。
  const normalizedForDedup = normalizeOmnicodeGlobalPrefsForDispatch(prefs);
  if (!shouldDispatchOmnicodeGlobalPrefs(normalizedForDedup)) {
    return { status: "noop", appliedKeys: [], deferredKeys: [] };
  }
  const appliedKeys: string[] = [];
  const localeFields = buildOmnicodeLocalePersistFields(prefs);
  if (Object.keys(localeFields).length > 0) {
    try {
      await coordinator.deps.updateSettings(localeFields);
      appliedKeys.push(...Object.keys(localeFields));
    } catch (error) {
      coordinator.deps.logger.warn("[omnicode] 全局层 setting.json 写入失败（不阻断同步）:", error);
    }
  }
  if (prefs.shortcutBindings !== undefined) {
    try {
      await coordinator.deps.updateSettings({ shortcutBindings: prefs.shortcutBindings });
      appliedKeys.push("shortcutBindings");
    } catch (error) {
      coordinator.deps.logger.warn("[omnicode] 全局层 shortcutBindings 写入失败（不阻断同步）:", error);
    }
  }
  if (prefs.theme !== undefined) {
    try {
      await writeOmnicodeGlobalPrefsSidecarTheme(prefs.theme);
      appliedKeys.push("theme");
    } catch (error) {
      coordinator.deps.logger.warn("[omnicode] theme 侧车写入失败（不阻断同步）:", error);
    }
  }
  // [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关上行落地（侧车层键；缓存随
  // applyOmnicodeGlobalPrefsLocally 同步刷新，下行广播沿用既有链路）。
  if (prefs.omnicodeRemoteCrossAccount !== undefined) {
    try {
      await writeOmnicodeGlobalPrefsSidecarRemoteCrossAccount(prefs.omnicodeRemoteCrossAccount);
      appliedKeys.push("omnicodeRemoteCrossAccount");
    } catch (error) {
      coordinator.deps.logger.warn("[omnicode] 跨账号聚合开关侧车写入失败（不阻断同步）:", error);
    }
  }
  applyOmnicodeGlobalPrefsLocally(prefs);
  // 下行广播带源实例 id（环形抑制在源实例侧裁决；管理器不做跳过——连接簿记可能滞后）。
  broadcastOmnicodeGlobalPrefsDownstream(prefs, sourceInstanceId || OMNICODE_GLOBAL_PREFS_MANAGER_SOURCE_ID);
  return { status: "applied", appliedKeys, deferredKeys: [] };
}

/** 上行持久化键集合：system 偏好只落 localePreference（与 dispatch 同一映射）。 */
function buildOmnicodeLocalePersistFields(
  prefs: OmnicodeGlobalPrefsPayload,
): Pick<OmnicodeGlobalPrefsPayload, "locale" | "localePreference"> {
  const fields: Pick<OmnicodeGlobalPrefsPayload, "locale" | "localePreference"> = {};
  if (prefs.localePreference !== undefined) {
    fields.localePreference = prefs.localePreference;
    if (prefs.localePreference !== "system" && prefs.locale !== undefined) {
      fields.locale = prefs.locale;
    }
  } else if (prefs.locale !== undefined) {
    fields.locale = prefs.locale;
  }
  return fields;
}

// ─── 下行接收（实例侧） ───

/**
 * 实例收到 applyGlobalPrefs：环形抑制（源=自己即忽略回声）→ 消毒 → 写自己 setting.json
 * 白名单键（mainSettingService，官方写队列/文件锁）→ 热应用（state:locale / state:theme
 * 注入本进程 BroadcastHub——renderer 走既有广播机制切换；快捷键重建菜单 + 通知窗口刷新）。
 * theme 不写 setting.json（schema strip 会丢）——实例侧事实源是自己的 localStorage。
 */
export async function handleOmnicodeGlobalPrefsApplyCommand(
  rawPrefs: unknown,
  rawSourceInstanceId: unknown,
): Promise<OmnicodeGlobalPrefsApplyResult> {
  if (!coordinator || coordinator.deps.identity !== "instance") {
    return { status: "noop", appliedKeys: [], deferredKeys: [] };
  }
  const { deps } = coordinator;
  const prefs = sanitizeOmnicodeGlobalPrefsPayload(rawPrefs);
  const sourceInstanceId = typeof rawSourceInstanceId === "string" ? rawSourceInstanceId : "";
  if (isOmnicodeGlobalPrefsEchoSelf(sourceInstanceId, deps.getOwnProfileId())) {
    deps.logger.info(
      `[omnicode] 全局偏好回声忽略（环形抑制）: sourceInstanceId=${sourceInstanceId}`,
    );
    return { status: "echo-ignored", appliedKeys: [], deferredKeys: [] };
  }
  if (isEmptyOmnicodeGlobalPrefsPayload(prefs)) return { status: "noop", appliedKeys: [], deferredKeys: [] };
  const appliedKeys: string[] = [];
  const deferredKeys: string[] = [];
  const localeFields = buildOmnicodeLocalePersistFields(prefs);
  if (Object.keys(localeFields).length > 0) {
    try {
      await deps.updateSettings(localeFields);
      appliedKeys.push(...Object.keys(localeFields));
    } catch (error) {
      deferredKeys.push(...Object.keys(localeFields));
      deps.logger.warn("[omnicode] 实例 setting.json 写入失败（待下次同步收敛）:", error);
    }
  }
  if (prefs.shortcutBindings !== undefined) {
    try {
      await deps.updateSettings({ shortcutBindings: prefs.shortcutBindings });
      appliedKeys.push("shortcutBindings");
    } catch (error) {
      deferredKeys.push("shortcutBindings");
      deps.logger.warn("[omnicode] 实例 shortcutBindings 写入失败（待下次同步收敛）:", error);
    }
  }
  applyOmnicodeGlobalPrefsLocally(prefs);
  deps.logger.info(
    `[omnicode] 全局偏好应用: source=${sourceInstanceId} applied=[${appliedKeys.join(",")}] deferred=[${deferredKeys.join(",")}]`,
  );
  return { status: "applied", appliedKeys, deferredKeys };
}

/** 本进程热应用：state:locale / state:theme 注入 + 快捷键菜单刷新（全部 best-effort）。 */
function applyOmnicodeGlobalPrefsLocally(prefs: OmnicodeGlobalPrefsPayload): void {
  if (!coordinator) return;
  const { deps } = coordinator;
  // [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关热应用 = 本进程缓存更新（上行/下行两条
  // 路径共用；manager/instance 身份一致——remoteForwardHost 目录过滤与实例读取端同源）。
  if (prefs.omnicodeRemoteCrossAccount !== undefined) {
    remoteCrossAccountPrefCache = prefs.omnicodeRemoteCrossAccount;
  }
  if (prefs.theme !== undefined) {
    try {
      deps.injectStateBroadcast(STATE_THEME_CHANNEL, prefs.theme);
    } catch (error) {
      deps.logger.warn("[omnicode] state:theme 注入失败:", error);
    }
  }
  if (prefs.localePreference !== undefined || prefs.locale !== undefined) {
    const preference: LocalePreference = prefs.localePreference ?? prefs.locale ?? "system";
    const resolvedLocale: Locale =
      preference === "system"
        ? deps.resolveCurrentApplicationLocale()
        : (prefs.locale ?? preference);
    try {
      deps.injectStateBroadcast(STATE_LOCALE_CHANNEL, {
        preference,
        resolvedLocale,
      });
    } catch (error) {
      deps.logger.warn("[omnicode] state:locale 注入失败:", error);
    }
  }
  if (prefs.shortcutBindings !== undefined) {
    try {
      deps.refreshShortcutApplication();
    } catch (error) {
      deps.logger.warn("[omnicode] 快捷键热应用失败（下次启动生效）:", error);
    }
  }
}

// ─── spawn 注入（启动前写入实例 setting.json） ───

/**
 * spawn 注入（spec §spawn 注入）：启动实例前把管理器全局层 setting.json 白名单键合并进
 * 实例 setting.json。方案取舍（详见 spec）：选「spawn 前文件合并」而非「启动握手下发」
 * ——首帧即正确（语言/快捷键不闪变）、无桥连接时序依赖、天然覆盖"未运行实例下次启动
 * 生效"；连接即推快照保留为 theme 与收敛兜底。
 * 实现：raw JSON 读 → 白名单键浅合并（缺键不覆盖实例自有值）→ 原子写。失败 fail-open
 * （只告警不阻断启动——注入是增强，不是启动前置条件）。
 */
export async function injectOmnicodeGlobalPrefsForSpawn(instanceSettingsFile: string): Promise<void> {
  if (!coordinator || coordinator.deps.identity !== "manager") return;
  let snapshot: OmnicodeGlobalPrefsPayload;
  try {
    snapshot = await readOmnicodeManagerGlobalPrefsSnapshot();
  } catch (error) {
    coordinator.deps.logger.warn("[omnicode] spawn 注入读取全局层失败（跳过注入）:", error);
    return;
  }
  try {
    const written = await mergeOmnicodeGlobalPrefsIntoSettingsFile(instanceSettingsFile, snapshot);
    if (written.length > 0) {
      coordinator.deps.logger.info(
        `[omnicode] spawn 全局偏好注入: keys=[${written.join(",")}] file=${instanceSettingsFile}`,
      );
    }
  } catch (error) {
    coordinator.deps.logger.warn("[omnicode] spawn 全局偏好注入失败（不阻断启动）:", error);
  }
}

/**
 * setting.json 白名单键合并（spawn 注入内核；纯 IO 封装，可单测）：读现有内容 →
 * 只覆盖快照中存在的白名单键（locale 按 system 映射）→ 原子写回；实例其余键原样保留。
 * theme 不写 setting.json（schema strip），由连接即推快照交付。文件不存在时按空对象
 * 起步（首启实例）。返回实际写入的键名。
 */
export async function mergeOmnicodeGlobalPrefsIntoSettingsFile(
  instanceSettingsFile: string,
  snapshot: OmnicodeGlobalPrefsPayload,
): Promise<string[]> {
  let raw: Record<string, unknown> = {};
  if (existsSync(instanceSettingsFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(instanceSettingsFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // 既有内容不可解析：不覆盖（fail-open；实例自身 settingService 有损坏隔离链路）
      return [];
    }
  }
  const localeFields = buildOmnicodeLocalePersistFields(snapshot);
  const next: Record<string, unknown> = { ...raw };
  const written: string[] = [];
  if (localeFields.localePreference !== undefined) {
    next.localePreference = localeFields.localePreference;
    written.push("localePreference");
    if (localeFields.localePreference === "system") {
      // system = 不钉死具体语言：清掉实例档里的 locale 缓存（含旧 uiLocale 影子不删——
      // 该影子由各实例自己的 settingService 迁移写盘维护；IntlProvider 启动按偏好
      // 解析，偏好=system 时实例自解析系统语言并自愈写回）。
      delete next.locale;
    }
  }
  if (localeFields.locale !== undefined) {
    next.locale = localeFields.locale;
    written.push("locale");
  }
  if (snapshot.shortcutBindings !== undefined) {
    next.shortcutBindings = snapshot.shortcutBindings;
    written.push("shortcutBindings");
  }
  // [OmniCode] 丙1 远程聚合 R4：omnicodeRemoteCrossAccount 不进 setting.json（appSettings
  // schema strip 会在下次写盘丢弃未知键——与 theme 同款裁定）；实例侧经连接即推快照
  // 交付到内存缓存（getOmnicodeRemoteCrossAccountPref），跨账号过滤权威在管理器目录视图。
  if (written.length === 0) return [];
  await writeJsonAtomic(instanceSettingsFile, next);
  return written;
}

// ─── 连接即推快照（管理器侧，桥 onInstanceConnected 钩子） ───

/**
 * 实例回连即推送当前全局层快照（theme 的主要交付面 + 长断连实例的收敛兜底）。
 * sourceInstanceId=manager（实例侧无回声问题）。fire-and-forget。
 */
export async function pushOmnicodeGlobalPrefsSnapshotToInstance(profileId: string): Promise<void> {
  if (!coordinator || coordinator.deps.identity !== "manager") return;
  try {
    const snapshot = await readOmnicodeManagerGlobalPrefsSnapshot();
    if (isEmptyOmnicodeGlobalPrefsPayload(snapshot)) return;
    const ok = coordinator.deps.sendApplyToInstance(profileId, {
      type: "applyGlobalPrefs",
      prefs: snapshot,
      sourceInstanceId: OMNICODE_GLOBAL_PREFS_MANAGER_SOURCE_ID,
    });
    coordinator.deps.logger.info(
      `[omnicode] 连接即推全局偏好快照: profileId=${profileId} keys=${Object.keys(snapshot).join(",")} delivered=${ok}`,
    );
  } catch (error) {
    coordinator.deps.logger.warn("[omnicode] 连接即推全局偏好快照失败（不阻断）:", error);
  }
}

/** 重置协调器（测试专用）。 */
export function resetOmnicodeGlobalPrefsCoordinatorForTest(): void {
  coordinator = null;
}

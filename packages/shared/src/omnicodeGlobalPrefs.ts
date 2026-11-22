// [OmniCode] 批次4 全局偏好层：跨实例共享的偏好白名单与纯函数（spec:
// docs/omnicode/global-preferences.md）。
//
// 设计准则（README slogan）：帮助不随实例数放大的能力就该被共享——语言/外观/快捷键
// 这类偏好，五个账号没必要五种设置。管理器 setting.json（~/.omnicode/console/.zcode/
// v2/setting.json）即全局层；本模块只定义「哪些键允许跨实例同步」与键值形状，
// 同步链路（桥命令/环形抑制/spawn 注入）在 desktop 侧 omnicode 模块实现。
//
// 红线：
// - 白名单外的键绝不同步（模型/凭据/工作区/会话键是 per-instance 红线）——所有
//   过滤器都以「先取白名单交集，再逐键值域校验」收口，未知/非法键一律丢弃；
// - 官方 flavor 零改动：本模块是纯函数库，官方代码路径不导入它。

import { isLocale, isLocalePreference } from "./locale.js";
import type { Locale, LocalePreference } from "./protocol.js";

/**
 * setting.json 层的全局偏好白名单（实测探测结论，spec §键清单）：
 * - locale / localePreference：设置页 general 分区的界面语言（内存 schema 键；
 *   落盘时 settingService 另写 uiLocale/uiLocalePreference 降级影子，由其自身维护，
 *   不在同步面内——同步值经各实例自己的 settingService.update 落盘，影子自动跟随）。
 * - shortcutBindings：设置页 shortcuts 分区的键位覆盖表。
 * 白名单外的键（providerFamily*、sourceServers、connectionProfiles、webRemoteControl*、
 * recentProjects、lastWorkspaceSession、dataBaseDir 等模型/凭据/工作区/会话键）是
 * per-instance 红线，过滤器必须丢弃。
 */
export const OMNICODE_GLOBAL_PREF_KEYS = [
  "locale",
  "localePreference",
  "shortcutBindings",
  // [OmniCode] 模式二 R4（spec: docs/omnicode/multi-account-sessions.md §6）：智能调度
  // 开关（默认开）。走既有键体系（白名单过滤 + 值域校验 + 环形抑制/下发链）跨实例共享；
  // 缺席（旧档）= 开（spec §6 "开关式默认开"）。
  "omnicodeSmartScheduling",
] as const;

export type OmnicodeGlobalPrefKey = (typeof OMNICODE_GLOBAL_PREF_KEYS)[number];

/** 智能调度开关值域（布尔；非法值一律丢弃，缺席=开）。 */
export function isOmnicodeSmartSchedulingValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** 智能调度缺省值（spec §6：开关式默认开）。 */
export const OMNICODE_SMART_SCHEDULING_DEFAULT = true;

/**
 * 外观主题键（批次4 实测：theme 官方存储是各进程 localStorage 的 "zcode-theme"，
 * 不是 setting.json 键——appSettingsSchema 的 zod strip 会在下次写盘时丢弃未知键）。
 * 因此 theme 不进 OMNICODE_GLOBAL_PREF_KEYS（setting.json 键白名单），而是走
 * 桥命令 + 管理器侧 omnicode-global-prefs.json 侧车持久化（omnicode 自有文件，
 * 官方代码零接触），apply 时经各进程自身 state:theme 广播机制落自己的 localStorage。
 */
export const OMNICODE_THEME_PREF_KEY = "theme";

/** 主题偏好值域（store/useTheme normalize 后的规范形态；light/dark 归一为 zai-*）。 */
export type OmnicodeThemePreference = "system" | "zai-light" | "zai-dark";

export function isOmnicodeThemePreference(value: unknown): value is OmnicodeThemePreference {
  return value === "system" || value === "zai-light" || value === "zai-dark";
}

/**
 * [OmniCode] 丙1 远程聚合 R4（spec: docs/omnicode/remote-aggregation.md §7/§8-R4）：
 * 跨账号聚合开关（布尔，缺省 false = 仅同账号聚合，spec §7 红线）。
 * 存储分层与 theme 同款：**不进 setting.json**（appSettingsSchema 的 zod strip 会在
 * 下次写盘丢弃未知键）——走管理器侧 omnicode-global-prefs.json 侧车持久化 + 桥命令
 * 下发（applyGlobalPrefs 同款通道），实例侧内存消费（目录过滤权威在管理器：只有
 * 管理器同时持有宿主账号与各实例账号族事实）。
 */
export const OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY = "omnicodeRemoteCrossAccount";

/** 跨账号聚合开关值域（布尔；缺省/非法 = false）。 */
export function isOmnicodeRemoteCrossAccountValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** 快捷键覆盖表值域：键名非空字符串 → 数组（元素为非空字符串组合键）。 */
export function isOmnicodeShortcutBindingsValue(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, bindings] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0) return false;
    if (!Array.isArray(bindings)) return false;
    for (const binding of bindings) {
      if (typeof binding !== "string" || binding.length === 0) return false;
    }
  }
  return true;
}

/** 跨实例同步的偏好载荷（全部字段可选；只允许白名单 + theme，且值域逐键校验）。 */
export interface OmnicodeGlobalPrefsPayload {
  locale?: Locale;
  localePreference?: LocalePreference;
  shortcutBindings?: Record<string, string[]>;
  theme?: OmnicodeThemePreference;
  // [OmniCode] 模式二 R4：智能调度开关（默认开；值域布尔）。
  omnicodeSmartScheduling?: boolean;
  // [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关（默认关 = 仅同账号聚合，spec §7）。
  omnicodeRemoteCrossAccount?: boolean;
}

function hasOwnObject(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * 白名单过滤器（settings patch → 同步载荷）。纯函数、可单测：
 * 只保留白名单键 + theme，且逐键值域校验；白名单外的键（含伪造的敏感键）与
 * 值域不合法的键一律丢弃。原型链污染键（__proto__ 等）经 own-property 检查天然免疫。
 */
export function filterOmnicodeGlobalPrefsFromPatch(
  patch: Record<string, unknown> | null | undefined,
): OmnicodeGlobalPrefsPayload {
  const filtered: OmnicodeGlobalPrefsPayload = {};
  if (!patch || typeof patch !== "object") return filtered;
  if (hasOwnObject(patch, "locale") && isLocale(patch.locale)) {
    filtered.locale = patch.locale;
  }
  if (hasOwnObject(patch, "localePreference") && isLocalePreference(patch.localePreference)) {
    filtered.localePreference = patch.localePreference;
  }
  if (hasOwnObject(patch, "shortcutBindings") && isOmnicodeShortcutBindingsValue(patch.shortcutBindings)) {
    filtered.shortcutBindings = patch.shortcutBindings;
  }
  if (hasOwnObject(patch, OMNICODE_THEME_PREF_KEY) && isOmnicodeThemePreference(patch.theme)) {
    filtered.theme = patch.theme;
  }
  // [OmniCode] 模式二 R4：智能调度开关（布尔值域；非法值丢弃，缺席=开）。
  if (
    hasOwnObject(patch, "omnicodeSmartScheduling") &&
    isOmnicodeSmartSchedulingValue(patch.omnicodeSmartScheduling)
  ) {
    filtered.omnicodeSmartScheduling = patch.omnicodeSmartScheduling;
  }
  // [OmniCode] 丙1 远程聚合 R4：跨账号聚合开关（布尔值域；非法值丢弃，缺席=关 = 仅同
  // 账号聚合，spec §7 红线：默认关闭）。
  if (
    hasOwnObject(patch, OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY) &&
    isOmnicodeRemoteCrossAccountValue(patch[OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY])
  ) {
    filtered.omnicodeRemoteCrossAccount = patch[OMNICODE_REMOTE_CROSS_ACCOUNT_PREF_KEY];
  }
  return filtered;
}

/**
 * 桥命令载荷消毒（不可信 JSON → 载荷）。与 filterOmnicodeGlobalPrefsFromPatch 同一
 * 收口，但接受任意 unknown（桥帧不可信面更大：同机任意进程都能构造 JSON——当然它
 * 过不了桥握手 token，纵深防御仍逐键消毒）。
 */
export function sanitizeOmnicodeGlobalPrefsPayload(raw: unknown): OmnicodeGlobalPrefsPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return filterOmnicodeGlobalPrefsFromPatch(raw as Record<string, unknown>);
}

/** 载荷是否为空（无任何可同步键）。 */
export function isEmptyOmnicodeGlobalPrefsPayload(payload: OmnicodeGlobalPrefsPayload): boolean {
  return Object.keys(payload).length === 0;
}

/**
 * 环形抑制判定（spec §同步语义）：桥广播携带 sourceInstanceId，接收方身份相同即忽略
 * 自己的回声（避免 实例→管理器→广播→源实例→再上报 的潜在环路）。管理器源用
 * OMNICODE_GLOBAL_PREFS_MANAGER_SOURCE_ID；管理器不是实例，永不与 profileId 相等。
 */
export const OMNICODE_GLOBAL_PREFS_MANAGER_SOURCE_ID = "manager";

export function isOmnicodeGlobalPrefsEchoSelf(
  sourceInstanceId: string,
  ownInstanceId: string,
): boolean {
  return sourceInstanceId.length > 0 && sourceInstanceId === ownInstanceId;
}

/**
 * locale 键映射（偏好 → setting.json 同步键集合）：
 * - 具体语言偏好：locale 与 localePreference 同步（locale 是落盘的解析结果缓存）；
 * - system 偏好：只同步 localePreference——各实例（同一台机器）按自身系统语言解析，
 *   不把源进程的解析结果写死进对端 setting.json。
 * 返回值只含需写入的键；空对象表示无可同步内容。
 */
export function buildOmnicodeLocaleSyncFields(
  locale: Locale | undefined,
  localePreference: LocalePreference | undefined,
): Pick<OmnicodeGlobalPrefsPayload, "locale" | "localePreference"> {
  const fields: Pick<OmnicodeGlobalPrefsPayload, "locale" | "localePreference"> = {};
  if (localePreference !== undefined) {
    fields.localePreference = localePreference;
    if (localePreference !== "system" && locale !== undefined) {
      fields.locale = locale;
    }
  } else if (locale !== undefined) {
    // 只有 locale 无偏好（如官方旧档）：同步 locale 保底，偏好语义由对端自身决定。
    fields.locale = locale;
  }
  return fields;
}

import type { Locale } from "@zcode/shared";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";
import jaJP from "./locales/ja-JP.js";
import ruRU from "./locales/ru-RU.js";
import koKR from "./locales/ko-KR.js";

// 编译期产品身份（vite/tsup define 注入 __ZCODE_PRODUCT_FLAVOR__，与 packages/shared/src/env.ts
// 的 ZCODE_PRODUCT_FLAVOR 同源）。这里必须直接判 define 字面量，而不是经 normalizeZCodeProductFlavor
// 计算的模块常量：只有字面量比较才能被打包器常量折叠，官方 flavor 构建才能把 omnicode 惰性分支
// 连同四份 locale 的静态 import 一起裁掉（官方产物代码路径逐字不变）。
// 非打包环境（vitest 单测、tsx fixture 脚本）没有 define，一律走官方全量分支。
declare const __ZCODE_PRODUCT_FLAVOR__: string;

/**
 * 编译期 omnicode flavor 判定。导出供 IntlProvider 的就绪闸与单测（vi.mock 覆写）复用；
 * 运行时永远不要再对该值做字符串加工，保持可折叠性。
 */
export const OMNICODE_FLAVOR_COMPILED =
  typeof __ZCODE_PRODUCT_FLAVOR__ !== "undefined" && __ZCODE_PRODUCT_FLAVOR__ === "omnicode";

/**
 * 语言 → 翻译消息映射。IntlProvider 与 ErrorBoundary 共用这一份。
 * 日/俄/韩文案表可能缺 key（例如官方版本安全校验文案只有中英），缺失时先回退 en-US，
 * 避免界面直接露出 key；中文表是完整的，不需要合并。
 *
 * flavor 门控（编译期常量折叠，零行为差异）：
 * - 官方 flavor（production/preview）：五 locale 全量同步急载——官方分支的对象逐字保留，
 *   产物行为与历史完全一致。
 * - omnicode flavor：仅 en-US 同步急载（ErrorBoundary 崩溃兜底：崩溃时无网络、无异步），
 *   其余四语言经下方 ensureLocaleMessages 动态 import 注册表异步加载。注意非 en 槽位填的
 *   是 en 兜底占位表，渲染就绪判定不读本表（读 getSyncLocaleMessages 的注册表实况），
 *   占位只为 ErrorBoundary 的同步兜底查询不会拿到 undefined 再崩一层。
 */
export const LOCALE_MESSAGES: Record<Locale, Record<string, string>> = OMNICODE_FLAVOR_COMPILED
  ? {
      // omnicode：en 兜底占位（见上方说明）；真实翻译表走 LAZY_LOCALE_LOADERS 异步注册。
      "zh-CN": enUS,
      "en-US": enUS,
      "ja-JP": enUS,
      "ru-RU": enUS,
      "ko-KR": enUS,
    }
  : {
      // 官方 flavor：全量同步急载（历史代码逐字保留）。
      "zh-CN": zhCN,
      "en-US": enUS,
      "ja-JP": { ...enUS, ...jaJP },
      "ru-RU": { ...enUS, ...ruRU },
      "ko-KR": { ...enUS, ...koKR },
    };

/** omnicode flavor 专用的动态 import 装载器：非 en locale 打成独立 async chunk，首次访问时加载。 */
const LAZY_LOCALE_LOADERS: Partial<Record<Locale, () => Promise<Record<string, string>>>> = {
  "zh-CN": () => import("./locales/zh-CN.js").then((module) => module.default),
  "ja-JP": () => import("./locales/ja-JP.js").then((module) => ({ ...enUS, ...module.default })),
  "ru-RU": () => import("./locales/ru-RU.js").then((module) => ({ ...enUS, ...module.default })),
  "ko-KR": () => import("./locales/ko-KR.js").then((module) => ({ ...enUS, ...module.default })),
};

export interface LazyLocaleMessagesRegistry {
  /** 注册表当前同步可读的表；未加载返回 undefined。 */
  getSync(locale: Locale): Record<string, string> | undefined;
  /**
   * 确保指定 locale 的表就绪并返回；并发调用合并为一次装载。
   * 装载失败不抛错：回落 en-US 同步表并固化（本次会话内不再自动重试），
   * 保证 IntlProvider 的就绪闸总能推进、启动不会被网络故障永久卡住。
   */
  ensure(locale: Locale): Promise<Record<string, string>>;
}

/**
 * 惰性 locale 注册表（omnicode flavor）。纯函数构造，便于单测注入假装载器验证
 * 并发合并、失败回落与加载后内容与官方全量表逐字一致。
 */
export function createLazyLocaleMessagesRegistry({
  fallbackMessages,
  initialMessages,
  loadLocaleMessages,
}: {
  /** 加载失败/无装载器时的回落表（omnicode = en-US 同步表）。 */
  fallbackMessages: Record<string, string>;
  /** 启动即同步可用的表（omnicode = en-US）。 */
  initialMessages?: Partial<Record<Locale, Record<string, string>>>;
  /** 返回 undefined 表示该 locale 没有异步源（视为同步可用，直接固化回落表）。 */
  loadLocaleMessages: (locale: Locale) => (() => Promise<Record<string, string>>) | undefined;
}): LazyLocaleMessagesRegistry {
  const syncMessages = new Map<Locale, Record<string, string>>(
    Object.entries(initialMessages ?? {}) as Array<[Locale, Record<string, string>]>,
  );
  const inflight = new Map<Locale, Promise<Record<string, string>>>();
  return {
    getSync(locale) {
      return syncMessages.get(locale);
    },
    ensure(locale) {
      const ready = syncMessages.get(locale);
      if (ready) {
        return Promise.resolve(ready);
      }
      const loader = loadLocaleMessages(locale);
      if (!loader) {
        // 无异步源：固化回落表，避免每次 ensure 都重复解析。
        syncMessages.set(locale, fallbackMessages);
        return Promise.resolve(fallbackMessages);
      }
      const pending = inflight.get(locale);
      if (pending) {
        return pending;
      }
      const promise = loader()
        .then((messages) => {
          syncMessages.set(locale, messages);
          return messages;
        })
        .catch(() => {
          syncMessages.set(locale, fallbackMessages);
          return fallbackMessages;
        })
        .finally(() => {
          inflight.delete(locale);
        });
      inflight.set(locale, promise);
      return promise;
    },
  };
}

const OMNICODE_LOCALE_REGISTRY = OMNICODE_FLAVOR_COMPILED
  ? createLazyLocaleMessagesRegistry({
      fallbackMessages: enUS,
      initialMessages: { "en-US": enUS },
      loadLocaleMessages: (locale) => LAZY_LOCALE_LOADERS[locale],
    })
  : null;

/**
 * 当前可同步渲染的 locale 表：
 * - 官方 flavor：LOCALE_MESSAGES 全量（与历史行为逐字一致，永不为 undefined）。
 * - omnicode flavor：注册表实况（en-US 恒有；四语言仅在 ensure 装载后出现）。
 * IntlProvider 的渲染就绪判定与 createIntl 都走这里；ErrorBoundary 崩溃兜底不走这里
 * （它直接读 LOCALE_MESSAGES，拿 en 占位表即可，崩溃路径不引入异步）。
 */
export function getSyncLocaleMessages(locale: Locale): Record<string, string> | undefined {
  if (OMNICODE_FLAVOR_COMPILED) {
    return OMNICODE_LOCALE_REGISTRY?.getSync(locale);
  }
  return LOCALE_MESSAGES[locale];
}

/** 确保 locale 表可同步渲染；装载失败回落 en-US 同步表（永不 reject）。 */
export function ensureLocaleMessages(locale: Locale): Promise<Record<string, string>> {
  if (OMNICODE_FLAVOR_COMPILED) {
    return (
      OMNICODE_LOCALE_REGISTRY?.ensure(locale) ??
      Promise.resolve(LOCALE_MESSAGES[locale] ?? LOCALE_MESSAGES["en-US"]!)
    );
  }
  return Promise.resolve(LOCALE_MESSAGES[locale] ?? LOCALE_MESSAGES["en-US"]!);
}

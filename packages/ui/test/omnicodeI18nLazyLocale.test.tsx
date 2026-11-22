// [OmniCode] 渲染器性能优化（batch4 审计 #2）：i18n 非 en locale 惰性化——官方分支行为等价单测。
// 测试环境（vitest/tsx）没有 __ZCODE_PRODUCT_FLAVOR__ define，一律走官方全量同步分支：
// 本文件断言官方语义逐字不变（五 locale 全量急载、getSync/ensure 直通、SSR 首帧直接出翻译），
// 并用假装载器单测 omnicode 注册表的装载/并发合并/失败回落逻辑。
// omnicode 分支的 Provider 级 wiring（启动闸/切换保持/失败回落）见 omnicodeI18nProviderGate.test.tsx。
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createLazyLocaleMessagesRegistry,
  ensureLocaleMessages,
  getSyncLocaleMessages,
  LOCALE_MESSAGES,
  OMNICODE_FLAVOR_COMPILED,
} from "@/i18n/localeMessages.js";
import enUS from "@/i18n/locales/en-US.js";
import jaJP from "@/i18n/locales/ja-JP.js";
import koKR from "@/i18n/locales/ko-KR.js";
import ruRU from "@/i18n/locales/ru-RU.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import type { Locale } from "@zcode/shared";

/** 探针：渲染两条真实 key 的翻译，用于 SSR 行为等价断言。 */
function SsrText(): string {
  const { intl } = useZCodeIntl();
  return (
    <>
      {intl.formatMessage({ id: "appError.title" })}|{intl.formatMessage({ id: "common.cancel" })}
    </>
  );
}

function renderSsr(initialLocale: Locale): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={initialLocale}>
      <SsrText />
    </ZCodeIntlProvider>,
  );
}

describe("omnicode i18n 惰性化：官方分支（无 define 环境）行为等价", () => {
  it("测试环境编译期门控为官方（OMNICODE_FLAVOR_COMPILED=false）", () => {
    // 该断言同时守护：vitest/tsx 等非打包环境永远走官方全量分支，历史行为零漂移。
    expect(OMNICODE_FLAVOR_COMPILED).toBe(false);
  });

  it("五 locale 全量急载，且合并语义逐字保留（缺 key 回退 en-US）", () => {
    const nativeTables: Array<{
      locale: Locale;
      native: Record<string, string>;
      expectMerged: boolean;
    }> = [
      { locale: "zh-CN", native: zhCN, expectMerged: false },
      { locale: "en-US", native: enUS, expectMerged: false },
      { locale: "ja-JP", native: jaJP, expectMerged: true },
      { locale: "ru-RU", native: ruRU, expectMerged: true },
      { locale: "ko-KR", native: koKR, expectMerged: true },
    ];

    for (const { locale, native, expectMerged } of nativeTables) {
      const table = LOCALE_MESSAGES[locale];
      expect(table, `${locale} 表必须存在`).toBeDefined();
      // 合并表：native 的每个 key 取 native 值（覆盖 en）；表内其余 key 必须来自 enUS。
      for (const [key, value] of Object.entries(native)) {
        expect(table?.[key], `${locale}.${key} 必须取本语言文案`).toBe(value);
      }
      const enKeys = new Set(Object.keys(enUS));
      for (const key of Object.keys(table ?? {})) {
        expect(
          native[key] !== undefined || enKeys.has(key),
          `${locale}.${key} 必须来自本语言表或 en-US 表`,
        ).toBe(true);
      }
      // 合并语义抽查：仅存在于 en 的官方安全校验类 key 在合并表里可读（缺 key 回退 en-US）。
      const enOnlyKey = Object.keys(enUS).find((key) => native[key] === undefined);
      if (expectMerged) {
        expect(enOnlyKey).toBeDefined();
        expect(table?.[enOnlyKey!]).toBe(enUS[enOnlyKey!]);
      }
    }
    // 官方安全校验文案只注入中英：ja/ru/ko 合并表必须回落到 en 值（逐字）。
    expect(LOCALE_MESSAGES["ja-JP"]?.["zcode.error.modelSuspiciousEmpty"]).toBe(
      enUS["zcode.error.modelSuspiciousEmpty"],
    );
  });

  it("getSyncLocaleMessages 官方直通：全量、永不为 undefined", () => {
    for (const locale of ["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"] as const) {
      expect(getSyncLocaleMessages(locale)).toBe(LOCALE_MESSAGES[locale]);
    }
  });

  it("ensureLocaleMessages 官方直通：立即 resolve 全量表", async () => {
    for (const locale of ["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"] as const) {
      await expect(ensureLocaleMessages(locale)).resolves.toBe(LOCALE_MESSAGES[locale]);
    }
  });

  it("SSR 首帧直接渲染该语言翻译（无启动闸、不闪英文、不吐 key）", () => {
    expect(renderSsr("zh-CN")).toContain("应用界面出了点问题");
    expect(renderSsr("zh-CN")).toContain("取消");
    expect(renderSsr("ja-JP")).toContain("アプリで問題が発生しました");
    expect(renderSsr("en-US")).toContain("The app ran into a problem");
    // 缺 key 回退：ja 表没有的 key（官方安全校验文案只注入中英）渲染 en 值而非裸 key。
    const jaMarkup = renderToStaticMarkup(
      <ZCodeIntlProvider initialLocale="ja-JP">
        <EnOnlyProbe />
      </ZCodeIntlProvider>,
    );
    expect(jaMarkup).toContain(
      "The model returned no content (often caused by an expired token or plan issues). Please send again.",
    );
  });
});

/** 渲染仅存在于 en-US 的官方安全校验 key，验证缺 key 回退语义。 */
function EnOnlyProbe(): string {
  const { intl } = useZCodeIntl();
  return <>{intl.formatMessage({ id: "zcode.error.modelSuspiciousEmpty" })}</>;
}

describe("omnicode i18n 惰性化：惰性注册表（omnicode 分支逻辑）", () => {
  const enFallback = { "probe.title": "Fallback", "probe.extra": "Extra" };

  function makeRegistry(
    loaders: Partial<Record<Locale, () => Promise<Record<string, string>>>>,
    initial?: Partial<Record<Locale, Record<string, string>>>,
  ) {
    return createLazyLocaleMessagesRegistry({
      fallbackMessages: enFallback,
      initialMessages: initial,
      loadLocaleMessages: (locale) => loaders[locale],
    });
  }

  it("装载后的表与官方全量表逐字一致（渲染输出零漂移）", async () => {
    const registry = makeRegistry({
      "zh-CN": async () => zhCN,
      "ja-JP": async () => ({ ...enUS, ...jaJP }),
      "ru-RU": async () => ({ ...enUS, ...ruRU }),
      "ko-KR": async () => ({ ...enUS, ...koKR }),
    });

    expect(registry.getSync("zh-CN")).toBeUndefined();
    for (const locale of ["zh-CN", "ja-JP", "ru-RU", "ko-KR"] as const) {
      const loaded = await registry.ensure(locale);
      // 与官方分支的表内容深度一致——omnicode 异步装载后渲染输出与官方全量急载完全相同。
      expect(loaded).toEqual(LOCALE_MESSAGES[locale]);
      expect(registry.getSync(locale)).toBe(loaded);
    }
  });

  it("initialMessages（en-US）启动即可同步读取", async () => {
    const registry = makeRegistry({}, { "en-US": enFallback });
    expect(registry.getSync("en-US")).toBe(enFallback);
    await expect(registry.ensure("en-US")).resolves.toBe(enFallback);
  });

  it("并发 ensure 合并为一次装载", async () => {
    let loadCalls = 0;
    const registry = makeRegistry({
      "zh-CN": async () => {
        loadCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return zhCN;
      },
    });
    const [first, second, third] = await Promise.all([
      registry.ensure("zh-CN"),
      registry.ensure("zh-CN"),
      registry.ensure("zh-CN"),
    ]);
    expect(loadCalls).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
    // 装载完成后再次 ensure 直接命中同步表。
    await expect(registry.ensure("zh-CN")).resolves.toBe(first);
  });

  it("装载失败回落 en-US 表并固化（闸总能推进，不反复重试）", async () => {
    let loadCalls = 0;
    const registry = makeRegistry({
      "zh-CN": async () => {
        loadCalls += 1;
        throw new Error("chunk fetch failed");
      },
    });
    await expect(registry.ensure("zh-CN")).resolves.toBe(enFallback);
    expect(registry.getSync("zh-CN")).toBe(enFallback);
    // 失败固化后，后续 ensure 命中回落表，不再触发装载。
    await expect(registry.ensure("zh-CN")).resolves.toBe(enFallback);
    expect(loadCalls).toBe(1);
  });

  it("无装载器/未知 locale 直接回落 en-US 表", async () => {
    const registry = makeRegistry({});
    await expect(registry.ensure("ru-RU")).resolves.toBe(enFallback);
    await expect(registry.ensure("xx-XX" as Locale)).resolves.toBe(enFallback);
    expect(registry.getSync("ru-RU")).toBe(enFallback);
  });
});

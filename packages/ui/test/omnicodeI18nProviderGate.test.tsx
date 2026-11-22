// @vitest-environment jsdom
// [OmniCode] 渲染器性能优化（batch4 审计 #2）：i18n 惰性化的 Provider 级 wiring 单测。
// 通过 vi.mock 把 localeMessages 覆写为 omnicode flavor 形态（OMNICODE_FLAVOR_COMPILED=true、
// en-US 同步可用、四语言需异步装载），验证真实 ZCodeIntlProvider + useLocaleMessagesGate：
// ①启动闸——目标语言表未就绪时不渲染 children（桌面停留 index.html 启动壳），不闪英文；
// ②切换语言——未加载语言在装载完成前沿用旧语言渲染（组件树不卸载、无半翻译），就绪后单次切换；
// ③失败回落——装载失败注册表回落 en-US 表，闸总能推进；
// ④已加载语言之间切换零延迟。
import { act, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";

// vi.hoisted：mock 工厂在模块导入期执行，闭包状态必须先于导入初始化。
const gateState = vi.hoisted(() => {
  const enTable: Record<string, string> = {
    "gate.title": "Hello",
    "gate.body": "World",
    "gate.enOnly": "Only in English",
  };
  const zhTable: Record<string, string> = {
    "gate.title": "你好",
    "gate.body": "世界",
    "gate.enOnly": "Only in English",
  };
  // 注册表实况（测试用假注册表）：en-US 恒同步可用，四语言装载完成后才出现。
  const loadedTables = new Map<string, Record<string, string>>([["en-US", enTable]]);
  let pendingEnsures: Array<{ locale: string; resolve: () => void }> = [];
  const ensureCalls: string[] = [];
  return {
    enTable,
    zhTable,
    loadedTables,
    ensureCalls,
    takePendingEnsures: () => pendingEnsures,
    setPendingEnsures: (next: Array<{ locale: string; resolve: () => void }>) => {
      pendingEnsures = next;
    },
    reset: () => {
      loadedTables.clear();
      loadedTables.set("en-US", enTable);
      pendingEnsures = [];
      ensureCalls.length = 0;
    },
  };
});

vi.mock("@/i18n/localeMessages.js", () => ({
  // 强制 omnicode 分支（真实模块在无 define 环境为 false）。
  OMNICODE_FLAVOR_COMPILED: true,
  // omnicode 形态的同步表：en 占位兜底（ErrorBoundary 崩溃兜底语义）。
  LOCALE_MESSAGES: {
    "zh-CN": gateState.enTable,
    "en-US": gateState.enTable,
    "ja-JP": gateState.enTable,
    "ru-RU": gateState.enTable,
    "ko-KR": gateState.enTable,
  },
  getSyncLocaleMessages: (locale: string) => gateState.loadedTables.get(locale),
  ensureLocaleMessages: (locale: string) =>
    new Promise((resolve) => {
      gateState.ensureCalls.push(locale);
      gateState.takePendingEnsures().push({
        locale,
        resolve: () => {
          if (!gateState.loadedTables.has(locale)) {
            // 真实注册表失败回落 en-US 表（内容级验证见 omnicodeI18nLazyLocale 单测）。
            gateState.loadedTables.set(locale, gateState.enTable);
          }
          resolve(gateState.loadedTables.get(locale));
        },
      });
    }),
}));

let host: HTMLDivElement;
let root: Root | null = null;
let mountSequence = 0;

// React 19：act 环境标记（jsdom 单测环境未自动设置，缺省会告警）。
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** 探针：记录挂载序号（重挂载会变化），渲染两条翻译并暴露切换按钮。 */
function GateProbe(): ReactNode {
  const { intl, locale, setLocale } = useZCodeIntl();
  const [mountId] = useState(() => ++mountSequence);
  return (
    <div>
      <span data-testid="gate-title">{intl.formatMessage({ id: "gate.title" })}</span>
      <span data-testid="gate-en-only">{intl.formatMessage({ id: "gate.enOnly" })}</span>
      <span data-testid="gate-locale">{locale}</span>
      <span data-testid="gate-mount">{mountId}</span>
      <button type="button" data-testid="gate-switch-zh" onClick={() => setLocale("zh-CN")}>
        switch
      </button>
    </div>
  );
}

function renderProvider(initialLocale: "en-US" | "zh-CN"): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <ZCodeIntlProvider initialLocale={initialLocale}>
        <GateProbe />
      </ZCodeIntlProvider>,
    );
  });
  return host;
}

function query(selector: string): Element | null {
  return host.querySelector(`[data-testid="${selector}"]`);
}

function text(selector: string): string {
  return query(selector)?.textContent ?? "";
}

/** 以真实注册表语义完成装载：固化目标表并 resolve 所有挂起的 ensure。 */
function releaseEnsure(locale: string, table: Record<string, string>): void {
  gateState.loadedTables.set(locale, table);
  const matching = gateState.takePendingEnsures().filter((pending) => pending.locale === locale);
  gateState.setPendingEnsures(
    gateState.takePendingEnsures().filter((pending) => pending.locale !== locale),
  );
  for (const pending of matching) {
    pending.resolve();
  }
}

beforeEach(() => {
  mountSequence = 0;
  document.body.replaceChildren();
  root = null;
  gateState.reset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.replaceChildren();
});

describe("omnicode i18n 惰性化：Provider 启动闸", () => {
  it("en-US 同步急载：首帧直接渲染，无闸", () => {
    renderProvider("en-US");
    expect(text("gate-title")).toBe("Hello");
    expect(text("gate-locale")).toBe("en-US");
    expect(gateState.ensureCalls).toEqual([]);
  });

  it("目标语言未装载：children 不渲染（停留既有启动画面，不闪英文）；装载后首帧挂载即中文", async () => {
    const container = renderProvider("zh-CN");
    // 闸：children 未挂载，容器为空（桌面主窗口此时停留在 index.html 启动壳）。
    expect(container.childElementCount).toBe(0);
    expect(query("gate-title")).toBeNull();
    expect(document.documentElement.lang).toBe("zh-CN");

    await act(async () => {
      releaseEnsure("zh-CN", gateState.zhTable);
    });
    // 装载完成：单帧挂载 children，首帧即为中文（无英文闪烁、无裸 key）。
    expect(text("gate-title")).toBe("你好");
    expect(text("gate-en-only")).toBe("Only in English");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(gateState.ensureCalls).toEqual(["zh-CN"]);
  });

  it("装载失败回落 en-US 表：闸推进、渲染 en 兜底文案而非裸 key", async () => {
    renderProvider("zh-CN");
    expect(query("gate-title")).toBeNull();
    await act(async () => {
      releaseEnsure("zh-CN", gateState.enTable);
    });
    expect(text("gate-title")).toBe("Hello");
    expect(text("gate-en-only")).toBe("Only in English");
  });
});

describe("omnicode i18n 惰性化：切换语言（await → 应用，禁半翻译）", () => {
  it("切到未加载语言：沿用旧语言渲染、组件树不卸载；装载完成后单帧切换", async () => {
    renderProvider("en-US");
    expect(text("gate-title")).toBe("Hello");
    const mountBefore = text("gate-mount");

    act(() => {
      (query("gate-switch-zh") as HTMLButtonElement).click();
    });
    // 未装载期间：旧语言（en）继续渲染，mount 序号不变（组件树未卸载 → 无状态丢失），
    // html lang 保持旧语言（与可见文案一致）。
    expect(text("gate-title")).toBe("Hello");
    expect(text("gate-locale")).toBe("en-US");
    expect(document.documentElement.lang).toBe("en-US");
    expect(text("gate-mount")).toBe(mountBefore);
    expect(gateState.ensureCalls).toEqual(["zh-CN"]);

    await act(async () => {
      releaseEnsure("zh-CN", gateState.zhTable);
    });
    // 装载完成：单帧切换到中文，mount 序号仍不变（同一次挂载内的语言切换）。
    expect(text("gate-title")).toBe("你好");
    expect(text("gate-locale")).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(text("gate-mount")).toBe(mountBefore);
  });

  it("切到已加载语言：同一渲染立即应用（零延迟）", () => {
    renderProvider("en-US");
    act(() => {
      // 预装载 zh：模拟此前切换过一次并已完成装载。
      releaseEnsure("zh-CN", gateState.zhTable);
    });
    expect(text("gate-title")).toBe("Hello");
    const mountBefore = text("gate-mount");

    act(() => {
      (query("gate-switch-zh") as HTMLButtonElement).click();
    });
    expect(text("gate-title")).toBe("你好");
    expect(text("gate-locale")).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(text("gate-mount")).toBe(mountBefore);
    // 已就绪语言切换不再触发装载。
    expect(gateState.ensureCalls).toEqual([]);
  });
});

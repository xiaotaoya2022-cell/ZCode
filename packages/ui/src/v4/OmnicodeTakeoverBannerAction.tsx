/**
 * [OmniCode] D12 请求接管流——观察者横幅动作按钮（spec:
 * docs/omnicode/profile-runtime.md §批次3 D12）。独立小组件：SessionPane 已超
 * max-lines，横幅按钮与其在途态订阅收口在此，不动 SessionPane 体积。
 *
 * 呈现规则：registry 无处理器（官方 flavor / 管理器 / 旧 preload 桥面缺席）→ 不渲染
 * （零死点击）；在途请求 → 禁用 + 「等待响应…」文案（防重复发起，管理器侧 busy 兜底）；
 * 点击即发起（结果经 OmnicodeTakeoverEvent 事件回推：toast / accepted 自动重开）。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  hasOmnicodeTakeoverRequestHandler,
  requestOmnicodeWorkspaceTakeover,
} from "@/root/omnicodeTakeoverRegistry.js";
import { useOmnicodeTakeoverPending } from "@/root/useOmnicodeTakeoverPending.js";

export function OmnicodeTakeoverBannerAction({ workspacePath }: { workspacePath: string }): React.ReactNode {
  const { intl } = useZCodeIntl();
  const pending = useOmnicodeTakeoverPending(workspacePath);
  // 处理器缺席静态隐藏（非布尔态订阅——横幅只在 omnicode 观察者态渲染，常规路径必有）。
  // 判定放在 hook 之后：处理器在 Root 装配/卸载间可变，条件返回不能早于 hook 调用。
  if (!hasOmnicodeTakeoverRequestHandler()) {
    return null;
  }
  return (
    <button
      type="button"
      data-testid="omnicode-takeover-request-button"
      disabled={pending}
      onClick={() => {
        requestOmnicodeWorkspaceTakeover(workspacePath);
      }}
      className="ml-auto inline-flex h-6 shrink-0 items-center rounded-md border border-amber-600/40 bg-amber-500/15 px-2 text-ui-xs font-medium text-amber-800 transition-colors hover:bg-amber-500/25 disabled:cursor-default disabled:opacity-60 dark:text-amber-200"
    >
      {pending
        ? intl.formatMessage({ id: "omnicode.takeover.bannerPending" })
        : intl.formatMessage({ id: "omnicode.takeover.bannerButton" })}
    </button>
  );
}

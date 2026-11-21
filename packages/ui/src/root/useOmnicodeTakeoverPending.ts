/**
 * [OmniCode] D12 请求接管流——观察者横幅按钮的在途态订阅 hook（spec:
 * docs/omnicode/profile-runtime.md §批次3 D12）。registry 是模块级内存态无 React
 * 绑定，本 hook 是它唯一的 React 投影：subscribe 用模块级稳定引用，getSnapshot
 * 随 path 记忆化（布尔原始值，React 按值比较天然去抖）。
 */
import { useCallback, useSyncExternalStore } from "react";
import { isOmnicodeTakeoverPending, subscribeOmnicodeTakeoverPending } from "@/root/omnicodeTakeoverRegistry.js";

export function useOmnicodeTakeoverPending(workspacePath: string): boolean {
  const getSnapshot = useCallback(() => isOmnicodeTakeoverPending(workspacePath), [workspacePath]);
  return useSyncExternalStore(subscribeOmnicodeTakeoverPending, getSnapshot, getSnapshot);
}

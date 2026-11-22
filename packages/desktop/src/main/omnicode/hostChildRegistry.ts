// [OmniCode] 模式二 R3：window-scoped Host child 只读登记表（spec:
// docs/omnicode/multi-account-sessions.md §6/§7——槽位用量查询经 main→Host parentPort）。
//
// 为什么独立成模块：desktopHostProcess.ts（登记点）与 accountSlotsQuery.ts（读取点）互为
// 消费方，直接互相 import 会成环——本模块是两者的中性簿记点。实例单主窗口 → 至多一个
// 登记；官方/远端同形状（多 Host 时取第一个登记项即可——槽位查询是实例主 Host 的调度器
// 快照）。
type ElectronUtilityProcess = import("electron").UtilityProcess;

const children = new Map<string, ElectronUtilityProcess>();

export function registerOmnicodeHostChild(label: string, child: ElectronUtilityProcess): void {
  children.set(label, child);
}

export function unregisterOmnicodeHostChild(label: string): void {
  children.delete(label);
}

/** 已登记的 Host child（实例单窗口 → 至多一个；顺序 = 登记序）。 */
export function listOmnicodeHostChildren(): ElectronUtilityProcess[] {
  return [...children.values()];
}

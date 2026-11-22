// [OmniCode] 模式二 R3：账号层 UI 数据源（spec: docs/omnicode/multi-account-sessions.md
// §6/§7——选择器账号层 + 任务徽标 + 槽位可视化）。
//
// 三个 renderer 内存事实（模块级 store，事件驱动无轮询）：
// 1. 目录/槽位快照：IPlatformService.getOmnicodeAccountDirectoryList / getOmnicodeAccountSlots
//    （仅 omnicode 实例非缺席；官方/管理器/旧 preload 缺席 → entries 空 → 账号层不渲染）。
//    刷新时机 = 消费方显式 refresh（菜单打开/选择后），不做后台轮询。
// 2. 会话账号选择意图：scopeKey（workspacePath+identity+sessionId|draft）→ accountId
//    （null=主账号）。sendText 派发时随 payload.omnicodeAccountId 透传（R1.5 管道），
//    徽标/选择器回显同一事实源。
// 红线：元数据 only——两个 platform 方法按 shared 契约只返回 accountId/displayName/
// family/槽位计数，任何凭据字段到不了本模块（schema 由 main/Host 侧锁定）。
import { useCallback, useEffect, useState } from "react";
import {
  omnicodeAccountDirectoryEntrySchema,
  type IPlatformService,
  type OmnicodeAccountDirectoryEntry,
  type OmnicodeAccountSlotUsage,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";

// ─── 目录 + 槽位快照（模块级缓存，跨组件共享） ───

interface OmnicodeAccountCatalogSnapshot {
  accounts: OmnicodeAccountDirectoryEntry[];
  slots: OmnicodeAccountSlotUsage[];
  /** 平台桥缺席（官方/管理器/旧 preload）= 恒 false → 账号层不渲染。 */
  bridgeAvailable: boolean;
}

const EMPTY_SNAPSHOT: OmnicodeAccountCatalogSnapshot = {
  accounts: [],
  slots: [],
  bridgeAvailable: false,
};

let catalogSnapshot: OmnicodeAccountCatalogSnapshot = EMPTY_SNAPSHOT;
const catalogListeners = new Set<() => void>();
let catalogInFlight: Promise<void> | null = null;

function publishCatalog(next: OmnicodeAccountCatalogSnapshot): void {
  catalogSnapshot = next;
  for (const listener of catalogListeners) listener();
}

/** 拉取目录 + 槽位快照（事件驱动：菜单打开/选择后由消费方调用；并发去重）。 */
export function refreshOmnicodeAccountCatalog(
  platform: IPlatformService | undefined,
): Promise<void> {
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = (async () => {
    try {
      // platform 方法缺席（官方/管理器/旧 preload）→ 账号层整体不渲染。
      const directoryPromise = platform?.getOmnicodeAccountDirectoryList?.();
      if (!platform || !directoryPromise) {
        publishCatalog(EMPTY_SNAPSHOT);
        return;
      }
      const [directoryResult, slotsResult] = await Promise.all([
        directoryPromise,
        platform.getOmnicodeAccountSlots?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      // 条目逐条 schema 校验（纵深防御：main 侧已逐条校验，renderer 再校验一次防漂移；
      // 非法条目整条丢弃，不影响其余目录行）。
      const accounts: OmnicodeAccountDirectoryEntry[] = [];
      for (const raw of directoryResult.ok ? (directoryResult.accounts ?? []) : []) {
        const parsed = omnicodeAccountDirectoryEntrySchema.safeParse(raw);
        if (parsed.success) accounts.push(parsed.data);
      }
      publishCatalog({
        accounts,
        slots: slotsResult?.ok ? (slotsResult.slots ?? []) : [],
        bridgeAvailable: true,
      });
    } catch {
      publishCatalog({ ...EMPTY_SNAPSHOT });
    } finally {
      catalogInFlight = null;
    }
  })();
  return catalogInFlight;
}

/** 目录/槽位快照 hook（快照变化即重渲染；挂载即拉一次，事件驱动）。 */
export function useOmnicodeAccountCatalog(): OmnicodeAccountCatalogSnapshot {
  const platform = usePlatform();
  const [snapshot, setSnapshot] = useState(catalogSnapshot);
  useEffect(() => {
    const listener = () => setSnapshot(catalogSnapshot);
    listener();
    catalogListeners.add(listener);
    return () => {
      catalogListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    void refreshOmnicodeAccountCatalog(platform);
    const onFocus = () => void refreshOmnicodeAccountCatalog(platform);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [platform]);
  return snapshot;
}

// ─── 会话账号选择意图（scopeKey → accountId；徽标与派发同一事实源） ───

const selectionByScope = new Map<string, string | null>();
const selectionListeners = new Set<() => void>();

function publishSelection(): void {
  for (const listener of selectionListeners) listener();
}

/** scopeKey（纯函数）：workspacePath + identity + sessionId|draft。 */
export function omnicodeAccountScopeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  sessionId: string | null;
}): string {
  return [params.workspacePath, params.workspaceIdentity ?? "", params.sessionId ?? "draft"].join(
    "\u0000",
  );
}

/** 读会话/草稿账号选择（null=主账号；未登记=主账号）。 */
export function readOmnicodeAccountSelection(scopeKey: string): string | null {
  return selectionByScope.get(scopeKey) ?? null;
}

/** 写会话/草稿账号选择（null=回到主账号）。 */
export function writeOmnicodeAccountSelection(scopeKey: string, accountId: string | null): void {
  if (accountId) selectionByScope.set(scopeKey, accountId);
  else selectionByScope.delete(scopeKey);
  publishSelection();
}

/** 会话账号选择变更订阅（非 hook 消费方用；返回 disposer）。 */
export function subscribeOmnicodeAccountSelection(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => {
    selectionListeners.delete(listener);
  };
}

/** 会话账号选择 hook（徽标/派发读这里；选择器写这里）。 */
export function useOmnicodeAccountSelection(scopeKey: string): {
  accountId: string | null;
  selectAccount: (accountId: string | null) => void;
} {
  const [accountId, setAccountId] = useState(readOmnicodeAccountSelection(scopeKey));
  useEffect(() => {
    const listener = () => setAccountId(readOmnicodeAccountSelection(scopeKey));
    listener();
    const unsubscribe = subscribeOmnicodeAccountSelection(listener);
    return () => {
      unsubscribe();
    };
  }, [scopeKey]);
  const selectAccount = useCallback(
    (next: string | null) => writeOmnicodeAccountSelection(scopeKey, next),
    [scopeKey],
  );
  return { accountId, selectAccount };
}

/**
 * accountId → 显示名解析（徽标/选择器共用；主账号 null 不在本表——调用方自行回退
 * "主账号" 文案）。未命中返回 null（目录晚到时徽标隐藏，下一轮目录刷新后自愈）。
 */
export function resolveOmnicodeAccountDisplayName(
  accountId: string | null,
  accounts: readonly OmnicodeAccountDirectoryEntry[],
): string | null {
  if (!accountId) return null;
  return accounts.find((entry) => entry.accountId === accountId)?.displayName ?? null;
}

// [OmniCode] 模式二 R3：任务列表账号徽标（spec:
// docs/omnicode/multi-account-sessions.md §7——"任务列表账号徽标 + 槽位可视化"）。
//
// 数据源：会话账号选择 store（选择器写入 / sendText 派发沿用同一事实源）+ 目录显示名。
// 门控：会话未绑定附加账号（readOmnicodeAccountSelection 返回 null）或目录晚到（显示名
// 未命中）→ 不渲染——官方任务行逐字不变。渲染内容 = 色点 + 显示名（元数据 only，无凭据）。
import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  omnicodeAccountScopeKey,
  readOmnicodeAccountSelection,
  resolveOmnicodeAccountDisplayName,
  subscribeOmnicodeAccountSelection,
} from "@/omnicode/omnicodeAccountUi.js";
import type { OmnicodeAccountDirectoryEntry } from "@zcode/shared";

const OMNICODE_ACCOUNT_FAMILY_DOT_CLASS: Record<string, string> = {
  zai: "bg-sky-500",
  bigmodel: "bg-emerald-500",
};

export function TaskAccountBadge({
  sessionId,
  workspacePath,
  workspaceIdentity,
  accounts,
  catalogAvailable,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  accounts: readonly OmnicodeAccountDirectoryEntry[];
  /** 平台桥缺席（官方/管理器/旧 preload）= false → 徽标恒不渲染。 */
  catalogAvailable: boolean;
}) {
  const scopeKey = omnicodeAccountScopeKey({
    workspacePath,
    workspaceIdentity: workspaceIdentity ?? null,
    sessionId,
  });
  const [accountId, setAccountId] = useState<string | null>(() =>
    catalogAvailable ? readOmnicodeAccountSelection(scopeKey) : null,
  );
  useEffect(() => {
    if (!catalogAvailable) {
      setAccountId(null);
      return;
    }
    const listener = () => setAccountId(readOmnicodeAccountSelection(scopeKey));
    listener();
    return subscribeOmnicodeAccountSelection(listener);
  }, [catalogAvailable, scopeKey]);
  const displayName = resolveOmnicodeAccountDisplayName(accountId, accounts);
  if (!accountId || !displayName) return null;
  const family = accounts.find((entry) => entry.accountId === accountId)?.family ?? null;
  return (
    <span
      data-testid="omnicode-task-account-badge"
      data-omnicode-account={accountId}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-1.5 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
      title={displayName}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          family
            ? OMNICODE_ACCOUNT_FAMILY_DOT_CLASS[family] ?? "bg-foreground/40"
            : "bg-foreground/40",
        )}
      />
      <span className="max-w-32 truncate">{displayName}</span>
    </span>
  );
}

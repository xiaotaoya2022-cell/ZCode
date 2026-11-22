// [OmniCode] 模式二 R3：选择器账号层数据装配 hook（spec:
// docs/omnicode/multi-account-sessions.md §7）。
//
// 门控（返回 undefined = 账号层不渲染，官方逐字不变）：
// - 平台桥缺席（官方/管理器/旧 preload）→ undefined；
// - 附加账号目录为空（真无附加账号 / 桥断连 / 元数据读取失败）→ undefined；
// 两者都满足且目录非空才返回 {groups, selectedAccountId, onSelect}。
// groups 由 buildComposerOmnicodeAccountGroups 构建（主账号行固定第一 + 附加账号按目录序 +
// 槽位徽标）；selectedAccountId = 本 scope（workspacePath+identity+sessionId|draft）的
// 选择意图（null=主账号）；onSelect 写回 store（下一次 sendText 随 payload 透传 R1.5 管道）。
import { useMemo } from "react";
import {
  buildComposerOmnicodeAccountGroups,
  type ComposerOmnicodeAccountGroup,
} from "@/lib/composerPlanGroups.js";
import {
  omnicodeAccountScopeKey,
  useOmnicodeAccountCatalog,
  useOmnicodeAccountSelection,
} from "@/omnicode/omnicodeAccountUi.js";

export interface OmnicodeComposerAccountMenu {
  groups: readonly ComposerOmnicodeAccountGroup[];
  selectedAccountId: string | null;
  onSelect: (accountId: string | null) => void;
}

export function useOmnicodeComposerAccountMenu(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  /** 主账号行显示名（intl 文案由调用方给；通常 = "主账号"）。 */
  primaryLabel: string;
}): OmnicodeComposerAccountMenu | undefined {
  const catalog = useOmnicodeAccountCatalog();
  const scopeKey = omnicodeAccountScopeKey({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    sessionId: params.sessionId,
  });
  const { accountId, selectAccount } = useOmnicodeAccountSelection(scopeKey);

  return useMemo<OmnicodeComposerAccountMenu | undefined>(() => {
    if (!catalog.bridgeAvailable) return undefined;
    if (catalog.accounts.length === 0) return undefined;
    const groups = buildComposerOmnicodeAccountGroups({
      accounts: catalog.accounts,
      slots: catalog.slots,
      primaryLabel: params.primaryLabel,
    });
    return { groups, selectedAccountId: accountId, onSelect: selectAccount };
  }, [
    catalog.bridgeAvailable,
    catalog.accounts,
    catalog.slots,
    params.primaryLabel,
    accountId,
    selectAccount,
  ]);
}

// [OmniCode] 模式二 R3：选择器账号层区块（spec:
// docs/omnicode/multi-account-sessions.md §7——三层：账号 → 套餐 → 模型）。
//
// 渲染位置 = ComposerProviderMenu 套餐 radio 组上方的独立区块（与套餐层视觉隔离，
// 不占用套餐 radio 的选中态）。门控 = 附加账号清单非空 ∧ omnicode 实例平台桥可用
// （catalog.bridgeAvailable）——官方 flavor / 管理器 / 旧 preload 一律不渲染（官方
// 逐字不变铁律）。槽位徽标 = 调度器 running/上限（元数据 only）。
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ComposerOmnicodeAccountGroup } from "@/lib/composerPlanGroups.js";

const OMNICODE_ACCOUNT_FAMILY_DOT_CLASS: Record<string, string> = {
  zai: "bg-sky-500",
  bigmodel: "bg-emerald-500",
};

/** 槽位徽标文案（running/limit；无槽位数据时不渲染徽标）。 */
function slotBadge(running: number | undefined, limit: number | undefined): string | null {
  if (typeof running !== "number" || typeof limit !== "number") return null;
  return `${running}/${limit}`;
}

export function ComposerOmnicodeAccountMenu({
  groups,
  selectedAccountId,
  onSelect,
}: {
  groups: readonly ComposerOmnicodeAccountGroup[];
  /** 当前选中账号（null = 主账号）。 */
  selectedAccountId: string | null;
  onSelect: (accountId: string | null) => void;
}) {
  const { intl } = useZCodeIntl();
  if (groups.length === 0) return null;
  return (
    <>
      <DropdownMenuLabel
        className="text-ui-sm text-foreground-subtle"
        data-testid="omnicode-account-layer-label"
      >
        {intl.formatMessage({ id: "chat.omnicode.accountLayer" })}
      </DropdownMenuLabel>
      {groups.map((group) => {
        const selected = (group.account.accountId ?? null) === selectedAccountId;
        const badge = slotBadge(group.account.running, group.account.limit);
        const dotClass = group.account.family
          ? OMNICODE_ACCOUNT_FAMILY_DOT_CLASS[group.account.family]
          : undefined;
        return (
          <DropdownMenuItem
            key={group.key}
            data-testid={group.key}
            data-omnicode-account={group.account.accountId ?? "primary"}
            data-selected={selected}
            className="min-h-8 gap-2 pl-2 pr-8"
            onSelect={(event) => {
              event.preventDefault();
              onSelect(group.account.accountId ?? null);
            }}
          >
            {/* 色点：主账号用中性点；附加账号按 family 着色（徽标数据源=目录 family）。 */}
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full",
                dotClass ?? "bg-foreground/40",
              )}
            />
            <span className="min-w-0 whitespace-normal break-words">{group.account.displayName}</span>
            {badge ? (
              <span
                data-omnicode-account-slots={badge}
                className="ml-auto shrink-0 rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle tabular-nums"
              >
                {badge}
              </span>
            ) : null}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { OMNICODE_SMART_SCHEDULING_DEFAULT } from "@zcode/shared";

/**
 * [OmniCode] 模式二 R4（spec: docs/omnicode/multi-account-sessions.md §6）：智能调度开关
 * （开关式默认开，不强制）。读写本机 setting.json 的 omnicodeSmartScheduling 键——管理器
 * 改这里即全局层事实源，经全局偏好键体系（环形抑制/下行广播/spawn 注入）同步到各实例；
 * 实例改了也回流管理器并广播其余实例。缺席键 = 开（default(true)），显式 false 才关闭。
 *
 * 渲染位置 = 管理器设置 omnicode 多实例分区（实例内 ProfileMultiInstanceSection 整体
 * early-return，本行天然只在管理器语境出现——官方零改动铁律）。
 */
export function OmnicodeSmartSchedulingSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings({ services: useBaseWorkspaceServices() });
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "settings.omnicodeProfiles.smartScheduling" });
  // 缺席（旧档/未同步）= 开（与 shared 缺省、Host 读取语义同一事实）。
  const enabled =
    settings?.omnicodeSmartScheduling === undefined
      ? OMNICODE_SMART_SCHEDULING_DEFAULT
      : settings.omnicodeSmartScheduling;

  const handleChange = async (next: boolean) => {
    setSaving(true);
    try {
      await update({ omnicodeSmartScheduling: next });
    } catch (error) {
      logger.warn("[omnicode] 更新智能调度开关失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.omnicodeProfiles.smartSchedulingSaveError" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      searchId="settings.omnicodeProfiles.smartScheduling"
      label={label}
      description={intl.formatMessage({
        id: "settings.omnicodeProfiles.smartSchedulingDescription",
      })}
      control={
        <Switch
          aria-label={label}
          checked={enabled}
          disabled={saving || !settings}
          onCheckedChange={(checked) => void handleChange(checked)}
        />
      }
    />
  );
}

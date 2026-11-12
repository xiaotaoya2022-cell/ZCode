import { useCallback, useEffect, useState } from "react";
import { Download, LayoutGrid, Maximize2, Play, RefreshCw, Square, Trash2, Copy, Undo2 } from "lucide-react";
import type { OmnicodeProfileSummaryInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import {
  useOmnicodeConsoleInstances,
  type OmnicodeInstanceFrame,
} from "@/console/useOmnicodeConsoleInstances.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * [OmniCode] 批次2 B2-1（T5）：旧控制台收养状态与处理（可复用导出——B2-3 控制台
 * 重做时直接复用本 hook，不重写检测/确认/执行链）。
 * available 仅当管理器数据根存在凭据文件且未被收养（main 侧判定；实例/官方平台
 * 该方法缺席 → 恒 false，行不渲染）。
 */
export function useOmnicodeConsoleAdoption(options?: { onAdopted?: () => void }) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    void platform
      .checkOmnicodeConsoleAdoption?.()
      .then((result) => {
        if (!disposed) setAvailable(Boolean(result?.available));
      })
      .catch((error) => {
        logger.warn("[omnicode] 收养可用性检测失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [platform]);

  const adopt = useCallback(() => {
    void (async () => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "console.adoptionConfirmTitle" }),
        description: intl.formatMessage({ id: "console.adoptionConfirmDescription" }),
      });
      if (!confirmed) return;
      setBusy(true);
      try {
        await platform.adoptOmnicodeConsole!({
          name: intl.formatMessage({ id: "console.adoptionDefaultName" }),
        });
        toast(intl.formatMessage({ id: "console.adoptionToastDone" }), { variant: "success" });
        setAvailable(false);
        options?.onAdopted?.();
      } catch (error) {
        toast(
          `${intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" })}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { variant: "warning" },
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [intl, options, platform, requestConfirmation]);

  return { available, busy, adopt };
}

/**
 * OmniCode Profile 多实例管理分区（desktop-only，spec: docs/omnicode/profile-runtime.md）。
 * 批次2 B2-3：列表/实时帧/操作链与控制台网格共用同一 hook（useOmnicodeConsoleInstances），
 * 本组件保持设置页紧凑列表形态；缩略图按帧附带的 {w,h} 真实宽高比 letterbox。
 */
export function ProfileMultiInstanceSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [newName, setNewName] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const {
    profiles,
    loading,
    busy,
    frames,
    refresh,
    handleLaunch,
    handleStop,
    handleClone,
    handleFocus,
    handleArrange,
    handleRemove,
  } = useOmnicodeConsoleInstances();

  const handleCreate = useCallback(() => {
    const name = newName.trim();
    if (!name) {
      toast(intl.formatMessage({ id: "settings.omnicodeProfiles.nameRequired" }), {
        variant: "warning",
      });
      return;
    }
    void (async () => {
      try {
        await platform.createOmnicodeProfile!({ name, notes: newNotes.trim() || undefined });
        toast(intl.formatMessage({ id: "settings.omnicodeProfiles.toastCreated" }), {
          variant: "success",
        });
        setNewName("");
        setNewNotes("");
        await refresh();
      } catch (error) {
        toast(
          `${intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" })}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { variant: "warning" },
        );
      }
    })();
  }, [intl, newNotes, newName, platform, refresh]);

  // [OmniCode] 批次2 B2-1（T5）：旧控制台收养行——仅当旧数据根有凭据且未被收养时显示
  //（检测在 main；收养=新建零拷贝指向旧根的 profile，保留登录态与历史会话）。
  const adoption = useOmnicodeConsoleAdoption({ onAdopted: () => void refresh() });

  // [OmniCode] 批次2 B2-1（T3 嵌套封死）：实例 renderer 不呈现 Profile 管理面——实例的
  // preload 已按身份裁剪掉管理 API（window.zcode 缺席这些方法），设置页的这个分区在
  // 实例内直接不渲染（所有 hooks 已在上方无条件执行，此处 early-return 合法）。
  if (platform.omnicodeInstanceId != null) return null;

  const runningCount = profiles.filter((profile) => profile.running).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.omnicodeProfiles.description" })}
      </p>

      {/* [OmniCode] M2 v1 平铺编排/还原（仅运行中实例可用；控制台主窗口不参与编排） */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleArrange("settings.omnicodeProfiles.toastArranged")}
          disabled={busy || runningCount === 0}
          title={intl.formatMessage({ id: "settings.omnicodeProfiles.arrange" })}
        >
          <LayoutGrid className="size-3.5" />
          {intl.formatMessage({ id: "settings.omnicodeProfiles.arrange" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleArrange("settings.omnicodeProfiles.toastRestored")}
          disabled={busy || runningCount === 0}
          title={intl.formatMessage({ id: "settings.omnicodeProfiles.restore" })}
        >
          <Undo2 className="size-3.5" />
          {intl.formatMessage({ id: "settings.omnicodeProfiles.restore" })}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {adoption.available ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-2">
            <span className="min-w-0 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "console.adoptionTitle" })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={adoption.adopt}
              disabled={adoption.busy || busy}
            >
              <Download className="size-3.5" />
              {intl.formatMessage({ id: "console.adoptionAction" })}
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={intl.formatMessage({ id: "settings.omnicodeProfiles.namePlaceholder" })}
            className="max-w-56"
            disabled={busy}
          />
          <Input
            value={newNotes}
            onChange={(event) => setNewNotes(event.target.value)}
            placeholder={intl.formatMessage({ id: "settings.omnicodeProfiles.notesPlaceholder" })}
            className="max-w-72"
            disabled={busy}
          />
          <Button onClick={handleCreate} disabled={busy || newName.trim().length === 0}>
            {intl.formatMessage({ id: "settings.omnicodeProfiles.create" })}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={busy} aria-label="refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>

        {loading ? (
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.omnicodeProfiles.loading" })}
          </p>
        ) : profiles.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.omnicodeProfiles.empty" })}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {profiles.map((profile) => (
              <li key={profile.id} className="flex flex-col px-3 py-2">
                <InstanceListRowThumbnail
                  profile={profile}
                  frame={profile.running ? frames.get(profile.id) : undefined}
                />
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-block size-2 shrink-0 rounded-full ${profile.running ? "bg-emerald-500" : "bg-foreground-subtlest"}`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ui-base text-foreground">{profile.name}</span>
                    <span className="truncate text-ui-xs text-foreground-subtlest">
                      {profile.running
                        ? intl.formatMessage(
                            { id: "settings.omnicodeProfiles.running" },
                            { pid: String(profile.pid ?? "") },
                          )
                        : intl.formatMessage({ id: "settings.omnicodeProfiles.stopped" })}
                      {profile.notes ? ` · ${profile.notes}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {profile.running ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleFocus(profile)}
                          disabled={busy}
                          title={intl.formatMessage({ id: "settings.omnicodeProfiles.focus" })}
                        >
                          <Maximize2 className="size-3.5" />
                          {intl.formatMessage({ id: "settings.omnicodeProfiles.focus" })}
                        </Button>
                        {/* 批次1 P1-4「启动=重启」：运行中实例可点启动触发优雅重启 */}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleLaunch(profile)}
                          disabled={busy}
                          title={intl.formatMessage({ id: "settings.omnicodeProfiles.launch" })}
                        >
                          <Play className="size-3.5" />
                          {intl.formatMessage({ id: "settings.omnicodeProfiles.launch" })}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleStop(profile)}
                          disabled={busy}
                        >
                          <Square className="size-3.5" />
                          {intl.formatMessage({ id: "settings.omnicodeProfiles.stop" })}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleLaunch(profile)}
                        disabled={busy}
                      >
                        <Play className="size-3.5" />
                        {intl.formatMessage({ id: "settings.omnicodeProfiles.launch" })}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleClone(profile)}
                      disabled={busy}
                      aria-label={intl.formatMessage({ id: "settings.omnicodeProfiles.clone" })}
                      title={intl.formatMessage({ id: "settings.omnicodeProfiles.clone" })}
                    >
                      <Copy className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemove(profile)}
                      disabled={busy}
                      aria-label={intl.formatMessage({ id: "settings.omnicodeProfiles.delete" })}
                      title={intl.formatMessage({ id: "settings.omnicodeProfiles.delete" })}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * [OmniCode] 批次2 B2-3：设置页列表行缩略图——帧附 {w,h} 时按真实宽高比 letterbox
 *（修"显示不完整"）；缺省回退固定比例（旧实例兼容）。
 */
function InstanceListRowThumbnail(props: {
  profile: OmnicodeProfileSummaryInfo;
  frame?: OmnicodeInstanceFrame;
}) {
  const { profile, frame } = props;
  if (!profile.running || !frame) return null;
  const hasSize = frame.width !== undefined && frame.height !== undefined && frame.width > 0 && frame.height > 0;
  return (
    <img
      src={`data:image/jpeg;base64,${frame.frame}`}
      alt=""
      style={hasSize ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined}
      className="mb-2 h-32 w-full rounded border border-border bg-black/90 object-contain object-top"
    />
  );
}

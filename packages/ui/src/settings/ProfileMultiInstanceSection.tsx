import { useCallback, useEffect, useState } from "react";
import { Copy, LayoutGrid, Maximize2, Play, RefreshCw, Square, Trash2, Undo2 } from "lucide-react";
import type { OmnicodeProfileSummaryInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * OmniCode Profile 多实例管理分区（desktop-only，spec: docs/omnicode/profile-runtime.md）。
 * 列表/创建/克隆/删除/启动/停止；运行态来自控制台主进程内存注册表（重启即重建）。
 * 删除与克隆在实例运行中被主进程拒绝（PROFILE_RUNNING / 目录占用），失败经 toast 透出。
 */
export function ProfileMultiInstanceSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const [profiles, setProfiles] = useState<OmnicodeProfileSummaryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await platform.listOmnicodeProfiles?.();
      setProfiles(result?.profiles ?? []);
    } catch (error) {
      logger.warn("[omnicode] 读取 Profile 列表失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // [OmniCode] 实例事件订阅：缩略图帧实时更新（1.4fps/实例，M2 视窗管线）
  const [frames, setFrames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const unsubscribe = platform.onOmnicodeInstanceEvent?.((payload) => {
      if (payload.type === "thumbnail" && payload.frame) {
        const profileId = payload.profileId;
        const frame = payload.frame;
        setFrames((previous) => {
          const next = new Map(previous);
          next.set(profileId, frame);
          return next;
        });
      }
      if (payload.type === "disconnected") {
        void refresh();
      }
    });
    return unsubscribe ?? (() => {});
  }, [platform, refresh]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, successMessageId: string | null) => {
      setBusy(true);
      try {
        await action();
        if (successMessageId) {
          toast(intl.formatMessage({ id: successMessageId }), { variant: "success" });
        }
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(
          `${intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" })}: ${message}`,
          { variant: "warning" },
        );
        logger.warn("[omnicode] Profile 操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(false);
      }
    },
    [intl, refresh],
  );

  const handleCreate = useCallback(() => {
    const name = newName.trim();
    if (!name) {
      toast(intl.formatMessage({ id: "settings.omnicodeProfiles.nameRequired" }), {
        variant: "warning",
      });
      return;
    }
    void runAction(
      () => platform.createOmnicodeProfile!({ name, notes: newNotes.trim() || undefined }),
      "settings.omnicodeProfiles.toastCreated",
    );
    setNewName("");
    setNewNotes("");
  }, [intl, newNotes, newName, platform, runAction]);

  const handleLaunch = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      // 批次1 P1-4「启动=重启」：已运行实例点击启动 = 先三段式优雅停再启动；
      // 失败经 runAction 的 toast 透出（spec §接口 launch）。
      void runAction(
        () => platform.launchOmnicodeProfile!({ id: profile.id }),
        "settings.omnicodeProfiles.toastLaunched",
      );
    },
    [platform, runAction],
  );

  const handleStop = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      if (!profile.running) return;
      void runAction(
        () => platform.stopOmnicodeProfile!({ id: profile.id }),
        "settings.omnicodeProfiles.toastStopped",
      );
    },
    [platform, runAction],
  );

  const handleClone = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      const name = `${profile.name} 2`;
      void runAction(
        () => platform.cloneOmnicodeProfile!({ id: profile.id, name }),
        "settings.omnicodeProfiles.toastCloned",
      );
    },
    [platform, runAction],
  );

  const handleFocus = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      if (!profile.running) return;
      void platform.focusOmnicodeProfile?.({ id: profile.id });
    },
    [platform],
  );

  // [OmniCode] M2 v1 平铺编排/还原（spec: docs/omnicode/profile-runtime.md §实时视窗）。
  // delivered=0 通常是运行中实例尚未回连桥（如刚启动或崩溃），如实提示而非谎报成功。
  const handleArrange = useCallback(() => {
    void (async () => {
      try {
        const result = await platform.arrangeOmnicodeInstances?.();
        const count = result?.delivered.length ?? 0;
        if (count === 0) {
          toast(intl.formatMessage({ id: "settings.omnicodeProfiles.toastArrangeNone" }), {
            variant: "warning",
          });
          return;
        }
        toast(
          intl.formatMessage({ id: "settings.omnicodeProfiles.toastArranged" }, { count: String(count) }),
          { variant: "success" },
        );
      } catch (error) {
        logger.warn("[omnicode] 平铺编排失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" }), {
          variant: "warning",
        });
      }
    })();
  }, [intl, platform]);

  const handleRestore = useCallback(() => {
    void (async () => {
      try {
        const result = await platform.restoreOmnicodeInstances?.();
        const count = result?.delivered.length ?? 0;
        if (count === 0) {
          toast(intl.formatMessage({ id: "settings.omnicodeProfiles.toastArrangeNone" }), {
            variant: "warning",
          });
          return;
        }
        toast(
          intl.formatMessage({ id: "settings.omnicodeProfiles.toastRestored" }, { count: String(count) }),
          { variant: "success" },
        );
      } catch (error) {
        logger.warn("[omnicode] 还原窗口失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" }), {
          variant: "warning",
        });
      }
    })();
  }, [intl, platform]);

  const handleRemove = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      void (async () => {
        const confirmed = await requestConfirmation({
          confirmVariant: "destructive",
          title: intl.formatMessage({ id: "settings.omnicodeProfiles.deleteConfirmTitle" }),
          description: intl.formatMessage(
            { id: "settings.omnicodeProfiles.deleteConfirmDescription" },
            { name: profile.name },
          ),
        });
        if (!confirmed) return;
        await runAction(
          () => platform.removeOmnicodeProfile!({ id: profile.id }),
          "settings.omnicodeProfiles.toastRemoved",
        );
      })();
    },
    [intl, platform, requestConfirmation, runAction],
  );

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
          onClick={handleArrange}
          disabled={busy || runningCount === 0}
          title={intl.formatMessage({ id: "settings.omnicodeProfiles.arrange" })}
        >
          <LayoutGrid className="size-3.5" />
          {intl.formatMessage({ id: "settings.omnicodeProfiles.arrange" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRestore}
          disabled={busy || runningCount === 0}
          title={intl.formatMessage({ id: "settings.omnicodeProfiles.restore" })}
        >
          <Undo2 className="size-3.5" />
          {intl.formatMessage({ id: "settings.omnicodeProfiles.restore" })}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
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
                {profile.running && frames.get(profile.id) ? (
                  // [OmniCode] 实时缩略图（1.4fps JPEG；窗口隐藏时停留最后一帧）
                  <img
                    src={`data:image/jpeg;base64,${frames.get(profile.id)}`}
                    alt=""
                    className="mb-2 h-32 w-full rounded border border-border object-cover object-top"
                  />
                ) : null}
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

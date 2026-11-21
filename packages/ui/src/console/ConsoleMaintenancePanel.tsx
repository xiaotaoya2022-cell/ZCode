/**
 * [OmniCode] 新功能批次（2026-11-21 审计会话）：管理器数据维护面板——凭据立即备份/
 * 打开备份目录 + 会话库体检（体积/最近修改）+ 会话库手动备份。
 * 价值：掉线与数据库事故（kept 链撕裂历史事故）的自助维护入口；自动备份调度器之外
 * 的显式动作面。桥方法缺席（旧 preload）→ 整区不渲染。全部动作即时反馈（toast），
 * 体检只读 fs.stat（不引 sqlite 依赖、不开库句柄）。
 * 备份语义如实标注：活动库 copy 是尽力而为快照（撕裂窗口存在），用于应急回滚素材。
 */
import { useCallback, useEffect, useState } from "react";
import { DatabaseBackup, FolderOpen, ShieldCheck } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import type { OmnicodeSessionDbStatus } from "@zcode/shared";
import { formatOmnicodeByteSize } from "@/console/consoleMaintenanceModel.js";

function formatModifiedAt(intl: ReturnType<typeof useZCodeIntl>["intl"], status: OmnicodeSessionDbStatus): string {
  if (!status.exists || status.modifiedAt <= 0) {
    return intl.formatMessage({ id: "console.maintenance.sessionDbNever" });
  }
  // 项目无 intl.formatDate 封装——与 EmbeddedBrowserPaneParts 同款原生 DateTimeFormat
  //（undefined locale = 跟随界面语言环境）。
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(status.modifiedAt));
}

export function ConsoleMaintenancePanel(): React.ReactNode {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [sessionDb, setSessionDb] = useState<OmnicodeSessionDbStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadSessionDb = useCallback(async () => {
    if (!platform.getOmnicodeSessionDbStatus) return;
    try {
      setSessionDb(await platform.getOmnicodeSessionDbStatus());
    } catch {
      setSessionDb(null);
    }
  }, [platform]);

  useEffect(() => {
    void loadSessionDb();
  }, [loadSessionDb]);

  const hasAny =
    platform.backupOmnicodeCredentialsNow || platform.getOmnicodeSessionDbStatus;
  if (!hasAny) {
    return null;
  }

  const runCredentialBackup = async () => {
    if (!platform.backupOmnicodeCredentialsNow) return;
    setBusy("credentials");
    try {
      const result = await platform.backupOmnicodeCredentialsNow();
      if (result.ok) {
        toast(
          intl.formatMessage(
            { id: "console.maintenance.credentialBackupDone" },
            { count: result.backedUp },
          ),
          { variant: "default" },
        );
      } else {
        toast(
          intl.formatMessage({ id: "console.maintenance.credentialBackupFailed" }) +
            (result.errors.length > 0 ? ` (${result.errors.join(", ")})` : ""),
          { variant: "warning" },
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const openBackupsFolder = async () => {
    if (!platform.openOmnicodeCredentialBackupsFolder) return;
    setBusy("folder");
    try {
      const result = await platform.openOmnicodeCredentialBackupsFolder();
      if (!result.ok) {
        toast(intl.formatMessage({ id: "console.maintenance.folderOpenFailed" }), {
          variant: "warning",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const runSessionDbBackup = async () => {
    if (!platform.backupOmnicodeSessionDbNow) return;
    setBusy("sessiondb");
    try {
      const result = await platform.backupOmnicodeSessionDbNow();
      if (result.ok) {
        toast(
          intl.formatMessage({ id: "console.maintenance.sessionDbBackupDone" }, { path: result.backupPath }),
          { variant: "default" },
        );
        await loadSessionDb();
      } else {
        toast(
          intl.formatMessage({ id: "console.maintenance.sessionDbBackupFailed" }) +
            (result.error ? ` (${result.error})` : ""),
          { variant: "warning" },
        );
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      data-testid="omnicode-maintenance-panel"
      className="shrink-0 rounded-lg border border-border px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "console.maintenance.title" })}
        </span>
        {platform.backupOmnicodeCredentialsNow ? (
          <>
            <Button variant="outline" size="sm" onClick={() => void runCredentialBackup()} disabled={busy !== null}>
              {busy === "credentials"
                ? intl.formatMessage({ id: "console.maintenance.working" })
                : intl.formatMessage({ id: "console.maintenance.credentialBackupNow" })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void openBackupsFolder()} disabled={busy !== null}>
              <FolderOpen className="size-3.5" />
              {intl.formatMessage({ id: "console.maintenance.openBackupsFolder" })}
            </Button>
          </>
        ) : null}
      </div>
      {platform.getOmnicodeSessionDbStatus && sessionDb ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
          <DatabaseBackup aria-hidden="true" className="size-3.5 shrink-0" />
          <span>
            {intl.formatMessage({ id: "console.maintenance.sessionDbLabel" })}
            {sessionDb.exists
              ? ` ${formatOmnicodeByteSize(sessionDb.sizeBytes)} · ${formatModifiedAt(intl, sessionDb)}`
              : ` ${intl.formatMessage({ id: "console.maintenance.sessionDbAbsent" })}`}
          </span>
          {platform.backupOmnicodeSessionDbNow ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-ui-xs"
              onClick={() => void runSessionDbBackup()}
              disabled={busy !== null || !sessionDb.exists}
              title={intl.formatMessage({ id: "console.maintenance.sessionDbBackupTitle" })}
            >
              {busy === "sessiondb"
                ? intl.formatMessage({ id: "console.maintenance.working" })
                : intl.formatMessage({ id: "console.maintenance.sessionDbBackupNow" })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

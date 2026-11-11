// [OmniCode] 实例运行态重建（批次1 P0-3，借鉴 Cockpit resolve_pid 的"运行态真相=进程表实时扫描"）。
// 控制台重启后 runningByProfileId 内存表全丢；本模块扫进程表按 --omnicode-profile=<id>
// 反查存活的实例进程（argv 直传身份后进程命令行可从外部读取——handoff 方案做不到），
// 据此重建控制台运行态。持久化的 lastPid（profile.json）只是加速提示，不作为真相。
// 平台：Windows 用 PowerShell Get-CimInstance（wmic 在 Win11 24H2+ 已移除）；unix 用 ps。
// 失败语义（Cockpit process_codex_probe_cache 不变量）：探测失败 ≠ 全部实例已退出——
// 扫描异常时返回 undefined 让调用方保留上次状态，绝不返回空表冒充"没有实例在跑"。
import { execFile } from "node:child_process";
import process from "node:process";

export interface OmnicodeInstanceProcessEntry {
  profileId: string;
  pid: number;
}

const PROFILE_ARG_PREFIX = "--omnicode-profile=";
const PROFILE_ID_PATTERN = /^p[0-9a-z]{8,20}$/;

function execText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

function extractProfileId(commandLine: string): string | undefined {
  const index = commandLine.indexOf(PROFILE_ARG_PREFIX);
  if (index < 0) return undefined;
  const rest = commandLine.slice(index + PROFILE_ARG_PREFIX.length);
  // 值以空白/引号结束；先剥引号再取首个 token
  const candidate = rest.replace(/^["']/, "").split(/\s|["']/, 2)[0]?.trim() ?? "";
  return PROFILE_ID_PATTERN.test(candidate) ? candidate : undefined;
}

async function scanWindows(): Promise<OmnicodeInstanceProcessEntry[]> {
  // OmniCode 进程可能是 OmniCode.exe（packaged）或 electron.exe（dev）；按命令行旗标过滤不依赖 exe 名。
  // execFile 参数列表形式（不经 shell）；PowerShell -Command 后续 token 由 PS 自行拼接为脚本，
  // 全部为静态字面量，无任何运行时拼接输入。
  const text = await execText(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process",
      "|",
      "Where-Object { $_.CommandLine -like '*--omnicode-profile=p*' }",
      "|",
      "Select-Object ProcessId,CommandLine",
      "|",
      "ConvertTo-Json -Compress",
    ],
    10_000,
  );
  const trimmed = text.trim();
  if (!trimmed) return [];
  // 单条结果 PowerShell 直接返回对象而非数组，统一包成数组
  const parsed: unknown = JSON.parse(trimmed);
  const rows: Array<{ ProcessId?: number; CommandLine?: string }> = Array.isArray(parsed)
    ? (parsed as Array<{ ProcessId?: number; CommandLine?: string }>)
    : [parsed as { ProcessId?: number; CommandLine?: string }];
  const entries: OmnicodeInstanceProcessEntry[] = [];
  for (const row of rows) {
    const commandLine = row.CommandLine ?? "";
    const profileId = extractProfileId(commandLine);
    const pid = row.ProcessId;
    if (!profileId || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ profileId, pid });
  }
  return entries;
}

async function scanUnix(): Promise<OmnicodeInstanceProcessEntry[]> {
  // ps -axo pid=,command= 输出 "  PID command..."；逐行解析
  const text = await execText("ps", ["-axo", "pid=,command="], 10_000);
  const entries: OmnicodeInstanceProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const profileId = extractProfileId(match[2] ?? "");
    if (!profileId || !Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ profileId, pid });
  }
  return entries;
}

/**
 * 扫描全部存活的本系 OmniCode 实例进程（含各 profile 实例；主进程即控制台/主实例，
 * 其命令行同样可能带 --omnicode-profile —— 调用方按需过滤）。返回按 profileId 归并的
 * 主进程映射（同一 profileId 取最小 pid，与 Cockpit resolve_pid 的多候选策略一致）。
 * 返回 undefined = 扫描本身失败（调用方保留上次状态，不当作"无实例"）。
 */
export async function scanOmnicodeInstanceProcesses(): Promise<
  Map<string, number> | undefined
> {
  if (process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") {
    return new Map();
  }
  try {
    const entries = process.platform === "win32" ? await scanWindows() : await scanUnix();
    const byProfileId = new Map<string, number>();
    for (const entry of entries) {
      const known = byProfileId.get(entry.profileId);
      if (known === undefined || entry.pid < known) {
        byProfileId.set(entry.profileId, entry.pid);
      }
    }
    return byProfileId;
  } catch (error) {
    console.warn("[omnicode] 进程表扫描失败（保留上次运行态，不当作无实例）:", error);
    return undefined;
  }
}

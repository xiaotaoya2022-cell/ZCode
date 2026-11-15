// [OmniCode] 批次3 UI 批次：赛博鸡蛋检测（门票叠数据源，spec:
// F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3）。
// - 检测 = 对每个可用账号调 preview（走既有 billingClient，实例不必在运行——凭据在盘上）；
//   逐 profile 串行（与 claimRunner 目标解析/看板快照同节奏，无并发批量指纹）。
// - 结果在 main 侧汇聚（aggregateOmnicodeClaimDetection 纯函数）后经
//   OmnicodeAccountDetectGet 出 IPC；邮箱先脱敏再进载荷（PII 最小化）。
// - 触发节奏（红线）：管理器启动一次（renderer 首帧拉取）+ 手动触发 +
//   自动领取开启时 main 侧 30min 轮询（claimAutoPoll）。检测本身低频，绝不循环重试。
// - 永不抛穿：单账号失败归 entry 级状态 + 原因键，不影响其余账号。
import type {
  OmnicodeAccountDetectResult,
  OmnicodeAccountDetectionEntry,
  OmnicodeAccountDetectionState,
  OmnicodeAccountDetectionSummary,
} from "@zcode/shared";
import { maskOmnicodeAccountEmail } from "@zcode/shared";
import {
  buildOmnicodeBillingHeaders,
  buildOmnicodePreviewUrl,
  fetchOmnicodeBillingEnvelope,
  mapOmnicodeClaimTransportReasonKey,
  parseOmnicodePreviewEnvelope,
  type OmnicodePreviewEnvelope,
} from "./billingClient.js";
import {
  readOmnicodeAccountDataFromDataRoot,
  readOmnicodeBillingCredentials,
  type OmnicodeAccountDataSnapshot,
} from "./accountData.js";
import { getOmnicodeProfileDir, getOmnicodeProfileRecord, listOmnicodeProfiles } from "./profileRuntime.js";

/**
 * 检测状态汇聚（纯函数，单测锁定）：逐账号状态按桶计数 + 可领账号预估额度求和
 *（全缺省不编造 0——合计只有确有数值时才出现）。
 */
export function aggregateOmnicodeClaimDetection(
  accounts: readonly OmnicodeAccountDetectionEntry[],
): OmnicodeAccountDetectionSummary {
  const summary: OmnicodeAccountDetectionSummary = {
    total: accounts.length,
    claimable: 0,
    noClaim: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
  };
  let grantedUnits: number | undefined;
  for (const account of accounts) {
    switch (account.state) {
      case "claimable":
        summary.claimable += 1;
        if (typeof account.grantedUnits === "number" && Number.isFinite(account.grantedUnits)) {
          grantedUnits = (grantedUnits ?? 0) + account.grantedUnits;
        }
        break;
      case "no_claim":
        summary.noClaim += 1;
        break;
      case "skipped_no_device_mid":
      case "missing_jwt":
        summary.skipped += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      default:
        summary.unknown += 1;
        break;
    }
  }
  if (grantedUnits !== undefined) {
    summary.estimatedGrantedUnits = grantedUnits;
  }
  return summary;
}

/**
 * 展示名归一（纯函数）：displayName 优先，缺省回退 profileName（本地实例名，用户自己
 * 起的名）；两者都空回退 profileId（理论不可达，防御）。
 */
export function resolveOmnicodeDetectionDisplayName(input: {
  displayName?: string;
  profileName: string;
  profileId: string;
}): string {
  const name = input.displayName?.trim();
  if (name) return name;
  const profileName = input.profileName.trim();
  if (profileName) return profileName;
  return input.profileId;
}

/**
 * 全量检测（Profile 列表 IPC 数据源，永不 reject）：逐 profile 串行——凭据快照（只读）
 * → policy 门 → preview。检测状态与 claimRunner 目标解析同口径：
 * 缺设备号 → skipped_no_device_mid（omnicode.claim.failure.no_device_mid）、缺 JWT →
 * missing_jwt（no_jwt）、preview 失败 → failed + 传输原因键、无可领 → no_claim。
 */
export async function detectOmnicodeClaimableAccounts(
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<OmnicodeAccountDetectResult> {
  const now = options.now ?? Date.now;
  const profiles = await listOmnicodeProfiles().catch(() => [] as never[]);
  const accounts: OmnicodeAccountDetectionEntry[] = [];
  for (const profile of profiles) {
    try {
      const record = await getOmnicodeProfileRecord(profile.id).catch(() => undefined);
      const dataRoot = record?.dataBaseDirOverride?.trim() || getOmnicodeProfileDir(profile.id);
      const accountData = await readOmnicodeAccountDataFromDataRoot(dataRoot).catch(
        (): OmnicodeAccountDataSnapshot => ({}),
      );
      const displayName = resolveOmnicodeDetectionDisplayName({
        displayName: accountData.identity?.displayName,
        profileName: profile.name,
        profileId: profile.id,
      });
      const maskedEmail = maskOmnicodeAccountEmail(accountData.identity?.email);
      const base = {
        profileId: profile.id,
        profileName: profile.name,
        displayName,
        ...(maskedEmail !== undefined ? { maskedEmail } : {}),
      };
      const hasJwtToken = accountData.session?.hasJwtToken === true;
      const hasDeviceMid =
        typeof accountData.deviceMid === "string" && accountData.deviceMid.length > 0;
      if (!hasJwtToken || !hasDeviceMid) {
        accounts.push({
          ...base,
          state: hasJwtToken
            ? ("skipped_no_device_mid" as OmnicodeAccountDetectionState)
            : ("missing_jwt" as OmnicodeAccountDetectionState),
          reasonKey: hasJwtToken
            ? "omnicode.claim.failure.no_device_mid"
            : "omnicode.claim.failure.no_jwt",
        });
        continue;
      }
      const credentials = await readOmnicodeBillingCredentials(dataRoot).catch(() => undefined);
      if (!credentials || !accountData.deviceMid) {
        accounts.push({
          ...base,
          state: "unknown",
          reasonKey: "omnicode.claim.failure.unknown",
        });
        continue;
      }
      const headers = buildOmnicodeBillingHeaders(
        {
          jwtToken: credentials.jwtToken,
          deviceMid: accountData.deviceMid,
          platform: process.platform,
          arch: process.arch,
        },
        { method: "GET" },
      );
      const result = await fetchOmnicodeBillingEnvelope<OmnicodePreviewEnvelope>(
        options.fetchImpl ?? fetch,
        buildOmnicodePreviewUrl(),
        { method: "GET", headers },
      );
      if (!result.ok) {
        accounts.push({
          ...base,
          state: "failed",
          reasonKey: mapOmnicodeClaimTransportReasonKey(result.reason),
        });
        continue;
      }
      // 每账号一张：可领计划按 priority 降序取首张（preview 解析已排序，口径同 claimRunner）
      const first = parseOmnicodePreviewEnvelope(result.envelope)[0];
      if (!first) {
        accounts.push({ ...base, state: "no_claim" });
        continue;
      }
      accounts.push({
        ...base,
        state: "claimable",
        planId: first.planId,
        ...(first.name ? { planName: first.name } : {}),
        ...(first.grantUnits !== undefined ? { grantedUnits: first.grantUnits } : {}),
      });
    } catch {
      accounts.push({
        profileId: profile.id,
        profileName: profile.name,
        displayName: resolveOmnicodeDetectionDisplayName({
          profileName: profile.name,
          profileId: profile.id,
        }),
        state: "unknown",
        reasonKey: "omnicode.claim.failure.unknown",
      });
    }
  }
  return { detectedAt: now(), summary: aggregateOmnicodeClaimDetection(accounts), accounts };
}

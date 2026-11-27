// [OmniCode] 批次3 UI 批次：赛博鸡蛋检测（门票叠数据源，spec:
// F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §3）。
// - 检测 = 对每个可用账号调 marketing/touch（主数据源，官方 UI 同源信号）→ 无
//   claim_zcode_plan 时回落 preview（奖励中心列表，部分账号形态仍走这里）。
//   实例不必在运行——凭据在盘上；逐 profile 串行（与 claimRunner 目标解析/看板
//   快照同节奏，无并发批量指纹）。
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
  buildOmnicodeTouchHeaders,
  buildOmnicodeTouchUrl,
  fetchOmnicodeBillingEnvelope,
  findOmnicodeTouchClaimAction,
  mapOmnicodeClaimTransportReasonKey,
  parseOmnicodePreviewEnvelope,
  parseOmnicodeTouchEnvelope,
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
 * 单账号可领探测（touch 主源 + preview 回落；检测与 claimRunner 目标解析共用）：
 * - touch 请求成功：解析出 claim_zcode_plan → claimable；无动作 → 再查 preview
 *   （奖励中心列表对部分账号形态仍直接给出可领计划），仍无 → no_claim；
 * - touch 响应畸形（envelope 校验失败）→ 落到 preview；
 * - touch 传输失败（网络/HTTP）→ failed（同一 token 下 preview 大概率同败，不多打）。
 */
export type OmnicodeClaimProbeOutcome =
  | {
      state: "claimable";
      planId: string;
      /** 仅 preview 回落路径携带（touch delivery 只有 plan_id，无计划名/额度）。 */
      planName?: string;
      grantedUnits?: number;
    }
  | { state: "no_claim" }
  | { state: "failed"; reasonKey: string };

export async function probeOmnicodeClaimSource(options: {
  jwtToken: string;
  deviceMid: string;
  fetchImpl?: typeof fetch;
}): Promise<OmnicodeClaimProbeOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headerContext = {
    jwtToken: options.jwtToken,
    deviceMid: options.deviceMid,
    platform: process.platform,
    arch: process.arch,
  };
  const runPreviewFallback = async (): Promise<OmnicodeClaimProbeOutcome> => {
    const preview = await fetchOmnicodeBillingEnvelope<OmnicodePreviewEnvelope>(
      fetchImpl,
      buildOmnicodePreviewUrl(),
      { method: "GET", headers: buildOmnicodeBillingHeaders(headerContext, { method: "GET" }) },
    );
    if (!preview.ok) {
      return { state: "failed", reasonKey: mapOmnicodeClaimTransportReasonKey(preview.reason) };
    }
    const first = parseOmnicodePreviewEnvelope(preview.envelope)[0];
    return first
      ? {
          state: "claimable",
          planId: first.planId,
          ...(first.name ? { planName: first.name } : {}),
          ...(first.grantUnits !== undefined ? { grantedUnits: first.grantUnits } : {}),
        }
      : { state: "no_claim" };
  };
  const touch = await fetchOmnicodeBillingEnvelope<unknown>(
    fetchImpl,
    buildOmnicodeTouchUrl(),
    { method: "GET", headers: buildOmnicodeTouchHeaders(headerContext) },
  );
  if (!touch.ok) {
    if (touch.reason === "invalid_response") return runPreviewFallback();
    return { state: "failed", reasonKey: mapOmnicodeClaimTransportReasonKey(touch.reason) };
  }
  const snapshot = parseOmnicodeTouchEnvelope(touch.envelope);
  if (!snapshot) return runPreviewFallback();
  const action = findOmnicodeTouchClaimAction(snapshot);
  if (action) return { state: "claimable", planId: action.planId };
  return runPreviewFallback();
}

/**
 * 全量检测（Profile 列表 IPC 数据源，永不 reject）：逐 profile 串行——凭据快照（只读）
 * → policy 门 → 可领探测（touch 主源 + preview 回落）。检测状态与 claimRunner 目标
 * 解析同口径：缺设备号 → skipped_no_device_mid（omnicode.claim.failure.no_device_mid）、
 * 缺 JWT → missing_jwt（no_jwt）、探测失败 → failed + 传输原因键、无可领 → no_claim。
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
      const probe = await probeOmnicodeClaimSource({
        jwtToken: credentials.jwtToken,
        deviceMid: accountData.deviceMid,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (probe.state === "failed") {
        accounts.push({ ...base, state: "failed", reasonKey: probe.reasonKey });
        continue;
      }
      if (probe.state === "no_claim") {
        accounts.push({ ...base, state: "no_claim" });
        continue;
      }
      accounts.push({
        ...base,
        state: "claimable",
        planId: probe.planId,
        ...(probe.planName ? { planName: probe.planName } : {}),
        ...(probe.grantedUnits !== undefined ? { grantedUnits: probe.grantedUnits } : {}),
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

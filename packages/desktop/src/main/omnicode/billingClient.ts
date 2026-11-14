// [OmniCode] 批次3：billing 客户端（登录态看板数据层第 2 层 + 赛博鸡蛋执行）。
// spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2/§3；API 证据
// F:\OmniCode\docs\batch3\research\quota-egg-account-research.md §1.4/§2.1/§2.3。
//
// 三个端点（host 走 shared/zcodeEndpoint 既有 helper，不硬编码 origin）：
//   GET  /api/v1/zcode-plan/billing/balance?app_version={ver}    → 套餐+额度分桶
//   GET  /api/v1/zcode-plan/billing/preview?app_version&platform → 可领（免费）计划
//   POST /api/v1/zcode-plan/billing/claim  {plan_id}             → 领取
//
// 仿真头对齐 Cockpit 实测集（zcode_account.rs:983-1031）与官方
// buildZCodeSourceHeadersFromContext（packages/shared/src/zcode-source-headers.ts）：
// UA/http-referer/x-zcode-app-version/x-title/x-platform/x-release-channel/x-client-* /
// x-os-*/x-device-mid/x-request-id。X-Device-Mid 必须是「该 profile 数据根已存设备号」
//（accountData 只读复用 telemetry-state.json 的 deviceMid）——管理器绝不生成、绝不
// 共享（风控红线）；缺设备号时上游按"无设备号-跳过"处理，不发请求。
//
// 失败哲学：请求超时/网络失败/响应畸形一律归"未知"结果对象（state/failed + 稳定
// reasonKey），绝不抛穿；1001-1005 为 terminal 失败码（与官方 MarketingTouchProvider
// 的 terminal 集合一致），映射稳定原因键、不重试。token 只出现在请求头，不进结果。
import { randomUUID } from "node:crypto";
import {
  buildZCodeSourceHeadersFromContext,
  buildRuntimeZCodeApiUrl,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
  type RuntimeZCodeEndpointEnv,
} from "@zcode/shared";

/** 请求超时（与官方 marketingTouchService/zaiStartPlanBilling 同值 15s）。 */
export const OMNICODE_BILLING_REQUEST_TIMEOUT_MS = 15_000;

/** 官方口径的 terminal 失败码（MarketingTouchProvider.tsx:275）。 */
export const OMNICODE_CLAIM_TERMINAL_CODES = [1001, 1002, 1003, 1004, 1005] as const;

/** 失败码 → 稳定原因键（zh/en 文案预留；本轮不落 locale 表，只定键名）。 */
export function resolveOmnicodeClaimFailureReasonKey(code: number): string {
  switch (code) {
    case 1001:
      return "omnicode.claim.failure.plan_not_found";
    case 1002:
      return "omnicode.claim.failure.plan_unavailable";
    case 1003:
      return "omnicode.claim.failure.already_claimed";
    case 1004:
      return "omnicode.claim.failure.ineligible";
    case 1005:
      return "omnicode.claim.failure.quota_exhausted";
    case 401:
      return "omnicode.claim.failure.login_required";
    default:
      return "omnicode.claim.failure.unknown";
  }
}

/** 非 terminal 的通用原因键（网络/HTTP/响应畸形）。 */
export const OMNICODE_CLAIM_REASON_NETWORK = "omnicode.claim.failure.network";
export const OMNICODE_CLAIM_REASON_HTTP = "omnicode.claim.failure.http";
export const OMNICODE_CLAIM_REASON_INVALID_RESPONSE = "omnicode.claim.failure.invalid_response";
export const OMNICODE_BALANCE_REASON_NETWORK = "omnicode.balance.failure.network";
export const OMNICODE_BALANCE_REASON_HTTP = "omnicode.balance.failure.http";
export const OMNICODE_BALANCE_REASON_INVALID_RESPONSE = "omnicode.balance.failure.invalid_response";

/** 单账号请求资格（纯函数，单测覆盖 device-mid 来源隔离红线）。 */
export type OmnicodeBillingRequestPolicy = "go" | "skip_no_device_mid" | "skip_no_jwt";

export function resolveOmnicodeBillingRequestPolicy(input: {
  hasJwtToken: boolean;
  hasDeviceMid: boolean;
}): OmnicodeBillingRequestPolicy {
  if (!input.hasDeviceMid) return "skip_no_device_mid";
  if (!input.hasJwtToken) return "skip_no_jwt";
  return "go";
}

export interface OmnicodeBillingHeaderContext {
  jwtToken: string;
  deviceMid: string;
  /** 平台键（官方 resolveClientPlatformKey 口径 `${platform}-${arch}`）。 */
  platform: string;
  arch: string;
  appVersion?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  osVersion?: string;
  releaseChannel?: string;
  /** 注入 requestId 生成（默认 randomUUID）；测试可注入稳定值。 */
  requestId?: string;
}

/**
 * 构造 billing 请求头（纯函数）：Cockpit 实测集 + Authorization。POST（claim）额外带
 * Content-Type。deviceMid 缺失时调用方不该走到这里（先过 policy 门），此处按缺省
 *（不带 X-Device-Mid）处理——绝不现场造一个。
 */
export function buildOmnicodeBillingHeaders(
  context: OmnicodeBillingHeaderContext,
  options: { method: "GET" | "POST" } = { method: "GET" },
): Record<string, string> {
  const appVersion = context.appVersion ?? ZCODE_VERSION;
  const simulation = buildZCodeSourceHeadersFromContext({
    appVersion,
    arch: context.arch,
    clientLanguage: context.clientLanguage,
    clientTimezone: context.clientTimezone,
    deviceMid: context.deviceMid,
    endpointOrigin: resolveRuntimeZCodeEndpointOrigin(),
    osVersion: context.osVersion,
    platform: context.platform,
    releaseChannel:
      context.releaseChannel ?? (process.env.ZCODE_ENV === "test" ? "test" : "production"),
    sourceTitle: "electron",
  });
  return {
    ...simulation,
    Authorization: `Bearer ${context.jwtToken}`,
    ...(options.method === "POST" ? { "Content-Type": "application/json" } : {}),
    "X-Request-Id": context.requestId ?? randomUUID(),
  };
}

/** billing URL 构造（shared helper 拼 origin，app_version 用真实版本）。 */
export function buildOmnicodeBalanceUrl(
  env: RuntimeZCodeEndpointEnv = {},
  appVersion: string = ZCODE_VERSION,
): string {
  const url = new URL(buildRuntimeZCodeApiUrl(env, "/api/v1/zcode-plan/billing/balance"));
  url.searchParams.set("app_version", appVersion);
  return url.toString();
}

export function buildOmnicodePreviewUrl(
  env: RuntimeZCodeEndpointEnv = {},
  appVersion: string = ZCODE_VERSION,
  platformKey: string = `${process.platform}-${process.arch}`,
): string {
  const url = new URL(buildRuntimeZCodeApiUrl(env, "/api/v1/zcode-plan/billing/preview"));
  url.searchParams.set("app_version", appVersion);
  url.searchParams.set("platform", platformKey);
  return url.toString();
}

export function buildOmnicodeClaimUrl(env: RuntimeZCodeEndpointEnv = {}): string {
  return buildRuntimeZCodeApiUrl(env, "/api/v1/zcode-plan/billing/claim");
}

// ─── 响应解析（纯函数）─────────────────────────────────────────────────────────

type Numeric = number | string | null | undefined;

function toNumber(value: Numeric): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toSeconds(value: Numeric): number | undefined {
  const parsed = toNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/** balance envelope 的宽容形状（字段可缺省；与官方 ZaiStartPlanBalanceEnvelope 同源）。 */
export interface OmnicodeBalanceEnvelope {
  code?: Numeric;
  data?: {
    server_time?: Numeric;
    plans?: Array<{
      name?: string | null;
      status?: string | null;
      ends_at?: Numeric;
      plan_id?: string | null;
    }>;
    balances?: Array<{
      show_name?: string | null;
      meter?: string | null;
      total_units?: Numeric;
      used_units?: Numeric;
      remaining_units?: Numeric;
      available_units?: Numeric;
      period_end?: Numeric;
      expires_at?: Numeric;
    }>;
  };
}

/**
 * balance 解析（纯函数，对齐 Cockpit apply_quota_payload 展示口径）：
 * planType=active plan 名（fallback 首 plan），配额求和分桶，quotaResetAt=分桶
 * period_end|expires_at 最小值（秒）。畸形条目跳过不影响其余（解析规则同投放 envelope）。
 */
export function parseOmnicodeBalanceEnvelope(payload: OmnicodeBalanceEnvelope): {
  planType?: string;
  quotaTotal?: number;
  quotaUsed?: number;
  quotaRemaining?: number;
  quotaResetAt?: number;
  serverTime?: number;
  plans: { name?: string; status?: string; endsAt?: number }[];
  balances: {
    showName?: string;
    meter?: string;
    totalUnits?: number;
    usedUnits?: number;
    remainingUnits?: number;
    periodEnd?: number;
    expiresAt?: number;
  }[];
} {
  const plans = (payload.data?.plans ?? [])
    .filter((plan) => plan && typeof plan === "object")
    .map((plan) => ({
      ...(plan.name ? { name: plan.name } : {}),
      ...(plan.status ? { status: plan.status } : {}),
      ...(toSeconds(plan.ends_at) !== undefined ? { endsAt: toSeconds(plan.ends_at) } : {}),
    }));
  const balances = (payload.data?.balances ?? [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      ...(entry.show_name ? { showName: entry.show_name } : {}),
      ...(entry.meter ? { meter: entry.meter } : {}),
      ...(toNumber(entry.total_units) !== undefined
        ? { totalUnits: toNumber(entry.total_units) }
        : {}),
      ...(toNumber(entry.used_units) !== undefined
        ? { usedUnits: toNumber(entry.used_units) }
        : {}),
      ...(toNumber(entry.remaining_units ?? entry.available_units) !== undefined
        ? { remainingUnits: toNumber(entry.remaining_units ?? entry.available_units) }
        : {}),
      ...(toSeconds(entry.period_end) !== undefined
        ? { periodEnd: toSeconds(entry.period_end) }
        : {}),
      ...(toSeconds(entry.expires_at) !== undefined
        ? { expiresAt: toSeconds(entry.expires_at) }
        : {}),
    }));
  const activePlanName = plans.find((plan) => plan.status?.trim().toLowerCase() === "active")?.name;
  const planType = activePlanName ?? plans.find((plan) => plan.name)?.name;
  const sum = (values: Array<number | undefined>): number | undefined =>
    values.some((value) => value !== undefined)
      ? values.reduce<number>((acc, value) => acc + (value ?? 0), 0)
      : undefined;
  const resetCandidates = balances
    .map((entry) => entry.periodEnd ?? entry.expiresAt)
    .filter((value): value is number => value !== undefined);
  const serverTime = toSeconds(payload.data?.server_time);
  return {
    ...(planType ? { planType } : {}),
    quotaTotal: sum(balances.map((entry) => entry.totalUnits)),
    quotaUsed: sum(balances.map((entry) => entry.usedUnits)),
    quotaRemaining: sum(balances.map((entry) => entry.remainingUnits)),
    ...(resetCandidates.length > 0 ? { quotaResetAt: Math.min(...resetCandidates) } : {}),
    ...(serverTime !== undefined ? { serverTime } : {}),
    plans,
    balances,
  };
}

/** preview envelope 的宽容形状。 */
export interface OmnicodePreviewEnvelope {
  code?: Numeric;
  data?: {
    server_time?: Numeric;
    plans?: Array<{
      plan_id?: string | null;
      name?: string | null;
      priority?: Numeric;
      entitlements?: Array<{
        entitlement_id?: string | null;
        show_name?: string | null;
        meter?: string | null;
        grant_units?: Numeric;
      }>;
    }>;
  };
}

/** 可领计划（preview 解析结果；planId 为空/畸形条目丢弃）。 */
export interface OmnicodeClaimablePlan {
  planId: string;
  name?: string;
  priority: number;
  /** entitlements 的 grant_units 求和（claim 成功后的到账额度口径）。 */
  grantUnits?: number;
}

/**
 * preview 解析（纯函数）：返回可领计划列表，按 priority 降序（同分保持原序），
 * planId 缺失的条目丢弃。code≠0 视为整体失败（返回空列表，调用方按 failed 处理）。
 */
export function parseOmnicodePreviewEnvelope(
  payload: OmnicodePreviewEnvelope,
): OmnicodeClaimablePlan[] {
  if (payload.code !== undefined && toNumber(payload.code) !== 0) return [];
  const plans: OmnicodeClaimablePlan[] = [];
  for (const plan of payload.data?.plans ?? []) {
    if (!plan || typeof plan !== "object") continue;
    const planId = typeof plan.plan_id === "string" ? plan.plan_id.trim() : "";
    if (!planId) continue;
    const grantValues = (plan.entitlements ?? [])
      .map((entitlement) => toNumber(entitlement?.grant_units))
      .filter((value): value is number => value !== undefined);
    plans.push({
      planId,
      ...(plan.name ? { name: plan.name } : {}),
      priority: toNumber(plan.priority) ?? 0,
      ...(grantValues.length > 0
        ? { grantUnits: grantValues.reduce((acc, value) => acc + value, 0) }
        : {}),
    });
  }
  // 稳定排序：priority 降序（JS sort 自 ES2019 起稳定，同分保持服务端原序）
  return [...plans].sort((a, b) => b.priority - a.priority);
}

/** claim envelope 的宽容形状。 */
export interface OmnicodeClaimEnvelope {
  code?: Numeric;
  msg?: string | null;
  data?: {
    server_time?: Numeric;
    message?: string | null;
    plan?: {
      user_plan_id?: string | null;
      plan_id?: string | null;
      status?: string | null;
      starts_at?: Numeric;
      ends_at?: Numeric;
      entitlements?: Array<{
        entitlement_id?: string | null;
        show_name?: string | null;
        grant_units?: Numeric;
      }>;
    } | null;
  };
}

/** claim 解析结果（成功才带 plan/grantedUnits；失败带稳定 reasonKey，不抛错）。 */
export type OmnicodeClaimResult =
  | {
      success: true;
      planId: string;
      planName?: string;
      grantedUnits?: number;
      endsAt?: number;
    }
  | { success: false; code: number; reasonKey: string };

/**
 * claim 解析（纯函数）：code=0 且 data.plan 存在 = 成功（planName 取 entitlements
 * show_name，grantedUnits=grant_units 求和）；其余一律失败结果，1001-1005 映射稳定
 * 原因键（terminal，不重试），非数字 code 归 invalid_response。
 */
export function parseOmnicodeClaimEnvelope(payload: OmnicodeClaimEnvelope): OmnicodeClaimResult {
  const rawCode = payload.code;
  const code =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^\d+$/.test(rawCode)
        ? Number(rawCode)
        : -1;
  if (code !== 0 || !payload.data?.plan || typeof payload.data.plan !== "object") {
    if (code === -1) {
      return { success: false, code, reasonKey: OMNICODE_CLAIM_REASON_INVALID_RESPONSE };
    }
    return { success: false, code, reasonKey: resolveOmnicodeClaimFailureReasonKey(code) };
  }
  const plan = payload.data.plan;
  const planId = typeof plan.plan_id === "string" && plan.plan_id.trim() ? plan.plan_id.trim() : "";
  const entitlements = (plan.entitlements ?? []).filter(
    (entitlement) => entitlement && typeof entitlement === "object",
  );
  const planName = entitlements.find((entitlement) => entitlement.show_name)?.show_name ?? undefined;
  const grantValues = entitlements
    .map((entitlement) => toNumber(entitlement?.grant_units))
    .filter((value): value is number => value !== undefined);
  const endsAt = toSeconds(plan.ends_at);
  return {
    success: true,
    planId,
    ...(planName ? { planName } : {}),
    ...(grantValues.length > 0
      ? { grantedUnits: grantValues.reduce((acc, value) => acc + value, 0) }
      : {}),
    ...(endsAt !== undefined ? { endsAt } : {}),
  };
}

// ─── 网络执行（可注入 fetch；永不抛穿）────────────────────────────────────────

export type OmnicodeBillingFetch = typeof fetch;

/** fetch 层原始原因（映射前的短键；balance/claim 各自映射为面向 UI 的稳定键）。 */
export type OmnicodeBillingTransportReason = "network" | "http" | "invalid_response";

export type OmnicodeBillingFetchResult<TEnvelope> =
  | { ok: true; envelope: TEnvelope }
  | { ok: false; reason: OmnicodeBillingTransportReason; httpStatus?: number };

/** 读 JSON body 的宽容上限（64KiB——billing 响应实测数 KB 量级，越界按畸形处理）。 */
const OMNICODE_BILLING_BODY_MAX_BYTES = 65_536;

/**
 * 单次 billing 请求执行：超时/网络错误 → network；非 2xx → http；body 越界/JSON 解析
 * 失败/非对象 → invalid_response。任何分支都不抛穿（返回原因对象）。
 */
export async function fetchOmnicodeBillingEnvelope<TEnvelope>(
  fetchImpl: OmnicodeBillingFetch,
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  timeoutMs: number = OMNICODE_BILLING_REQUEST_TIMEOUT_MS,
): Promise<OmnicodeBillingFetchResult<TEnvelope>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!response.ok) {
    return { ok: false, reason: "http", httpStatus: response.status };
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > OMNICODE_BILLING_BODY_MAX_BYTES) {
    return { ok: false, reason: "invalid_response", httpStatus: response.status };
  }
  let parsed: unknown;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > OMNICODE_BILLING_BODY_MAX_BYTES) {
      return { ok: false, reason: "invalid_response", httpStatus: response.status };
    }
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_response", httpStatus: response.status };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid_response", httpStatus: response.status };
  }
  return { ok: true, envelope: parsed as TEnvelope };
}

/** 把 fetch 层原因映射到面向 UI 的稳定原因键（balance 口径）。 */
export function mapOmnicodeBalanceFailureReasonKey(reason: OmnicodeBillingTransportReason): string {
  if (reason === "network") return OMNICODE_BALANCE_REASON_NETWORK;
  if (reason === "http") return OMNICODE_BALANCE_REASON_HTTP;
  return OMNICODE_BALANCE_REASON_INVALID_RESPONSE;
}

/** 把 fetch 层原因映射到面向 UI 的稳定原因键（claim 口径；terminal 码不在此层映射）。 */
export function mapOmnicodeClaimTransportReasonKey(reason: OmnicodeBillingTransportReason): string {
  if (reason === "network") return OMNICODE_CLAIM_REASON_NETWORK;
  if (reason === "http") return OMNICODE_CLAIM_REASON_HTTP;
  return OMNICODE_CLAIM_REASON_INVALID_RESPONSE;
}

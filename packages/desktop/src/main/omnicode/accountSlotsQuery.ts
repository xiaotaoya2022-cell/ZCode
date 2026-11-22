// [OmniCode] 模式二 R3：main → Host 调度器槽位用量查询（spec:
// docs/omnicode/multi-account-sessions.md §6/§7——"槽位数据源：调度器计数经桥/IPC 暴露
// 给 renderer（元数据 only）"）。
//
// 通道：main→Host 消息（HostMessageTypes.OmnicodeAccountSlotsRequest，requestId 关联）
// → Host（host/index.ts）读自身调度器快照 → HostResponseTypes.OmnicodeAccountSlotsResult
// → 本模块 pending 表 resolve（desktopHostProcess.ts 路由）→ 实例 main IPC 回 renderer。
//
// 本模块职责（main 进程内，纯簿记 + 无轮询）：
// - 请求关联（requestId pending 表 + 安全网超时）；
// - 应答按 shared 载荷契约校验（omnicodeAccountSlotsResultPayloadSchema——元数据 only，
//   防载荷放大/漂移）。
import { randomUUID } from "node:crypto";
import {
  omnicodeAccountSlotsResultPayloadSchema,
  HostMessageTypes,
  type OmnicodeAccountSlotsResultPayload,
} from "@zcode/shared";
import { listOmnicodeHostChildren } from "./hostChildRegistry.js";

/** 槽位查询安全网超时（Host 内读调度器快照为纯内存操作；超时按缺省失败收口）。 */
const OMNICODE_ACCOUNT_SLOTS_TIMEOUT_MS = 8_000;

const pending = new Map<
  string,
  { resolve: (payload: OmnicodeAccountSlotsResultPayload) => void; timer: NodeJS.Timeout }
>();

const EMPTY_SLOTS_FAILURE: OmnicodeAccountSlotsResultPayload = {
  ok: false,
  error: "omnicode_account_slots_unavailable",
};

/**
 * 查询调度器槽位用量快照（元数据 only）。无 Host / 发送失败 / 超时 / 校验失败 → ok=false
 * 结构化失败（消费方按"槽位不可见"渲染，不抛穿、不缓存）。
 */
export function requestOmnicodeAccountSlotsFromHost(): Promise<OmnicodeAccountSlotsResultPayload> {
  const child = listOmnicodeHostChildren()[0];
  if (!child) {
    return Promise.resolve(EMPTY_SLOTS_FAILURE);
  }
  const requestId = randomUUID();
  return new Promise<OmnicodeAccountSlotsResultPayload>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(EMPTY_SLOTS_FAILURE);
    }, OMNICODE_ACCOUNT_SLOTS_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        resolve(payload);
      },
      timer,
    });
    try {
      child.postMessage({ type: HostMessageTypes.OmnicodeAccountSlotsRequest, requestId });
    } catch {
      pending.delete(requestId);
      clearTimeout(timer);
      resolve(EMPTY_SLOTS_FAILURE);
    }
  });
}

/** 槽位应答路由（desktopHostProcess 消息监听消费；迟到/陌生 requestId 直接丢弃）。 */
export function resolveOmnicodeAccountSlotsResult(message: unknown): void {
  const raw = message as { requestId?: unknown; ok?: unknown; slots?: unknown; error?: unknown };
  if (typeof raw?.requestId !== "string") return;
  const settle = pending.get(raw.requestId);
  if (!settle) return;
  pending.delete(raw.requestId);
  const parsed = omnicodeAccountSlotsResultPayloadSchema.safeParse({
    ok: raw.ok,
    ...(Array.isArray(raw.slots) ? { slots: raw.slots } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  });
  settle.resolve(
    parsed.success
      ? parsed.data
      : { ok: false, error: "omnicode_account_slots_invalid_reply" },
  );
}

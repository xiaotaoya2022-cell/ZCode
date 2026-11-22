// [OmniCode] 模式二 R1.5：会话作用域接线——会话→附加账号绑定注册表与 Host 内作用域
// 包裹决策（spec: docs/omnicode/multi-account-sessions.md §4/§10-R1.5）。
//
// 设计要点：
// - 绑定载体 = sendPrompt 参数 omnicodeAccountId（与 modelSelection 同路透传；R2 调度 /
//   R3 UI 是未来的生产者）。绑定记录发生在 zcodeTaskServiceAdapter.sendPromptToAgent
//   （Host 进程内）；消费发生在 zcodeAgentService.resolveAccountRequestAuth——CLI agent
//   runtime 每条 providerRuntimeHeaders 请求带 sessionId，这里是 Host 内"该会话所有请求
//   凭据物化"的唯一祖先函数，一个包裹点覆盖该会话请求/计费/usage 的凭据解析。
// - agent 运行期 turn 在独立 CLI 进程执行，Host 侧 sendPrompt 的 AsyncLocalStorage 无法
//   跨协议回调存活——因此采用"sendPrompt 时登记 + 凭据解析时按 sessionId 命中作用域"，
//   而非在 sendPrompt 处直接 runWithOmnicodeAccountScope。
// - 门控默认 = OMNICODE_PROFILE_ID env（与 accountOverride 同源语义）：门控关 → bind 恒
//   no-op、resolve 恒 null、包裹恒透传——官方 flavor 行为逐字不变。
// - 注册表有界（FIFO 淘汰最旧绑定），事件驱动无轮询；会话删除后的残留绑定由有界容量自然
//   淘汰（R2 调度接入时可叠加显式 unbind）。
import { runWithOmnicodeAccountScope } from "./accountOverride.js";

/** omnicode Profile 实例门控（与 accountOverride 同源判定；测试可注入覆盖）。 */
export function isOmnicodeSessionScopeGateActive(): boolean {
  return Boolean(process.env.OMNICODE_PROFILE_ID?.trim());
}

/**
 * 包裹决策（纯函数）：omnicode 门控关 → 不包裹；未绑定 accountId → 不包裹；
 * 绑定且门控开 → 包裹。
 */
export function shouldWrapOmnicodeAccountScope(params: {
  gateActive: boolean;
  accountId: string | null;
}): boolean {
  if (!params.gateActive) return false;
  return Boolean(params.accountId?.trim());
}

const REGISTRY_MAX_ENTRIES = 512;
const registryKeyJoiner = "\u0000";

function sessionScopeRegistryKey(params: {
  workspaceKey?: string | null;
  sessionId: string;
}): string {
  const workspaceKey = params.workspaceKey?.trim() ?? "";
  const sessionId = params.sessionId.trim();
  if (!sessionId) return "";
  return `${workspaceKey}${registryKeyJoiner}${sessionId}`;
}

export interface OmnicodeSessionAccountScopeRegistry {
  /** 记录会话→附加账号绑定（门控关/键或 accountId 非法时 no-op；重复绑定覆盖旧值）。 */
  bind(params: { workspaceKey?: string | null; sessionId: string; accountId: string }): void;
  /** 读取会话绑定的附加账号 id；未绑定/非法键 → null（官方路径信号）。 */
  resolve(params: { workspaceKey?: string | null; sessionId: string }): string | null;
  /** 显式解除会话绑定（会话删除等生产者可调用；未绑定为 no-op）。 */
  unbind(params: { workspaceKey?: string | null; sessionId: string }): void;
  /** 按 sessionId 全局解绑（会话 id 全局唯一——免疫 workspaceKey 归一化漂移，终审 P2-3）。 */
  unbindBySessionId(sessionId: string): void;
  /** 内存诊断计数器（只读 size）。 */
  size(): number;
  /** 门控判定（包裹决策复用同一事实；缺省 = OMNICODE_PROFILE_ID env）。 */
  isActive(): boolean;
}

export function createOmnicodeSessionAccountRegistry(options?: {
  isActive?: () => boolean;
}): OmnicodeSessionAccountScopeRegistry {
  const isActive = options?.isActive ?? isOmnicodeSessionScopeGateActive;
  const entries = new Map<string, string>();
  return {
    bind(params) {
      if (!isActive()) return;
      const key = sessionScopeRegistryKey(params);
      const accountId = params.accountId.trim();
      if (!key || !accountId) return;
      // Map 保插入序：先删再插把重复绑定刷新为最新，FIFO 淘汰弹出的即最旧绑定。
      entries.delete(key);
      while (entries.size >= REGISTRY_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, accountId);
    },
    resolve(params) {
      const key = sessionScopeRegistryKey(params);
      if (!key) return null;
      return entries.get(key) ?? null;
    },
    unbind(params) {
      const key = sessionScopeRegistryKey(params);
      if (!key) return;
      entries.delete(key);
    },
    unbindBySessionId(sessionId) {
      if (!sessionId.trim()) return;
      const suffix = `${registryKeyJoiner}${sessionId.trim()}`;
      for (const key of [...entries.keys()]) {
        if (key === sessionId.trim() || key.endsWith(suffix)) entries.delete(key);
      }
    },
    size() {
      return entries.size;
    },
    isActive,
  };
}

/**
 * 作用域包裹执行器：未绑定/门控关 → 原样执行 fn（官方路径逐字不变）；绑定且门控开 →
 * runWithOmnicodeAccountScope 包裹——fn 及其全部同步/异步续体都在附加账号作用域内，
 * accountOverride 的三个 loader 覆盖边界按该账号材料作答。
 */
export async function runWithOmnicodeSessionAccountScope<T>(params: {
  accountId: string | null;
  gateActive?: boolean;
  fn: () => Promise<T> | T;
}): Promise<T> {
  const gateActive = params.gateActive ?? isOmnicodeSessionScopeGateActive();
  if (!shouldWrapOmnicodeAccountScope({ gateActive, accountId: params.accountId })) {
    return await params.fn();
  }
  return runWithOmnicodeAccountScope(params.accountId!.trim(), () => Promise.resolve(params.fn()));
}

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
// - 注册表有界（LRU-by-resolve 淘汰最久未命中的绑定），事件驱动无轮询；会话删除后的
//   残留绑定由有界容量自然淘汰（显式 unbind 生产者：turn 终态/会话删除/runtime 断连批量解绑）。
// - R3.5（终审 P2-1）：淘汰序 FIFO→LRU-by-resolve——resolve 命中即 touch（移到队尾），
//   淘汰只删最久未 resolve 的条目。活跃会话每条 providerRuntimeHeaders 请求都命中 resolve
//   → 运行期永不淘汰，杜绝"turn 存续期被新绑定挤掉 → 静默回落主账号 → 计费归属漂移"；
//   仅长期空闲绑定被淘汰（该场景回落主账号 = 既有语义）。上限 512→2048（LRU 保护下
//   每条目均为活跃或近期会话，内存代价线性且可控）。
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

// LRU 容量上限（R3.5：512→2048；LRU-by-resolve 下活跃会话不占淘汰名额）。
const REGISTRY_MAX_ENTRIES = 2048;
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
  /** 按 sessionId 集合批量全局解绑（R3.5 runtime 断连批量回收；单次遍历，幂等）。 */
  unbindBySessionIds(sessionIds: readonly string[]): void;
  /** 内存诊断计数器（只读 size）。 */
  size(): number;
  /** 门控判定（包裹决策复用同一事实；缺省 = OMNICODE_PROFILE_ID env）。 */
  isActive(): boolean;
}

export function createOmnicodeSessionAccountRegistry(options?: {
  isActive?: () => boolean;
}): OmnicodeSessionAccountScopeRegistry {
  const isActive = options?.isActive ?? isOmnicodeSessionScopeGateActive;
  // LRU-by-resolve（Map 保插入序）：resolve/bind 命中先删再插移到队尾 = 最近使用；
  // 淘汰弹出队首 = 最久未 resolve 的绑定（R3.5 终审 P2-1：活跃会话每请求都 resolve →
  // 永不落到队首，运行期永不淘汰）。
  const entries = new Map<string, string>();
  const touch = (key: string, accountId: string): void => {
    entries.delete(key);
    entries.set(key, accountId);
  };
  return {
    bind(params) {
      if (!isActive()) return;
      const key = sessionScopeRegistryKey(params);
      const accountId = params.accountId.trim();
      if (!key || !accountId) return;
      while (entries.size >= REGISTRY_MAX_ENTRIES) {
        const lru = entries.keys().next().value;
        if (lru === undefined) break;
        entries.delete(lru);
      }
      touch(key, accountId);
    },
    resolve(params) {
      const key = sessionScopeRegistryKey(params);
      if (!key) return null;
      const accountId = entries.get(key);
      if (accountId === undefined) return null;
      // 命中即 touch（LRU 记账；每次凭据解析一次 O(1) Map 重插，无轮询无定时器）。
      touch(key, accountId);
      return accountId;
    },
    unbind(params) {
      const key = sessionScopeRegistryKey(params);
      if (!key) return;
      entries.delete(key);
    },
    unbindBySessionId(sessionId) {
      if (!sessionId.trim()) return;
      const suffix = `${registryKeyJoiner}${sessionId.trim()}`;
      // Map 迭代器对遍历中删除安全（被删键跳过继续），无需快照拷贝。
      for (const key of entries.keys()) {
        if (key === sessionId.trim() || key.endsWith(suffix)) entries.delete(key);
      }
    },
    unbindBySessionIds(sessionIds) {
      const ids = new Set<string>();
      for (const id of sessionIds) {
        if (id.trim()) ids.add(id.trim());
      }
      if (ids.size === 0) return;
      // 键形 = `${workspaceKey}\0${sessionId}`（workspaceKey 空时退化为裸 sessionId）。
      // lastIndexOf 对齐 endsWith 语义（workspaceKey 理论上不含 \0，防御性取末段）。
      for (const key of entries.keys()) {
        if (ids.has(key)) {
          entries.delete(key);
          continue;
        }
        const separatorIndex = key.lastIndexOf(registryKeyJoiner);
        if (separatorIndex < 0) continue;
        if (ids.has(key.slice(separatorIndex + registryKeyJoiner.length))) entries.delete(key);
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

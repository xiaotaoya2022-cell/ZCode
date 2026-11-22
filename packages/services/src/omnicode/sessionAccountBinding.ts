// [OmniCode] 模式二 R3/R4：会话绑定决策（纯函数，spec:
// docs/omnicode/multi-account-sessions.md §6/§7/§10-R3/R4）。
//
// 桌面 v4 sendText 与 sendPrompt 管道共用的"这一次输入用哪个附加账号"裁决点：
// - 显式账号（R3 选择器透传 payload.omnicodeAccountId）→ 直接绑定（用户意图优先）；
// - 无显式且智能调度开（R4 缺省路径）→ scheduler.pickAccount 在目录候选里挑剩余槽
//   最多的账号（含退避降权跳过）；无可用槽 → 不绑定（回落主账号，官方路径）；
// - 无显式且智能调度关（手动模式）→ 不绑定（主账号；用户可用选择器显式指定）。
// 决策输入全量可注入（门控/开关/候选/调度器），无 IO 无轮询；omnicode 门控关
// （非实例进程）恒 no-bind——官方行为逐字不变。

export interface OmnicodeSessionAccountBindDecisionInput {
  /** omnicode 实例门控（OMNICODE_PROFILE_ID env / 注册表 isActive）。关 → 恒不绑定。 */
  gateActive: boolean;
  /** 显式账号（R3 选择器透传；空/空白 = 未显式选）。 */
  explicitAccountId: string | null;
  /** 智能调度开关（omnicodeSmartScheduling；缺席 = 开）。 */
  smartEnabled: boolean;
  /** 附加账号候选（目录注册表序）。 */
  candidates: readonly string[];
  /** pickAccount 决策器（缺席 = 视为无可用调度 → 不绑定）。 */
  pickAccount: ((candidates: readonly string[]) => string | null) | null;
}

/** 决策结果：accountId=null = 不绑定（主账号官方路径）；reason 供日志/测试断言。 */
export interface OmnicodeSessionAccountBindDecision {
  accountId: string | null;
  reason: "explicit" | "smart" | "manual" | "gate-off" | "no-candidate";
}

/** 决策纯函数（单测锁定）：显式 > 智能 > 手动；门控关恒 no-bind。 */
export function shouldBindOmnicodeSessionAccount(
  input: OmnicodeSessionAccountBindDecisionInput,
): OmnicodeSessionAccountBindDecision {
  if (!input.gateActive) {
    return { accountId: null, reason: "gate-off" };
  }
  const explicit = input.explicitAccountId?.trim() ?? "";
  if (explicit) {
    return { accountId: explicit, reason: "explicit" };
  }
  if (!input.smartEnabled) {
    return { accountId: null, reason: "manual" };
  }
  if (!input.pickAccount) {
    return { accountId: null, reason: "manual" };
  }
  const picked = input.pickAccount(input.candidates);
  if (!picked?.trim()) {
    return { accountId: null, reason: "no-candidate" };
  }
  return { accountId: picked, reason: "smart" };
}

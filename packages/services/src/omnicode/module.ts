/**
 * omnicode-workspace-governance 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const omnicodeWorkspaceGovernanceModule = {
  id: "omnicode-workspace-governance",
  // 模式二（multi-account-sessions §5）：附加账号材料文件用
  // createSystemCredentialCipher 加密——requires 增补 credential-security
  //（loginHealth X2 同款先例）。
  requires: ["services", "shared", "credential-security"],
  provides: ["omnicode-workspace-governance"],
  publicEntrypoints: ["contract.ts"],
} as const;

/**
 * omnicode-profile-runtime 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 批次2 B2-3 requires 增补 desktop：instanceBridgeClient 释放内嵌时恢复桌面窗口最低
 * 尺寸（desktopWindowSize 常量）——desktop 为 managed:false 主树，不产生循环。
 * 批次2.5 X2 requires 增补 credential-security：loginHealth 管理器直读凭据快照
 * （createSystemCredentialCipher 解 expiresAt，spec: docs/omnicode/console-extras.md §X2）。
 */
export const omnicodeProfileRuntimeModule = {
  id: "omnicode-profile-runtime",
  requires: ["shared", "desktop", "credential-security"],
  provides: ["omnicode-profile-runtime"],
  publicEntrypoints: ["contract.ts", "profileBootstrap.ts"],
} as const;

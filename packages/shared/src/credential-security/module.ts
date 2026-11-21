export type {
  CredentialCipher,
  SystemCredentialCipher,
  CredentialKeyStore,
  SystemCredentialCipherOptions,
  PrivateFileKeyFallbackOptions,
} from "./contract.js";
export {
  createSystemCredentialCipher,
  createServerCredentialCipher,
  createLegacyServerCredentialCipher,
  prepareServerCredentialStorage,
  enablePrivateFileKeyFallback,
  createLegacyCredentialCipher,
  migrateCredentialRecord,
  // [OmniCode] omni.5 真机修复（F2-5）：console 根 os→env 一次性迁移原语 + keyring 探测
  reWrapOsCredentialValuesWithEnvKey,
  readSystemCredentialKeyringEntry,
  SYSTEM_CREDENTIAL_KEYRING_SERVICE,
} from "./systemCredentialCipher.js";
export {
  createCredentialCipherBridge,
  executeCredentialCipherRequest,
  credentialCipherRequestSchema,
  credentialCipherReplySchema,
  credentialCipherResultSchema,
  type CredentialCipherRequest,
  type CredentialCipherReply,
} from "./bridge.js";

import {
  createLocalServices,
  getAppConfigDir,
  type ZCodeAgentCommandResolver,
} from "@zcode/services/node";
import { createServerCredentialCipher } from "@zcode/shared/credential-security";
import { join } from "node:path";
import type { IChannel } from "@zcode/rpc";
import {
  parseServiceAuthorityMode,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";

export interface CreateStdioServicesOptions {
  topicResourceRelayChannel?: () => IChannel;
  env?: Record<string, string | undefined>;
  zcodeBuiltinProviderConfigFilePath: string;
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** [OmniCode] M4c：relay executor（entry 侧从共享频道实例装配）；缺省则远程 browser 命令维持 backend_unavailable。 */
  browserRelayExecutor?: Parameters<typeof createLocalServices>[0]["browserRelayExecutor"];
}

export interface RemoteAgentNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
}

export function resolveRemoteAgentNetworkFromEnv(
  env: Record<string, string | undefined>,
): RemoteAgentNetworkOptions | undefined {
  if (env[ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]?.trim() !== "1") {
    return undefined;
  }
  return {
    httpProxy: env[ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]?.trim() || undefined,
    noProxy: env[ZCODE_REMOTE_NO_PROXY_ENV_KEY]?.trim() || undefined,
  };
}

export async function createStdioServices(options: CreateStdioServicesOptions) {
  const env = options.env ?? process.env;
  const authorityModeParseResult = parseServiceAuthorityMode(env);
  const remoteAgentNetwork = resolveRemoteAgentNetworkFromEnv(env);
  // 旧 stdio 入口也必须在发布 ready 前验证存储，不能在同步到一半时才失败。
  const credentialCipherProvider = await createServerCredentialCipher({
    filePath: join(getAppConfigDir(), "credentials.json"),
    env,
  });
  // 远程 Desktop 的呈现能力必须从 stdio 入口收到的 authority mode 进入 Services 推导链。
  // 测试注入 resolver 只用于在 spawn 前观察最终命令，不改变生产默认 resolver。
  const services = createLocalServices({
    credentialCipherProvider,
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    serviceAuthorityMode: authorityModeParseResult.mode,
    zcodeAgentCommandResolver: options.zcodeAgentCommandResolver,
    remoteAgentNetwork,
    // [OmniCode] M4c Browser Relay：agent 的 browser 反向请求在无本地桥时降级走 relay。
    browserRelayExecutor: options.browserRelayExecutor,
  });

  return {
    authorityModeParseResult,
    services,
  };
}

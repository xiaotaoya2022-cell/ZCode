import { createInterface } from "node:readline";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import {
  IProjectService,
  IProviderProvisioningTargetService,
  IZCodeAgentService,
  ISourceServerWorkspaceService,
} from "@zcode/services";
import {
  createBrowserRelayAgentExecutor,
  createOmniCodeBrowserRelayChannel,
  createServerHostServices,
  disposeServiceResourcesAndWait,
} from "@zcode/services/node";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { createCoreHttpServer } from "../../../../../zcode-server-cli/src/server-core/http.js";

const testHome = process.env.HOME;
if (!testHome || basename(testHome) !== "url-server")
  throw new Error("isolated URL Server HOME required");
const serverId = "e2e-virtual-url-server";
const hostId = remoteHostIdFromWorkspaceIdentity(
  buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: "/" }),
)!;
// [OmniCode] M4c Browser Relay：与 createCoreHttpServer 共用同一频道实例（services 的 relay
// executor 与 HTTP 侧注册必须指向同一事实源）；测试夹具与生产 Core 同形装配。
const browserRelayChannel = createOmniCodeBrowserRelayChannel();
const { services, workspaceIdentityMapper, migrationFailedPathCount } =
  await createServerHostServices({
    sourceServerId: serverId,
    providerProvisioningTargetEnabled: true,
    zcodeBuiltinProviderConfigFilePath: resolve("../../config/provider/zcode-builtin.json"),
    browserRelayExecutor: createBrowserRelayAgentExecutor(browserRelayChannel),
  });
// 仅观测真实服务入参，继续调用原实现，避免将模型回复成功误当作项目绑定成功。
const provisioning = services.get(IProviderProvisioningTargetService);
const applyProvisioning = provisioning.apply.bind(provisioning);
provisioning.apply = async (envelope) => {
  const result = await applyProvisioning(envelope);
  if (result.status === "failed")
    process.stderr.write(`E2E_VP_PROVIDER_FAILURE ${result.errorMessage}\n`);
  return result;
};
const agentService = services.get(IZCodeAgentService);
const sendCommand = agentService.sendConversationCommandV4.bind(agentService);
agentService.sendConversationCommandV4 = async (params) => {
  if (params.envelope.type === "createSession")
    process.stdout.write(
      `E2E_VP17_CREATE ${JSON.stringify({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        projectId: params.projectId,
        additionalDirectories: (params.envelope.payload as { additionalDirectories?: string[] })
          .additionalDirectories,
      })}\n`,
    );
  return sendCommand(params);
};
const root = join(testHome, "work", "repo");
await mkdir(root, { recursive: true });
const extraRoot = root;
await mkdir(join(extraRoot, ".agents", "skills", "remote-probe"), { recursive: true });
await writeFile(
  join(extraRoot, ".agents", "skills", "remote-probe", "SKILL.md"),
  "---\nname: remote-probe\ndescription: E2E_VP17_REMOTE_EXTRA_SKILL\n---\nFixture capability.\n",
);
if (!agentService.onAgentRuntimeLifecycle)
  throw new Error("VP18 requires runtime lifecycle observations");
agentService.onAgentRuntimeLifecycle((event) => {
  if (event.workspacePath === root)
    process.stdout.write(
      `E2E_VP18_RUNTIME ${JSON.stringify({
        state: event.state,
        identity: event.runtimeIdentity.identity,
      })}\n`,
    );
});
const project = await services
  .get(IProjectService)
  .saveProject({ name: "E2E_VP08_URL", roots: [root], primaryRoot: root });
const server = await createCoreHttpServer(services, {
  host: "127.0.0.1",
  port: 0,
  serverId,
  workspaceIdentityMapper,
  migrationFailedPathCount,
  browserRelayChannel,
});
process.stdout.write(
  `E2E_VP_SERVER_READY ${JSON.stringify({ port: server.port, serverId, hostId, projectId: project.id })}\n`,
);
process.on("SIGTERM", () => {
  void (async () => {
    await server.close();
    await disposeServiceResourcesAndWait(services);
    process.exit(0);
  })();
});

const commands = createInterface({ input: process.stdin });
commands.on("line", (command) => {
  if (command === "refresh-skills-and-dispose")
    void (async () => {
      const coldRoot = root;
      await rm(join(root, ".agents", "skills", "remote-probe"), { recursive: true });
      await mkdir(join(coldRoot, ".agents", "skills", "cold-probe"), { recursive: true });
      await writeFile(
        join(coldRoot, ".agents", "skills", "cold-probe", "SKILL.md"),
        "---\nname: cold-probe\ndescription: E2E_VP18_REMOTE_COLD_SKILL\n---\nFixture capability.\n",
      );
      const { canonicalWorkspaceKey } = await services
        .get(ISourceServerWorkspaceService)
        .resolveWorkspace({ workspacePath: root });
      await agentService.disposeWorkspace({
        workspacePath: root,
        workspaceIdentity: canonicalWorkspaceKey,
      });
      process.stdout.write("E2E_VP18_DISPOSED\n");
    })().catch((error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
  if (command === "rename-externally")
    void services
      .get(IProjectService)
      .saveProject({ id: project.id, name: "E2E_VP08_URL_EXTERNAL" })
      .catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
      });
});

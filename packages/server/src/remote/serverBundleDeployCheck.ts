import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import { quotePosixPathArg, quotePosixShellArg } from "@zcode/server/remote/posixShell.js";
import { FORK_SERVER_BUNDLE_MARKERS } from "@zcode/shared";

const REQUIRED_SERVER_BUNDLE_MARKERS = [
  "skill-sync",
  "mcp-sync",
  "plugin-sync",
  "user-config-sync",
  "__zcode_rpc_nested_uint8array_v1",
  "exportMarketplaceSourceArchive",
  "importMarketplaceSourceArchive",
];

export type ServerBundleDeployDecision =
  | { shouldDeploy: false }
  | { shouldDeploy: true; reason: string };

export async function checkServerBundleRequiredMarkers(
  backend: IRemoteBackend,
  nodePath: string,
  serverPath: string,
): Promise<ServerBundleDeployDecision> {
  const script = `
const fs = require("fs");
const content = fs.readFileSync(process.argv[1], "utf8");
const missing = ${JSON.stringify(REQUIRED_SERVER_BUNDLE_MARKERS)}.filter((marker) => !content.includes(marker));
if (missing.length > 0) {
  console.error("missing required server bundle markers: " + missing.join(","));
  process.exit(2);
}
`;
  const stream = await backend.exec(
    `${quotePosixPathArg(nodePath)} -e ${quotePosixShellArg(script)} ${quotePosixPathArg(serverPath)}`,
  );
  try {
    await waitForDeployCheckClose(stream);
    return { shouldDeploy: false };
  } catch (error) {
    // 开发态远端 server 可能版本号相同但 bundle 内容仍是旧包，旧包没有
    // skill/plugin sync channel，renderer 侧会表现为 “Channel name 'skill-sync' timed out”。
    // 这里用远端已部署 bundle 的能力标记做精确探测，只在缺少必要 channel 时刷新主 server。
    return {
      shouldDeploy: true,
      reason: `remote server bundle missing required markers: ${String(error)}`,
    };
  }
}

// [OmniCode] M4b Browser Relay：fork marker 探测（能力门控，非 deploy 决策）。
// 写法沿用上方 REQUIRED_SERVER_BUNDLE_MARKERS 的 node -e 文本探测；marker 集合来自
// @zcode/shared 的 FORK_SERVER_BUNDLE_MARKERS（"omnicode-browser-relay"）。
// 注意：探测结果只用于桌面端是否订阅 onDynamicBrowserRelayRequest 的能力门控，
// 不得参与 deploy 决策——CDN 下载的官方 bundle 永远不含 fork marker，参与决策会
// 造成每次连接都触发永不收敛的重新部署（ZakiCode spec：marker probing only for
// local-source deploys）。
export async function checkServerBundleForkMarkers(
  backend: IRemoteBackend,
  nodePath: string,
  serverPath: string,
): Promise<boolean> {
  const script = `
const fs = require("fs");
const content = fs.readFileSync(process.argv[1], "utf8");
const missing = ${JSON.stringify(FORK_SERVER_BUNDLE_MARKERS)}.filter((marker) => !content.includes(marker));
if (missing.length > 0) {
  console.error("missing fork bundle markers: " + missing.join(","));
  process.exit(2);
}
`;
  const stream = await backend.exec(
    `${quotePosixPathArg(nodePath)} -e ${quotePosixShellArg(script)} ${quotePosixPathArg(serverPath)}`,
  );
  try {
    await waitForDeployCheckClose(stream);
    return true;
  } catch {
    // 官方 bundle（缺 marker，exit 2）与探测失败（远端文件不可读等）都按"无 fork 能力"
    // 收口；这是能力探测，失败方向必须是关闭 relay，不能抛错影响连接本身。
    return false;
  }
}

function waitForDeployCheckClose(stream: StdioStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrText = "";
    stream.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrText.length >= 2048) {
        return;
      }
      stderrText += chunk.toString();
    });
    stream.onClose((code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderrText.trim() || `remote deploy check exited with code ${code}`));
    });
  });
}

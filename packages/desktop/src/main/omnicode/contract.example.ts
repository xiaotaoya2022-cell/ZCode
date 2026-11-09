/**
 * omnicode-profile-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 * 消费者只从 contract.ts 导入（profileBootstrap 例外，见 architecture-policy.yaml）。
 */
import { launchOmnicodeProfile } from "./contract.js";

export async function exampleOmnicodeProfileLaunch(profileId: string): Promise<number> {
  // 启动即幂等：运行中返回现有 pid；并发点击由单飞合并（spec §并发与竞态）。
  return launchOmnicodeProfile(profileId);
}

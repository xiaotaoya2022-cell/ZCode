/**
 * omnicode-profile-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 * 消费者只从 contract.ts 导入（profileBootstrap 例外，见 architecture-policy.yaml）。
 */
import { launchOmnicodeProfile } from "./contract.js";

export async function exampleOmnicodeProfileLaunch(profileId: string): Promise<number> {
  // 批次1 P1-4「启动=重启」：已运行实例先三段式优雅停再启动；并发点击由单飞合并，
  // 全局串行链屏障 = 上一实例启动确认完成（spec §并发与竞态 / 决策 D6）。
  return launchOmnicodeProfile(profileId);
}

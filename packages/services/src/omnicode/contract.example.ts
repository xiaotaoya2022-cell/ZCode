/**
 * omnicode-workspace-governance 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 * 消费者只从 contract.ts 导入。
 */
import { acquireWorkspaceLock } from "./contract.js";

export function exampleOmnicodeWorkspaceAcquire(workspacePath: string, profileId: string, pid: number): void {
  // 原子获取：wx（CREATE_NEW）保证并发判负；判负方从 owner 灰显（spec §并发与竞态）。
  const result = acquireWorkspaceLock(workspacePath, profileId, pid);
  if (!result.ok) {
    console.warn(`[omnicode] 工作区被实例 ${result.owner?.profileId} 占用`);
  }
}

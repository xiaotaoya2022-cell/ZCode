// [OmniCode] 丙1 远程聚合 R4——账号族快照（跨账号聚合名单事实源，spec:
// docs/omnicode/remote-aggregation.md §5/§7/§8-R4）。R3 的
// OmnicodeRemoteForwardHostDeps.listCrossAccountProfileIds 注入面在本模块落地：
// - 管理器（聚合宿主进程）以**自身账号族键**为参照，逐一比对在线实例的账号族键；
// - 键 = customerNumber（账号族唯一标识，批次3 看板同源读取链）优先，缺失回退 email；
// - **未知身份保守归类为同账号**（键缺失/凭据读失败/未登录）：保持 R3 缺省聚合行为
//   逐字不变（R3 缺省 = 名单恒空 = 全部按同账号聚合），不为开关误伤既有同账号聚合；
// - 事件驱动零轮询：实例回连（desktopProfileIpc onInstanceConnected）即刷新该实例的
//   账号族快照 + 装配时 seed 管理器自身键；其余时点名单读缓存（同步、零 IO）。
//
// 红线（实现即约束）：
// - 账号身份只取 customerNumber/email 两个非敏感展示字段进内存缓存；凭据明文/JWT/
//   deviceMid 永不读取进本模块、不落日志（accountData 快照读取链本身的裁剪由其
//   返回类型保证——identity 之外的字段不进本模块）；
// - 全部只读：读失败归 null（未知），绝不创建/覆盖/修复凭据文件；
// - 无常驻轮询无 timer：名单只在实例回连/装配两个事件时点刷新。
import {
  readOmnicodeAccountDataFromDataRoot,
  type OmnicodeAccountDataSnapshot,
} from "./accountData.js";
import { getOmnicodeConsoleDataBaseDir, getOmnicodeProfileDir, getOmnicodeProfileRecord } from "./profileRuntime.js";

/** 账号族键（内存缓存值）：customerNumber ?? email；两者皆缺 = null（未知身份）。 */
export type OmnicodeAccountFamilyKey = string | null;

/**
 * 账号族键解析（纯函数）：customerNumber 优先（账号族唯一标识），缺失回退 email；
 * trim 后非空才采纳。返回 null = 身份未知（调用方按同账号保守归类）。
 */
export function resolveOmnicodeAccountFamilyKey(
  snapshot: Pick<OmnicodeAccountDataSnapshot, "identity">,
): OmnicodeAccountFamilyKey {
  const identity = snapshot.identity;
  if (!identity) return null;
  const customerNumber = identity.customerNumber?.trim();
  if (customerNumber) return customerNumber;
  const email = identity.email?.trim();
  return email || null;
}

/** profileId → 账号族键缓存（仅 R4 跨账号名单比对用；值 = null 表示已知未知身份）。 */
const accountKeyByProfileId = new Map<string, OmnicodeAccountFamilyKey>();
let ownAccountKey: OmnicodeAccountFamilyKey | null = null;

/** 管理器（聚合宿主）自身账号族键 seed：控制台数据根读取链，读失败归 null（fail-open）。 */
export async function seedOmnicodeAccountFamilyOwnKey(): Promise<OmnicodeAccountFamilyKey> {
  try {
    const snapshot = await readOmnicodeAccountDataFromDataRoot(getOmnicodeConsoleDataBaseDir());
    ownAccountKey = resolveOmnicodeAccountFamilyKey(snapshot);
  } catch {
    ownAccountKey = null;
  }
  return ownAccountKey;
}

/**
 * 刷新单个实例的账号族快照（desktopProfileIpc onInstanceConnected 事件时点调用）。
 * 读失败/身份未知缓存 null（同账号保守归类）；不重试不轮询——实例凭据变化由下一次
 * 回连事件收敛。
 */
export async function refreshOmnicodeAccountFamilyForProfile(profileId: string): Promise<void> {
  try {
    const record = await getOmnicodeProfileRecord(profileId);
    const dataRoot = record?.dataBaseDirOverride?.trim() || getOmnicodeProfileDir(profileId);
    const snapshot = await readOmnicodeAccountDataFromDataRoot(dataRoot);
    accountKeyByProfileId.set(profileId, resolveOmnicodeAccountFamilyKey(snapshot));
  } catch {
    accountKeyByProfileId.set(profileId, null);
  }
}

/**
 * 跨账号 profileId 名单（remoteForwardHost deps 注入面；同步读缓存零 IO）。
 * 判定规则：双方账号族键齐备且不同 → 跨账号；任一侧未知 → 同账号（保守，保持 R3
 * 缺省聚合行为不变——未知身份不因开关装配被误剔除）。
 */
export function listOmnicodeCrossAccountProfileIds(): string[] {
  if (!ownAccountKey) return [];
  const cross: string[] = [];
  for (const [profileId, key] of accountKeyByProfileId) {
    if (key && key !== ownAccountKey) cross.push(profileId);
  }
  return cross.sort();
}

/** 测试复位：清空缓存（跨用例隔离）。 */
export function resetOmnicodeAccountFamilyForTest(): void {
  accountKeyByProfileId.clear();
  ownAccountKey = null;
}

/** 测试注入：直写缓存键（绕过凭据读取链，纯键值断言用）。 */
export function setOmnicodeAccountFamilyKeysForTest(input: {
  ownKey?: OmnicodeAccountFamilyKey;
  byProfileId?: Record<string, OmnicodeAccountFamilyKey>;
}): void {
  if (input.ownKey !== undefined) ownAccountKey = input.ownKey;
  for (const [profileId, key] of Object.entries(input.byProfileId ?? {})) {
    accountKeyByProfileId.set(profileId, key);
  }
}

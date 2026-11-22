// [OmniCode] 模式二 R2 预留：bridge-proxy 附加账号材料的 main↔Host 请求/应答契约
// （spec: docs/omnicode/multi-account-sessions.md §5）。R1.5 只定义协议类型与 main 侧
// 路由占位（缺省处理者回结构化失败应答，先例同款 shared-asset-fetch）；实接——管理器
// 用批次3 读取链解密其他 profile 的 credentials.json 并代理应答、实例内存短 TTL 缓存
// （不落盘不进日志）——属 R2。
//
// 传输形态约定：
// - 请求只带 accountId（与 omnicode-accounts/<id>.json 文件名同一形态约束，防串号）。
// - 应答 ok=true 时 dataBase64 = 解密后的账号材料 JSON（OmniCode 仓 services 侧
//   omnicodeAccountMaterialFileSchema 同构形状）的 UTF-8 base64；Host 侧按该 schema
//   二次校验（纵深防御），校验失败按材料缺失 fail-closed，绝不回落主账号材料。
// - 材料不落盘不进日志（spec §5 红线）；R1.5 的 local 来源不经本消息（Host 直读本地
//   文件，见 services omnicode/accountMaterialFile.ts）。
import { z } from "zod";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

/** host → main：请求某附加账号的凭据材料（bridge-proxy 来源；accountId 形态与本地账号库一致）。 */
export const omnicodeAccountMaterialRequestPayloadSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/u, "accountId 形态非法"),
  })
  .strict();
export type OmnicodeAccountMaterialRequestPayload = z.infer<
  typeof omnicodeAccountMaterialRequestPayloadSchema
>;

/** main → host 应答：ok=false（桥未连/管理器不可用/账号不存在/解密失败）时只带结构化错误。 */
export const omnicodeAccountMaterialResultPayloadSchema = z
  .object({
    ok: z.boolean(),
    /** 解密后的账号材料 JSON（omnicodeAccountMaterialFileSchema 同构形状）的 UTF-8 base64。 */
    dataBase64: z.string().max(1024 * 1024).optional(),
    error: z.string().max(200).optional(),
  })
  .strict();
export type OmnicodeAccountMaterialResultPayload = z.infer<
  typeof omnicodeAccountMaterialResultPayloadSchema
>;

// ─── [OmniCode] 模式二 R2：附加账号材料快照形状（唯一事实源） ───
// R1 把该 schema 定义在 services 侧 accountOverride.ts；R2 落地 bridge-proxy 来源后，
// main（管理器解密代理）与 Host（二次校验）都要按同一形状作答——下沉到本 shared 契约
// 文件（架构 policy omnicode-account-material-shared-shape 已准入的精确路径），services
// 侧经 accountOverride.ts 原名再导出（R1 公共面不变）。字段形状与官方
// OAuthAccountMaterial/OAuthStartPlanMaterial 结构兼容（读取侧按官方类型收口）。

const providerFamilyEnum = z.enum(["zai", "bigmodel"]);
const oauthAccountMaterialBaseShape = {
  family: providerFamilyEnum,
  loginProvider: z.string().min(1),
  zcodeUserId: z.string().min(1),
  sessionRevision: z.string().nullable(),
  accountIdentity: z.string().min(1),
  zcodeJwtToken: z.string().nullable(),
};

/** omnicode-accounts/<accountId>.json（或 bridge-proxy 应答 dataBase64）解密后的校验 schema。 */
export const omnicodeAccountMaterialFileSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/u, "accountId 形态非法"),
    family: providerFamilyEnum,
    selections: providerFamilyConnectionSelectionSettingsSchema,
    accountIdentity: z.string().min(1),
    startPlanMaterial: z.object(oauthAccountMaterialBaseShape).strict().nullable(),
    familyMaterial: z
      .object({ ...oauthAccountMaterialBaseShape, accessToken: z.string().min(1) })
      .strict()
      .nullable(),
    deviceMid: z.string().min(1).nullable(),
  })
  .strict();

/** 材料快照文件数据（schema 推断）。 */
export type OmnicodeAccountMaterialFileData = z.infer<typeof omnicodeAccountMaterialFileSchema>;

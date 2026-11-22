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

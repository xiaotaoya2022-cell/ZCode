// [OmniCode] 批次3 T5 / R1-P2-4：登录首屏可见 provider 过滤。自 WelcomeScreen 抽离为
// 独立纯函数模块（零 @/ 依赖、零组件依赖），供 desktop 工程测试直接导入覆盖——ui 包
// 无独立 vitest 工程，desktop 测试存在相对导入 ui 源码的既有先例
//（omnicodeReviewWorkspaceLock.test.ts 导入 ui/src/store/tabStore.js）。flavor 为编译期
// 常量字符串（ZCODE_PRODUCT_FLAVOR），由调用方显式传入以保持纯函数可测（与
// shared/omnicodeAuth.ts 的注释约定一致）。
import {
  type OAuthProviderMeta,
  type ZCodeProductFlavor,
  BIGMODEL_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  ZCODE_PRODUCT_FLAVOR,
} from "@zcode/shared";

function getProviderPriority(provider: OAuthProviderMeta): number {
  switch (provider.id) {
    // 保持内置 provider 的稳定顺序；登录入口固定取 Z.ai，其余 provider 只服务于显式连接请求。
    case ZAI_PROVIDER_ID:
      return 0;
    case BIGMODEL_PROVIDER_ID:
      return 1;
    default:
      return 10 + provider.order;
  }
}

export function resolveVisibleLoginProviders(
  providers: OAuthProviderMeta[],
  options?: { flavor?: ZCodeProductFlavor },
): OAuthProviderMeta[] {
  // [OmniCode] 批次3 T5：omnicode flavor 的登录首屏隐藏 zai_cn。官方凭据库**故意**排除
  // zai_cn 会话（oauthCredentialRepo.materialFromSnapshot："中国区 OAuth 不能被当成全球区
  // 业务凭据"，direct = loginProvider === family 对 zai_cn 永不成立，loadOAuthFamilyTokenSet
  // 同样只认 zai/bigmodel）——zai_cn 登录"成功"却拿不到 zai 家族材料，表现为额度显示为空、
  // agent 请求报 Account request credential is unavailable。登录按钮列表与"连接 Z.ai 继续使用"
  // 几乎无法区分，是用户必踩的坑，故首屏不展示。provider adapter 与设置页显式连接入口保留
  //（linkedBigModel 账号关联依赖 zai_cn 的上游授权）。官方 flavor 渲染零改动（硬红线）。
  const visible =
    (options?.flavor ?? ZCODE_PRODUCT_FLAVOR) === "omnicode"
      ? providers.filter((provider) => provider.id !== ZAI_CN_PROVIDER_ID)
      : providers;
  // 保持 Z.ai 在前、BigModel 在后的稳定顺序。
  return [...visible].sort((left, right) => {
    return getProviderPriority(left) - getProviderPriority(right);
  });
}

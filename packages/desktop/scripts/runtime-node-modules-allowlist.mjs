// 桌面安装包 app.asar 的 node_modules 白名单（打包瘦身 2026-11-21）。
//
// 背景：electron-builder 按生产依赖图收包时，会把 @zcode/ui 等构建期 workspace 包的全部
// 生产传递依赖（echarts/mermaid/pdfjs-dist/lottie-web/@extend-ai/shiki/cytoscape 等约
// 770 个包、~244 MiB 未压缩）也复制进 app.asar。这些包只被 vite 打进 out/renderer 的
// 产物 bundle 引用（产物自含全部实现与 worker/字体/wasm 资源），主进程 / host /
// preload / extension-host / scheduler 运行时从不加载它们，纯属重复体积。
//
// 证据链（3.18.2-omni.1 win-x64 产物 app.asar 逐包对账 + 构建产物全量扫描）：
// 1. out/main|host|preload|extension-host|scheduler|remote-main|renderer-services 的
//    静态 import、动态 import()、字面 require()、require.resolve 全部枚举完毕，得到
//    下面 RUNTIME_MODULE_ROOTS 的来源清单；
// 2. vite 渲染层产物（out/renderer）不引用 node_modules（浏览器上下文无 require，
//    shiki 语言包/katex 字体/pdf worker 等均已以 asset 形式打进产物）；
// 3. resources/glm 的 agent bundle 自带独立 node_modules，不解析 app.asar 内的包。
//
// 兜底与门禁：electron-builder.config.js 的 files 用本模块生成的白名单裁剪 node_modules；
// afterPack 的 injectHoistedRuntimeModulesIntoAsar 按同一根集合的闭包补齐缺失包；
// bundle.mjs 最终按同一闭包机械校验，漏包在打包阶段直接失败而不是安装后启动崩溃。
//
// 维护约定：新增运行时外置依赖时，把包名加进 RUNTIME_MODULE_ROOTS（附引用证据注释）；
// 白名单由闭包推导自动跟随，不需要手改 electron-builder files。

import { collectRuntimeModuleClosure } from "./runtime-dependency-closure.mjs";
import { isPrunedNativeVariantModule } from "./desktop-native-package-policy.mjs";

// app.asar 必须携带的运行时模块闭包根。以下每一项都有明确的运行时解析证据：
// —— 优先级：宁多勿漏。闭包展开（dependencies/optionalDependencies 递归）由
//    collectRuntimeModuleClosure 完成；peerDependencies 不在闭包内，需要显式列出。
export const RUNTIME_MODULE_ROOTS = [
  // out/* 构建产物静态 import 的第三方包（2026-11-21 对 out/main|host|preload|
  // extension-host|scheduler|remote-main|renderer-services 全量 `from"..."` 扫描）：
  "@arms/rum-electron",
  "@opentelemetry/api",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "electron-updater",
  "node-forge",
  "pkijs",
  "semver",
  "ssh2",
  "undici",
  "ws",
  "yaml",
  "yauzl",
  "yazl",
  // out/* 构建产物动态 import() 的外置包（同一次扫描）：
  "@larksuiteoapi/node-sdk",
  "@napi-rs/keyring",
  "node-pty",
  // out/* 构建产物字面 require() / require.resolve 的包（esbuild 无法内联的 CJS 子路径）：
  // - extension-host 的 ajv 校验运行时 require("ajv/dist/runtime/*") 与
  //   require("ajv-formats/dist/formats")，因此 ajv + ajv-formats 必须随包；
  "ajv",
  "ajv-formats",
  // - src/main/editors.ts 的 .icns 图标导出在运行时 require("@fiahfy/icns")。
  "@fiahfy/icns",
  // - src/main/browserView/playwrightInjectedScriptSource.ts 在运行时
  //   require.resolve("playwright-core/package.json") 定位注入脚本资源。
  "playwright-core",
  // —— 以下是 afterPack 历史注入名单的原始条目（bugfix 证据保留）：
  // Bugfix: telemetry 的 OTLP exporter 会在启动阶段加载 sdk-metrics。pnpm 开发态可从
  // workspace 根目录解析，但 electron-builder 不会稳定复制这条 hoisted 依赖，导致安装包启动即崩溃。
  // 将 sdk-metrics 作为闭包根注入，同时递归带齐它的 OpenTelemetry 运行时依赖。
  // （@opentelemetry/sdk-metrics 已在上面按静态 import 证据列出）
  // Bugfix：主进程的本地 TTFT / renderer 动作追踪导出器使用 OTLP proto 导出链。pnpm hoisted 布局下
  // electron-builder 会把 otlp-transformer 打进 app.asar，却漏拷其传递依赖 protobufjs，已安装应用启动即报
  // Cannot find module protobufjs/minimal（开源侧 3.14.0 arm64 DMG 实测复现）。以两个 proto exporter
  // 作为闭包根注入，递归带齐 otlp-transformer、protobufjs 与 @protobufjs/* 全链。
  // （exporter-*-otlp-proto 已在上面按静态 import 证据列出）
  // pngjs：@fiahfy/icns 的依赖；require-in-the-middle 遥测链也曾漏过它。
  "pngjs",
  // Bugfix: @arms/rum-core 把 @babel/runtime 声明成 peerDependency，pnpm 安装时可由 peer 解析兜住，
  // 但 electron-builder 重打 app.asar 时不会因为 @arms/rum-electron 本体进包，就稳定把这个 peer 运行时一起带上。
  // 线上已出现安装包启动即报 Cannot find module '@babel/runtime/helpers/interopRequireDefault'，
  // 这里显式把 @babel/runtime 作为闭包根注入，确保 ARMS 主进程埋点链路在生产包内可解析。
  "@babel/runtime",
  // services 里的代理连通性探测会动态 require("undici") 取 ProxyAgent。（undici 同时是
  // tsup 外置包，上面已按静态 import 证据列出。）
  // node-forge 一直只写在 bundle.mjs 的校验名单里……已在上面按静态 import 证据列出。
  // Main 静态依赖 PKIjs；收集其完整闭包并校验产物，避免 pnpm 去重后漏包。（pkijs 已列出）
  // 2.7.0 起 services 新增反馈日志压缩链路并引入 yazl；2.6.0 没有这条启动期依赖，
  // pnpm hoisted 布局下 yazl 可能进了 app.asar，但子依赖 buffer-crc32 没有稳定随包进入产物；
  // 这里显式以 yazl 作为闭包根注入，让递归依赖收集把 ZIP 打包链路所需依赖一起补齐。
  // （yazl 已在上面按静态 import 证据列出）
  // yauzl 成为 desktop/services 的直接生产依赖后，pnpm list --prod 会把顶层 yauzl 节点
  // 去重成没有子依赖的空节点；electron-builder 的 pnpm collector 以先登记的空节点为准，
  // 跳过后面带完整子树的那个，于是 app.asar 里有 yauzl 却没有它的运行时依赖 pend，
  // 要到 bundle 校验阶段才报「缺少运行时依赖 pend」。（yauzl 已在上面按静态 import 证据列出）
  // Bugfix: 飞书 SDK 被 desktop main/host 外置后，安装包运行时必须能从 app.asar 解析到它。
  // 这里显式注入 scoped 包，避免开发态正常、生产包启动时才报 Cannot find module。
  // （@larksuiteoapi/node-sdk 已在上面按动态 import 证据列出）
  // 生产态里 ssh2 虽然被打进 app.asar，但它的依赖链偶发被 electron-builder 漏拷。
  // 已出现线上报错 Cannot find module 'asn1'（Require stack: ssh2 keyParser）。
  // 这里把 ssh2 关键依赖链一起注入，避免远程 SSH 连接在已安装应用里因缺包直接失败。
  // （ssh2 已在上面按静态 import 证据列出；asn1/bcrypt-pbkdf/tweetnacl 由 ssh2 闭包展开）
  // 26.17.0 的 pnpm collector 仍可能漏掉 deduped 传递依赖。以 updater 入口展开完整闭包，
  // 与现有 afterPack 补齐和最终产物校验共同阻止安装后才暴露 MODULE_NOT_FOUND。
  // （electron-updater 已在上面按静态 import 证据列出）
  // electron-updater → builder-util-runtime → debug 运行时 require("ms")。
  // pnpm hoisted 布局下 electron-builder 偶发漏拷这个叶子依赖；3.4.0(ci/cua-v0.3.17 打的)
  // 已在线上触发安装包启动即报 Cannot find module 'ms'（Require stack: debug/src/common.js），
  // 自动更新链路直接崩。ms 是叶子包，显式注入即可让 debug 在 app.asar 内稳定解析。
  // （ms 由 electron-updater → debug 闭包展开，这里保留为显式根以固化历史 bugfix 语义）
  "ms",
  // require-in-the-middle（OpenTelemetry 插桩）运行时按模块名查 package.json，
  // module-details-from-path 是它的运行时依赖，曾因漏包导致遥测初始化失败。
  "module-details-from-path",
  // Bugfix: @opentelemetry/api-logs 是 sdk-logs 日志导出链的 API 边界，
  // pnpm hoisted 布局下曾被 collector 漏拷导致安装包启动即崩。
  // （同时由 sdk-metrics/sdk-logs 闭包展开，保留为显式根固化历史语义）
  "@opentelemetry/api-logs",
];

// 生成 electron-builder files 的 node_modules 白名单 include 模式。
// 每个闭包成员映射为 `node_modules/<name>/**`；pnpm hoisted 布局下 electron-builder
// 会把包平铺进 asar 顶层 node_modules，模式与产物布局一一对应。
// targetPlatformKey 给定时（构建实测修复 2026-11-21）：闭包经 optionalDependencies 展开
// 会带上 @napi-rs/keyring 的全部平台变体，这里按 native 裁剪口径直接从 include 里剔除
// 非目标变体——与 afterPack 注入 / bundle 校验共用 isPrunedNativeVariantModule 同一判定，
// 避免"files 裁掉→afterPack 注回"的自相矛盾。
export function buildRuntimeNodeModulesIncludePatterns(moduleLookupRoots, targetPlatformKey) {
  const closureModuleNames = collectRuntimeModuleClosure(
    RUNTIME_MODULE_ROOTS,
    moduleLookupRoots,
  );
  const filteredModuleNames = targetPlatformKey
    ? closureModuleNames.filter(
        (moduleName) => !isPrunedNativeVariantModule(moduleName, targetPlatformKey),
      )
    : closureModuleNames;
  return filteredModuleNames.map((moduleName) => `node_modules/${moduleName}/**`);
}

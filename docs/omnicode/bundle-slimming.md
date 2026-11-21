# 安装包瘦身（bundle-slimming）

- 范围：桌面安装包（win-x64 主验收；机制全平台共享）
- 基线：`OmniCode-3.18.2-omni.1-win-x64.exe` = **202,233,130 字节（192.8 MiB）**，win-unpacked 未压缩 834,655,946 字节
- 目标：不破坏任何功能前提下实质性缩减（<150 MiB 为期望值，不硬凑）
- 日期：2026-11-21；起点 HEAD `a2b8d604`（v3.18.2-omni.1）
- 原则：证据先行、逐项记账；omnicode 依赖资源零触碰；共用资源改动必须论证官方同样受益且无引用破坏；不引新依赖、不改发版流程

## 一、成分表（3.18.2-omni.1 win-unpacked 解剖）

win-unpacked 总计 834.7 MiB：

| 成分 | 字节数 | 占比 | 判定 | 处置 |
| --- | --- | --- | --- | --- |
| resources/app.asar | 383.0 MB | 45.9% | **可瘦**：node_modules 297.9 MB 中 ~244 MB 为 renderer 构建期依赖的重复拷贝 | A1 白名单 |
| Electron 运行时（exe + DLL/pak/icu 等） | ~336 MB | 40.2% | 必需（Electron 44.7.0 固定） | 不动 |
| resources/glm（agent bundle） | 74.5 MB | 8.9% | 必需（omnicode 依赖；无 .map；字体为 CJK 渲染所需） | 不动 |
| resources/licenses/electron + 根 LICENSES.chromium.html（双份） | 41.0 MB | 4.9% | 必需（法律合规；electronBuilderSecurity.test.ts 锁定的跨平台暂存契约） | 不动（C3 记录） |
| resources/tools（ripgrep/bfs/ugrep） | 8.8 MB | 1.1% | 必需 | 不动 |
| resources/app.asar.unpacked（node-pty prebuild/keyring） | 7.1 MB | 0.8% | 必需 | 不动 |
| resources/THIRD-PARTY-NOTICES.md | 3.5 MB | 0.4% | 必需 | 不动 |
| dxcompiler.dll | 25.7 MB | — | 必需（内嵌浏览器可触发 WebGPU） | 不动（C4 记录） |
| locales/（Chromium 语言包） | 1.2 MB | 0.1% | 与 UI locales 对齐后 +~0.9 MB | B1 |

### app.asar 内部（383 MB）

- out/renderer 50.3 MiB（vite 自含产物：shiki 语言包/katex 字体/pdf worker/wasm 均已打进 assets）
- node_modules 297.9 MiB（882 包）
- out/preload 5.3 + out/host 3.4 + out/main 2.3 + out/plugin-sandbox 2.2 + out/extension-host 1.4 + out/scheduler 1.1 + 其余 <3

### node_modules Top10（重复拷贝大头，全为 renderer 构建期依赖）

| 包 | MiB | 运行时引用证据 |
| --- | --- | --- |
| echarts | 23.8 | 仅 out/renderer 产物；主进程零引用 |
| mermaid | 21.2 | 同上 |
| pdfjs-dist | 16.0 | 同上（worker 已打进 renderer assets） |
| @extend-ai(react-xlsx/docx) | 15.3 | 同上 |
| lottie-web | 14.2 | 同上 |
| @shikijs(langs/themes) | 10.0 | 同上（语言包以 chunk 形式在 renderer assets） |
| @larksuiteoapi/node-sdk | 9.2 | **运行时保留**（host 动态 import 外置） |
| cytoscape-fcose | 8.9 | 仅 renderer |
| playwright-core | 8.3 | **运行时保留**（main require.resolve 注入脚本） |
| world-atlas | 7.8 | 仅 renderer |

## 二、判定方法论（证据链）

1. 对构建产物 `out/main|host|preload|extension-host|scheduler|remote-main|renderer-services`
   全量枚举四类外部解析：静态 `from"..."`、动态 `import("...")`、字面 `require("...")`、
   `require.resolve(...)`。结论：运行时外置依赖 = `@arms/rum-electron`、`@opentelemetry/*`（5 个静态入口）、
   `electron-updater`、`node-forge`、`pkijs`、`semver`、`ssh2`、`undici`、`ws`、`yaml`、`yauzl`、`yazl`、
   `@larksuiteoapi/node-sdk`、`@napi-rs/keyring`、`node-pty`、`ajv`、`ajv-formats`、`@fiahfy/icns`、
   `playwright-core` + afterPack 历史注入名单（pngjs/@babel/runtime/ms/module-details-from-path 等）。
2. vite 渲染产物不引用 node_modules（浏览器上下文无 require；shiki/katex/pdf/mermaid/echarts 全部已在
   out/renderer/assets 里以 chunk/asset 形式存在）。
3. resources/glm 的 agent bundle 自带独立 node_modules，不解析 app.asar 内的包。
4. extension-host 插件加载解析的是插件自带 dist（resources/glm/packages/*），不引用 app node_modules。
5. 依赖闭包用 `scripts/runtime-dependency-closure.mjs` 从上述根集合递归展开（dependencies +
   optionalDependencies），得 140 包/54 MiB 的"必需集"。

## 三、逐项处置台账

| # | 处置 | 改动 | 收益（未压缩） | 状态 |
| --- | --- | --- | --- | --- |
| A1 | node_modules 运行时白名单 | 新增 `packages/desktop/scripts/runtime-node-modules-allowlist.mjs`（RUNTIME_MODULE_ROOTS + 闭包推导 include 模式）；`electron-builder.config.js` files 改为 `!node_modules/**` + 闭包 include + 裁剪规则整体后置（后序模式优先）；`bundle.mjs` 校验名单改为同源 RUNTIME_MODULE_ROOTS | ~-244 MB（882→140 包） | ✅ 保留（实测见 §五） |
| A2 | 白名单机械回归门 | 新增 `test/runtimeNodeModulesAllowlist.test.ts`（含运行时哨兵必在、renderer 大包必不在两类断言），登记 `scripts/engineering-test-files.json` | 门禁 | ✅ 保留 |
| B1 | Chromium locales 与 UI locales 对齐 | win/linux `electronLanguages` 增 ja-JP/ko-KR/ru-RU；mac `MAC_ELECTRON_LANGUAGES` 增 ja/ko/ru（`assertPackagedMacElectronLocales` 硬失败防静默删包）；同步更新 `electronBuilderLanguages.test.ts` / `macElectronLocales.test.ts` | +~0.9 MB，换取 ja/ko/ru 用户 Chromium 内建 UI 不再回落英文 | ✅ 保留（官方 flavor 同样受益：语言名写错会构建期硬失败，无引用破坏） |
| C1 | tsbuildinfo 不入包 | `PACKAGING_PRUNE_PATTERNS` 增 `!**/*.tsbuildinfo` | ~-0.5 MB | ✅ 保留 |
| C2 | out/e2e 不入包 | — | 0.63 MB | ❌ 不采纳：e2e 工作流可能经 dev out/ 引用，收益/风险比不划算 |
| C3 | LICENSES.chromium.html 双份去重（root + resources/licenses/electron） | — | 未压缩 20.5 MB（NSIS 后约 -5 MB） | ❌ 不采纳：跨平台许可暂存契约有单测锁定（Windows afterExtract 用例），法律合规路径不动 |
| C4 | dxcompiler.dll 裁剪 | — | 25.7 MB | ❌ 不采纳：内嵌浏览器可加载 WebGPU，删除会在真实使用中坏 |
| C5 | mermaid/echarts 等 dist 多变体裁剪（node_modules 内） | — | — | ❌ 不需要：A1 白名单后这些包已整体不入包 |
| C6 | @larksuiteoapi/node-sdk es/ 目录（4.57 MB ESM 重复变体） | — | 4.57 MB | ❌ 不采纳：动态 import 的解析路径依赖 package.json main（lib/），es/ 为构建工具 module 解析备用入口，跨平台风险大于收益 |

### 白名单安全性设计（A1）

- **同源三处**：`RUNTIME_MODULE_ROOTS` 同时驱动 (1) files include 模式生成、(2) afterPack
  `injectHoistedRuntimeModulesIntoAsar` 缺失注入、(3) `bundle.mjs` 最终产物闭包校验。漏包在打包阶段
  直接失败，而不是安装后启动崩溃。
- **peerDependencies 显式化**：闭包推导只递归 dependencies/optionalDependencies；
  `@babel/runtime`（@arms/rum-core 的 peer）保留为显式根。
- **规则顺序**：`!node_modules/**` → 闭包 include → 通用裁剪（.map/README/tsbuildinfo）→ 平台 native
  裁剪（keyring 其它平台/canvas）。后序模式优先，`electronBuilderSecurity.test.ts` 断言顺序不变量。
- **有意保留的"看似可删"项**：rrweb 链（@arms/rum-browser 运行时动态加载 replay）、playwright-core
  整包、@napi-rs/keyring 全平台变体（由 native 裁剪规则处理）、cpu-features/nan（历史裁剪规则处理，
  ssh2 自动降级）。

## 四、门禁

| 门禁 | 结果 |
| --- | --- |
| pnpm typecheck | exit 0 |
| pnpm architecture:check --changed | violations 0 |
| pnpm lint | 551 warnings = 基线零新增 |
| npx vitest run omnicode | 22 文件 343/343 全绿（含白名单回归门） |
| npx vitest run 全套 | 14 失败 ⊆ 基线 15 同名单（windowsInstallerPreserveFiles 因本批打包规则变化转绿） |
| pnpm verify:pre-push | 全绿（618 passed；architecture-upstream-admission 首跑 EBUSY 为 Windows 临时目录清理抖动，单跑 12 过 0 挂） |
| 双步构建（CLI + desktop bundle） | BUILD_OK（首跑 native 边界校验挂→根因修复后复跑通过，见 §七） |

## 五、收益（构建后回填）

| 指标 | 前 | 后 | Δ |
| --- | --- | --- | --- |
| 安装包字节数 | 202,233,130（192.8 MiB） | **156,642,995（149.4 MiB）** | **-45,590,135（-22.5%）** |
| win-unpacked 未压缩 | 834,655,946 | 575,795,394 | -258,860,552（-31.0%） |
| app.asar | 382,767,860 | 122,360,001 | -260,407,859（-68.0%） |
| asar 内 node_modules | 297.9 MB / 882 包 | ~38 MB / 133 包 | -244 MB / -749 包 |

产物哨兵核验（@electron/asar 逐包清点）：16 个运行时哨兵（@arms/rum-electron/ssh2/node-pty/
@napi-rs/keyring(+win32-x64-msvc)/ajv/playwright-core/@larksuiteoapi/node-sdk/ws/
electron-updater/yauzl/yaml/undici/semver/node-forge/pkijs）全部 IN；
echarts/mermaid/pdfjs-dist/lottie-web/world-atlas/非目标平台 keyring 变体/canvas 全部 absent。

## 六、遗留与后续

- ~~并行工作树风险~~：复跑构建已由主控终态代码（f14b6fe1 + 7578f21b 审计修复轮）完成，无并行写入。
- NSIS 差分更新：本轮体积骤降导致老用户升级走全量下载（blockmap 差分跨大版本失效），一次性成本。
- 后续候选（本轮不实施）：dmg sizeLimit 可随瘦身后下调；licenses 双份、dxcompiler、es/ 变体等已记录取舍理由。

## 七、构建实测与根因修复（2026-11-21 审计会话）

- **首跑 BUILD_FAILED**：desktop-native-package-policy 边界校验挂——@napi-rs/keyring 非目标平台
  变体混入 app.asar。根因：闭包推导递归 optionalDependencies 把 keyring 全平台变体展开进白名单；
  files 层虽被 native 裁剪规则裁掉，但 **afterPack 补缺注入按同一闭包工作，把已裁变体重新注回**，
  bundle.mjs 最终校验同口径要求它们在包里——三处口径互相矛盾。
- **修复**：desktop-native-package-policy.mjs 新增 `isPrunedNativeVariantModule(moduleName,
  targetPlatformKey)` 模块名级判定（keyring 非目标变体/canvas 族/@lydell/node-pty 源包/@img/sharp
  非目标变体），include 生成（buildRuntimeNodeModulesIncludePatterns 第二参）、afterPack 注入
  （resolveMissingRuntimeModules）、bundle 校验三处同源应用——files 裁剪、注入、校验从此同一平台口径。
- **复跑 BUILD_OK**（OmniCode-3.18.2-omni.1-win-x64.exe = 156,642,995 B）；回归门测试 +2
  （目标平台保留/非目标剔除 + 判定矩阵）。

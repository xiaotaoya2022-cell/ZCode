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

（回填：typecheck / architecture / lint / vitest 15 基线 / verify:pre-push / 构建 exit code）

## 五、收益（构建后回填）

| 指标 | 前 | 后 | Δ |
| --- | --- | --- | --- |
| 安装包字节数 | 202,233,130 | （回填） | （回填） |
| win-unpacked 未压缩 | 834,655,946 | （回填） | （回填） |
| app.asar | 382,767,860 | （回填） | （回填） |
| asar 内 node_modules | 297.9 MB/882 包 | （回填） | （回填） |

## 六、遗留与后续

- 并行工作树风险：本次打包期间工作树出现另一进程的 D12 接管流半成品（详见 progress 文件），
  打包结果包含其已落盘代码；正式发布前应以主控终态代码重跑一次打包验证。
- NSIS 差分更新：本轮体积骤降导致老用户升级走全量下载（blockmap 差分跨大版本失效），一次性成本。
- 后续候选（本轮不实施）：electronLanguages 与 UI locales 已对齐；dmg size 可随瘦身后下调；
  licenses 双份、dxcompiler、es/ 变体等已记录取舍理由。

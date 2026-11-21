import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildRuntimeNodeModulesIncludePatterns, RUNTIME_MODULE_ROOTS } from "../scripts/runtime-node-modules-allowlist.mjs";

// 打包瘦身（2026-11-21）白名单的机械回归门：
// - 运行时闭包根里的每个包都必须生成 include 模式（漏掉会在打包阶段静默丢运行时依赖）；
// - 已核实为 renderer 专属/构建期的代表性大包绝不能出现在白名单里（出现即说明闭包
//   推导被误改，安装包会重新膨胀 ~244MB 未压缩体积）。
describe("runtime node_modules allowlist", () => {
  const patterns = buildRuntimeNodeModulesIncludePatterns([
    process.cwd(),
    resolve(process.cwd(), "../.."),
  ]);

  it("闭包根集合非空且全部生成 include 模式", () => {
    expect(RUNTIME_MODULE_ROOTS.length).toBeGreaterThan(20);
    expect(patterns.length).toBeGreaterThan(100);
    for (const root of ["@arms/rum-electron", "ssh2", "node-pty", "@napi-rs/keyring", "ajv", "ajv-formats", "@larksuiteoapi/node-sdk", "playwright-core", "@fiahfy/icns", "yaml", "ws", "semver", "undici", "electron-updater"]) {
      expect(patterns).toContain(`node_modules/${root}/**`);
    }
  });

  it("闭包根直接依赖必须随包（@babel/runtime peer 语义）", () => {
    expect(patterns).toContain("node_modules/@babel/runtime/**");
    expect(patterns).toContain("node_modules/asn1/**");
    expect(patterns).toContain("node_modules/bcrypt-pbkdf/**");
    expect(patterns).toContain("node_modules/tweetnacl/**");
    expect(patterns).toContain("node_modules/pngjs/**");
    expect(patterns).toContain("node_modules/ms/**");
    expect(patterns).toContain("node_modules/module-details-from-path/**");
  });

  it("renderer 专属/构建期大包不得进入白名单", () => {
    for (const rendererOnly of [
      "echarts",
      "mermaid",
      "pdfjs-dist",
      "lottie-web",
      "@extend-ai/react-xlsx",
      "@shikijs/langs",
      "cytoscape",
      "cytoscape-fcose",
      "world-atlas",
      "lucide-react",
      "highlight.js",
      "katex",
      "react",
      "react-dom",
      "shadcn",
      "ts-morph",
    ]) {
      expect(patterns).not.toContain(`node_modules/${rendererOnly}/**`);
    }
    // scoped 目录也不能整段包含
    expect(patterns).not.toContain("node_modules/@zcode/**");
  });
});

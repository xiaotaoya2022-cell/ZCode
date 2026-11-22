// [OmniCode] 去遥测构建桩（docs/omnicode/de-telemetry.md；构建打包审计 B 域 2026-11-22）。
//
// 背景：OMNICODE_TELEMETRY_DISABLED 在 packages/shared/src/env.ts 恒为 true（魔改版
// 永不启用 ARMS RUM / OTel 上报），但 @arms/rum-electron 与 @opentelemetry 主链仍是
// main/index.js 的静态外部导入：init 虽然 enable=false 不产生上报，整链（含
// sdk-metrics / OTLP exporters / protobufjs / axios / web-vitals，合计约 9.9MB 未压缩）
// 照样在 app ready 之前加载解析，拖慢主进程启动。
//
// 机制：tsup.config.ts 在该常量为 true 时，把以下说明符的构建期解析重定向到本模块——
//   @arms/rum-electron（main 图内 9 处静态默认导入）
//   @opentelemetry/api | resources | sdk-metrics
//   @opentelemetry/exporter-metrics-otlp-proto | exporter-trace-otlp-proto
// （@opentelemetry/sdk-trace-base 只有 type 导入，编译期擦除，无需重定向。）
// API 面逐项来自全仓 grep：init / client.useReporter / sendCustom / sendEvent /
// setConfig / getConfig、SpanKind / SpanStatusCode / TraceFlags、resourceFromAttributes、
// MeterProvider / PeriodicExportingMetricReader / OTLPMetricExporter / OTLPTraceExporter、
// AggregationTemporality / AggregationType / InstrumentType；枚举值与官方包逐字一致。
//
// 语义边界：
// - 上游/官方世界（常量为 false）不挂重定向插件，构建产物与官方逐字一致；@arms 在
//   runtime-node-modules-allowlist 的白名单不动（同一 files 机制，供官方世界解析）。
// - 桩把 SDK 调用收口为 no-op：与 enable=false 的真实 SDK 行为一致（本就不产生上报），
//   唯一可观察差异是不再解析/持有遥测依赖模块本身。
// - localTtft / renderer-action 的 OTLP 导出依赖 OTEL_EXPORTER_OTLP_* 环境变量；桩下
//   exporter 构造为惰性 no-op（本地自托管 OTEL 导出在魔改版不生效，与去遥测政策一致）。
// - vitest/单测不经过该重定向（vitest.config.ts 已把 @arms/rum-electron 别名到
//   packages/desktop/test/mocks/armsRumElectronStub.ts），本模块只在 tsup 构建产物中生效。

type ArmsRumStubConfig = Record<string, unknown>;

const noop = (): void => {};

let lastInitConfig: ArmsRumStubConfig | undefined;

// @arms/rum-electron 默认导出的 no-op 桩。init 同步捕获 config 供 getConfig 读取，
// 与真实 SDK「init 落盘 config」的可观察语义一致（databaseStartupTelemetry 的
// getConfig().env 判定保持同值）。
const armsRumStub = {
  init: (config?: ArmsRumStubConfig) => {
    lastInitConfig = config;
    return Promise.resolve();
  },
  client: {
    useReporter: noop,
  },
  sendCustom: noop,
  sendEvent: noop,
  setConfig: noop,
  getConfig: (): ArmsRumStubConfig => lastInitConfig ?? {},
};

export default armsRumStub;

// —— @opentelemetry/api 桩（枚举值与官方包逐字一致）——
export const SpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const;

export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export const TraceFlags = {
  NONE: 0,
  SAMPLED: 1,
} as const;

// —— @opentelemetry/resources 桩 ——
// 返回值仅作为 ReadableSpan.resource / MeterProvider 构造参数的透传数据，
// 桩链路内不存在真正读取 attributes 的消费者。
export function resourceFromAttributes(attributes: Record<string, unknown>): {
  attributes: Record<string, unknown>;
} {
  return { attributes };
}

// —— @opentelemetry/sdk-metrics 桩 ——
export const AggregationTemporality = {
  DELTA: 0,
  CUMULATIVE: 1,
} as const;

export const AggregationType = {
  DEFAULT: 0,
  DROP: 1,
  SUM: 2,
  LAST_VALUE: 3,
  EXPLICIT_BUCKET_HISTOGRAM: 4,
  EXPONENTIAL_HISTOGRAM: 5,
} as const;

export const InstrumentType = {
  COUNTER: "COUNTER",
  GAUGE: "GAUGE",
  HISTOGRAM: "HISTOGRAM",
  UP_DOWN_COUNTER: "UP_DOWN_COUNTER",
  OBSERVABLE_COUNTER: "OBSERVABLE_COUNTER",
  OBSERVABLE_GAUGE: "OBSERVABLE_GAUGE",
  OBSERVABLE_UP_DOWN_COUNTER: "OBSERVABLE_UP_DOWN_COUNTER",
} as const;

// 仪表桩：add/record 收口为 no-op（与 enable=false 的真实链路一致——指标只进内存、
// 永不出网，no-op 连内存都省了）。
const stubMetricInstrument = {
  add: noop,
  record: noop,
};

const stubMeter = {
  createCounter: () => stubMetricInstrument,
  createGauge: () => stubMetricInstrument,
  createHistogram: () => stubMetricInstrument,
  createUpDownCounter: () => stubMetricInstrument,
};

export class MeterProvider {
  constructor(_options?: unknown) {}

  getMeter(): typeof stubMeter {
    return stubMeter;
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export class PeriodicExportingMetricReader {
  constructor(_options?: unknown) {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// —— OTLP exporter 桩 ——
// SpanExporter 语义：export 立即回 SUCCESS（code 0），调用方（rendererActionTraceBroker
// / localTtftExporter）按「发送成功」继续走去重/清队，不重试不告警。
export class OTLPMetricExporter {
  constructor(_options?: unknown) {}
}

export class OTLPTraceExporter {
  constructor(_options?: unknown) {}

  export(_spans: unknown, resultCallback: (result: { code: number }) => void): void {
    resultCallback({ code: 0 });
  }

  shutdown(): Promise<{ code: number }> {
    return Promise.resolve({ code: 0 });
  }

  forceFlush(): Promise<{ code: number }> {
    return Promise.resolve({ code: 0 });
  }
}

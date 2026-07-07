import { readFileSync, existsSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

// ---------- 子结构 ----------
const filterValue = z.object({
  label: z.string(),
  option: z.string().optional(),          // select：目标选项文本
  options: z.array(z.string()).optional(),// multiselect
  clickSelector: z.string().optional(),   // daterange/radio 等按钮式
  text: z.string().optional(),            // input 填入值
  steps: z.array(z.record(z.unknown())).optional(), // custom：交互 DSL 步骤
});

const filterDef = z.object({
  key: z.string(),
  name: z.string().default(''),
  type: z.enum(['select', 'multiselect', 'daterange', 'radio', 'input', 'cascader', 'custom']),
  selector: z.string().optional(),
  default: z.string(),
  discover: z.boolean().default(false),
  values: z.array(filterValue).default([]),
});

const metricDef = z.object({
  id: z.string(),
  name: z.string().default(''),
  type: z.enum(['dom-text', 'echarts', 'tooltip-sweep', 'api-field', 'vl-read']),
  selector: z.string().optional(),
  all: z.boolean().default(false),
  chart: z.string().optional(),
  pick: z.string().optional(),
  points: z.number().int().positive().optional(),
  request: z.string().optional(),
  path: z.string().optional(),
  region: z.string().optional(),          // vl-read：截图区域选择器
  question: z.string().optional(),        // vl-read：读数问题
  normalize: z.array(z.string()).default([]),
  toleranceAbs: z.number().optional(),
  toleranceRelPct: z.number().optional(),
});

const stepDef = z.object({ do: z.string() }).passthrough();

const interactionDef = z.object({
  id: z.string(),
  name: z.string().default(''),
  steps: z.array(stepDef).min(1),
  extraMetrics: z.array(metricDef).default([]),
});

const constraintDef = z.union([
  z.object({ exclude: z.record(z.string()) }),
  z.object({ when: z.record(z.string()), then: z.record(z.array(z.string())) }),
]);

const perfDef = z.object({
  warmup: z.number().int().min(0).optional(),
  samples: z.number().int().min(1).optional(),
  maxRatio: z.number().optional(),
  minAbsMs: z.number().optional(),
  cpuThrottle: z.number().optional(),
  metrics: z.array(z.string()).optional(),
  interactions: z.array(z.string()).default([]),
});

const pageDef = z.object({
  id: z.string().regex(/^[\w-]+$/, 'id 只允许字母数字下划线中划线'),
  name: z.string(),
  path: z.object({ vue2: z.string(), vue3: z.string() }),
  readyWhen: z.object({
    selector: z.string().optional(),
    apiDone: z.array(z.string()).default([]),
  }).default({ apiDone: [] }),
  apiCapture: z.array(z.string()).default([]),
  apiMap: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  apiIgnoreFields: z.array(z.string()).default([]),
  unorderedPaths: z.array(z.string()).default([]),
  masks: z.array(z.string()).default([]),
  filters: z.array(filterDef).default([]),
  submitSelector: z.string().optional(),
  constraints: z.array(constraintDef).default([]),
  metrics: z.array(metricDef).default([]),
  interactions: z.array(interactionDef).default([]),
  perf: perfDef.default({ interactions: [] }),
});

const globalDef = z.object({
  baseUrl: z.object({ vue2: z.string().url().or(z.string().startsWith('http')), vue3: z.string() }),
  auth: z.object({
    strategy: z.enum(['storage', 'scripted', 'none']).default('none'),
    storageState: z.object({ vue2: z.string(), vue3: z.string() }).partial().default({}),
    probeUrl: z.string().default('/'),
    scripted: z.object({
      loginPath: z.string(),
      usernameSelector: z.string(),
      passwordSelector: z.string(),
      submitSelector: z.string(),
      usernameEnv: z.string().default('VMR_USER'),
      passwordEnv: z.string().default('VMR_PASS'),
    }).optional(),
  }).default({ strategy: 'none', storageState: {}, probeUrl: '/' }),
  browser: z.object({
    viewport: z.object({ width: z.number(), height: z.number() }).default({ width: 1600, height: 900 }),
    locale: z.string().default('zh-CN'),
    timezone: z.string().default('Asia/Shanghai'),
    freezeClock: z.boolean().default(false),
    headless: z.boolean().default(true),
  }).default({}),
  waits: z.object({
    quietMs: z.number().default(800),
    readyTimeoutMs: z.number().default(30000),
    chartSettleMs: z.number().default(1200),
  }).default({}),
  tolerance: z.object({
    numberAbs: z.number().default(0),
    numberRelPct: z.number().default(0),
    pixelThreshold: z.number().default(0.1),
    passDiffRatio: z.number().default(0.002),
    vlReviewMaxRegions: z.number().int().default(4),
  }).default({}),
  vl: z.object({
    baseUrlEnv: z.string().default('VL_BASE_URL'),
    apiKeyEnv: z.string().default('VL_API_KEY'),
    modelEnv: z.string().default('VL_MODEL'),
    timeoutMs: z.number().default(60000),
    maxConcurrent: z.number().int().default(2),
  }).default({}),
  perf: z.object({
    warmup: z.number().int().default(1),
    samples: z.number().int().default(5),
    maxRatio: z.number().default(1.10),
    minAbsMs: z.number().default(100),
    cpuThrottle: z.number().default(1),
    metrics: z.array(z.string()).default(['fcp', 'lcp', 'domContentLoaded', 'load', 'longTasksTotal', 'apiTotal', 'readyTime']),
  }).default({}),
  combos: z.object({
    default: z.enum(['default', 'single', 'pairwise', 'full', 'sample']).default('default'),
    maxCases: z.number().int().default(300),
  }).default({}),
  replayMissPolicy: z.enum(['passthrough-warn', 'abort-fail']).default('passthrough-warn'),
});

export const configSchema = z.object({ global: globalDef, pages: z.array(pageDef).min(1) });

export type Config = z.infer<typeof configSchema>;
export type PageConfig = Config['pages'][number];
export type MetricDef = z.infer<typeof metricDef>;
export type FilterDef = z.infer<typeof filterDef>;
export type InteractionDef = z.infer<typeof interactionDef>;
export type StepDef = z.infer<typeof stepDef>;

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    throw new Error(`配置文件不存在：${path}。请复制 config/pages.example.yaml 为该文件并填写。`);
  }
  const raw = YAML.parse(readFileSync(path, 'utf8'));
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  · ${i.path.join('.') || '(根)'}：${i.message}`);
    throw new Error(`配置校验失败（${path}）：\n${lines.join('\n')}\n请对照 config/pages.example.yaml 修正。`);
  }
  // 交叉校验：filters 默认值必须在 values 中；perf.interactions 引用必须存在
  for (const p of parsed.data.pages) {
    for (const f of p.filters) {
      if (!f.discover && f.values.length && !f.values.some(v => v.label === f.default)) {
        throw new Error(`配置校验失败：页面 ${p.id} 的筛选 ${f.key} 的 default="${f.default}" 不在 values 列表中。`);
      }
    }
    for (const iid of p.perf.interactions) {
      if (!p.interactions.some(i => i.id === iid)) {
        throw new Error(`配置校验失败：页面 ${p.id} 的 perf.interactions 引用了不存在的交互 "${iid}"。`);
      }
    }
  }
  return parsed.data;
}

// 核心共享类型定义
export type Side = 'v2' | 'v3';

// 失败分类体系（任务书 D7）。visual-pending：VL 不可用时像素差异待人工复核（黄色）。
export type FindingType =
  | 'render-bug'        // 数据相同而渲染不同（红）
  | 'interaction-fail'  // 交互行为不一致（红）
  | 'perf-regression'   // 性能退化（红）
  | 'visual-minor'      // 像素有差但 VL 判语义等价（黄）
  | 'visual-pending'    // 像素有差、VL 未启用，待人工复核（黄）
  | 'data-drift'        // 仅 live 模式：源数据漂移导致（黄）
  | 'flaky'             // 二次确认结论不一致（黄）
  | 'tool-error';       // 工具/环境问题：选择器失效、超时等（灰，不计缺陷）

export type FindingLayer = 'metric' | 'api' | 'visual' | 'interaction' | 'perf' | 'tool';

export interface Finding {
  type: FindingType;
  layer: FindingLayer;
  id: string;            // 指标 id / 交互 id / 接口签名 等
  message: string;       // 中文描述
  v2?: unknown;
  v3?: unknown;
  extra?: Record<string, unknown>;
}

export type CaseStatus = 'pass' | 'warn' | 'fail' | 'error';

export interface ShotTriple { label: string; v2: string; v3: string; diff?: string; ratio?: number; }

export interface PerfStat { median: number; p75: number; samples: number[]; }
export interface PerfMetricResult {
  metric: string; v2: PerfStat; v3: PerfStat;
  regressed: boolean; ratio: number; deltaMs: number;
}
export interface PerfResult { metrics: PerfMetricResult[]; samples: number; warmup: number; }

export interface CaseResult {
  caseId: string;
  pageId: string;
  pageName: string;
  comboKey: string;
  combo: Record<string, string>;
  status: CaseStatus;
  findings: Finding[];
  shots: ShotTriple[];
  metrics: Array<{ id: string; name: string; v2: unknown; v3: unknown; equal: boolean; note?: string }>;
  perf?: PerfResult;
  durationMs: number;
  startedAt: string;
  artifactDir: string;   // 相对 runs/<runId>/ 的目录
  confirmed?: boolean;   // 红色结论是否经过二次确认
}

export interface RunSummary {
  total: number; pass: number; warn: number; fail: number; error: number;
  byType: Record<string, number>;
}

export interface RunResults {
  runId: string;
  mode: 'replay' | 'live';
  combo: string;
  seed: number;
  startedAt: string;
  finishedAt: string;
  configPath: string;
  baseUrl: { vue2: string; vue3: string };
  cases: CaseResult[];
  summary: RunSummary;
  exitCode: number;
  notes: string[];
}

export class ToolError extends Error {
  constructor(public id: string, message: string) { super(message); this.name = 'ToolError'; }
}

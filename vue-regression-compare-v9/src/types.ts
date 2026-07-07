export type RunMode = 'default' | 'single-filter' | 'targeted' | 'smoke' | 'standard' | 'strict';
export type TestStrategy = 'smoke' | 'standard' | 'strict' | 'custom';
export type Side = 'vue2' | 'vue3';

/** 报告中的“类型”字段：固定为业务可读的三类。 */
export type VerificationCategory = '指标描述一致' | '页面交互功能一致' | '性能不下降';

/** 报告中的“结果”字段。 */
export type ResultStatus = '通过' | '不通过' | '性能下降' | '执行异常' | '跳过' | '无法判断' | '需人工确认';

/** 面向非技术验收的严重级别。 */
export type Severity = 'S0阻断' | 'S1严重' | 'S2一般' | 'S3提示';

/** 差异归因，用于报告筛选和派单。 */
export type DifferenceAttribution =
  | '展示值差异'
  | 'Vue3缺失'
  | 'Vue3多出'
  | '交互状态不一致'
  | '交互执行失败'
  | '性能退化'
  | 'selector配置问题'
  | '登录或权限问题'
  | '页面加载问题'
  | '未配置交互'
  | '覆盖缺口'
  | '工具异常'
  | '无法归因';

export interface PageConfig {
  pageKey: string;
  pageName: string;
  vue2Url: string;
  vue3Url: string;
  /** 模块/分组，用于批量报告汇总。 */
  group?: string;
  owner?: string;
  enabled?: boolean;
  /** 页面风险等级：用于推荐测试策略。 */
  pageRisk?: 'low' | 'medium' | 'high';
  /** 默认测试策略。未配置时按 standard。 */
  testStrategy?: TestStrategy;
  /** 页面稳定判断。建议配置页面主容器、核心卡片或表格容器。 */
  waitForSelector?: string;
  /** 全局等待 loading 消失，支持多个选择器。 */
  waitForHiddenSelectors?: string[];
  /** 是否等待 Playwright networkidle，默认 true。 */
  waitForNetworkIdle?: boolean;
  /** 页面就绪后额外等待，适合动画或异步渲染。 */
  waitAfterMs?: number;
  /** 更严格的页面稳定协议。默认开启，用于避免页面仍在 Loading/异步渲染时开始比较。 */
  readiness?: ReadinessConfig;
  timeoutMs?: number;
  /** Playwright 登录态文件，例如 auth/storageState.json。 */
  storageState?: string;

  /** 是否自动扫描 Vue2/Vue3 交互入口并做双向存在性检查。默认 true。 */
  autoDiscoverInteractions?: boolean;
  /** Vue3 多出交互的策略：manual=需人工确认；fail=不通过；ignore=跳过。默认 manual。 */
  interactionExtraPolicy?: 'manual' | 'fail' | 'ignore';
  /** 自动交互扫描最大元素数，默认 120。 */
  interactionScanLimit?: number;
  /** 交互校验模式：conservative=只做确定性匹配；balanced=保留更多可疑项。默认 conservative。 */
  interactionCheckMode?: 'conservative' | 'balanced';
  /** 是否允许仅靠唯一文本匹配交互。默认 true；conservative 模式下必须两端文本唯一才纳入。 */
  interactionUniqueTextMatch?: boolean;
  /** 交互文本匹配时是否去掉全/半角空格，默认 true；解决“查 询”和“查询”误判。 */
  interactionNormalizeSpaces?: boolean;
  /** 是否允许低置信文本模糊匹配。默认 false，建议仅在人工确认场景启用。 */
  interactionFuzzyTextMatch?: boolean;
  /** 是否把 Vue3 多出的确定性交互写入报告。默认 true；不确定项不会写入。 */
  reportVue3ExtraInteractions?: boolean;
  /** 安全动作关键词，仅用于报告标记和后续扩展，默认内置。 */
  safeActionKeywords?: string[];
  /** 危险动作关键词，危险动作不会自动点击，只做存在性/状态检查。 */
  dangerousActionKeywords?: string[];

  /** 策略控制：默认固定默认条件，每次只变更一个筛选器。 */
  filterStrategy?: {
    keepOthersDefault?: boolean;
    maxScenarios?: number;
    includeDefault?: boolean;
  };

  metrics?: MetricConfig[];
  filters?: FilterConfig[];
  /** 页签、指标维度切换等展示类入口。标准模式/严格模式默认全量遍历。 */
  tabs?: TabGroupConfig | TabConfig[];
  interactions?: InteractionConfig[];
}

export interface ReadinessConfig {
  /** 是否等待 fetch/XHR 水位归零并保持静默。默认 true；长轮询页面可设 false。 */
  waitForRequestIdle?: boolean;
  /** 是否等待 DOM mutation 保持静默。默认 true。 */
  waitForDomStable?: boolean;
  /** DOM/request 静默窗口，默认 800ms。 */
  stableQuietMs?: number;
  /** 是否启用常见 Loading 选择器自动识别。默认 true。 */
  waitForCommonLoading?: boolean;
  /** 业务自定义 Loading/骨架屏/遮罩选择器；会和 waitForHiddenSelectors 一起等待消失。 */
  loadingSelectors?: string[];
  /** 业务自定义 Loading 文案；短文本元素命中时会等待消失。 */
  loadingText?: string[];
  /** 是否等待 canvas/ECharts 画面稳定。默认 true。 */
  waitForCanvasStable?: boolean;
  /** canvas 稳定等待上限，默认 1200ms。 */
  canvasSettleMs?: number;
  /** 截图前是否自动滚动到底再回顶，触发懒加载。默认 true。 */
  autoScrollBeforeScreenshot?: boolean;
  /** 是否注入 CSS 关闭动画/过渡/光标闪烁。默认 true。 */
  disableAnimations?: boolean;
}

export interface MetricConfig {
  name: string;
  selector: string;
  /** text: compare element text; table: compare joined text from table/container. */
  type?: 'text' | 'table';
  /** If true, collect text from all matched elements and join them in DOM order. */
  all?: boolean;
  /** Optional attribute to read instead of innerText. */
  attribute?: string;
  required?: boolean;
  /** 关键指标差异按 S1；非关键可按 S2。 */
  critical?: boolean;
}

export interface CollectedMetric {
  name: string;
  selector: string;
  value: string;
  attribute?: string;
}

export interface FilterOption {
  label: string;
  value: string;
}

export type FilterStrategy =
  | 'all'
  | 'sample'
  | 'previous-and-current'
  | 'region-representative'
  | 'first-n'
  | 'manual';

export interface FilterConfig {
  name: string;
  selector: string;
  type: 'select' | 'input' | 'click-options';
  /** 时间 / 地区 / 普通 / 机构 / 状态等业务类型。 */
  businessType?: 'time' | 'region' | 'normal' | 'org' | 'status' | 'product' | 'dimension';
  /** 标准策略：时间上一个+当前；地区代表抽样；普通全量。 */
  strategy?: FilterStrategy;
  values?: FilterOption[];
  /** sample / first-n 策略使用，默认 2。 */
  maxValues?: number;
  preferredDomestic?: string[];
  preferredOverseas?: string[];
  /** For click-options: selector template, supports {{value}} and {{label}}. */
  optionSelector?: string;
  /** Optional button to click after changing the filter, e.g. search button. */
  submitSelector?: string;
  waitForSelector?: string;
  waitAfterMs?: number;
  critical?: boolean;
}

export interface TabConfig {
  name: string;
  selector: string;
  waitForSelector?: string;
  waitAfterMs?: number;
  critical?: boolean;
  enabled?: boolean;
}

export interface TabGroupConfig {
  strategy?: 'all' | 'manual' | 'none';
  items: TabConfig[];
}

export interface InteractionConfig {
  name: string;
  type: 'click' | 'hover';
  selector: string;
  waitForSelector?: string;
  waitAfterMs?: number;
  compareUrl?: boolean;
  compareSelectors?: string[];
  closeSelector?: string;
  screenshot?: boolean;
  /** 是否允许自动执行。危险动作建议显式 false。 */
  executable?: boolean;
  critical?: boolean;
}

export interface RunContext {
  mode: RunMode;
  headed: boolean;
  /** 默认使用 workspace/pages，让业务配置和代码隔离。 */
  configDir: string;
  page?: string;
  outputDir: string;
  /** 页面级并发数。默认 2；性能严谨模式可设为 1。 */
  concurrency: number;
  /** 性能采样次数。N>1 时同一场景执行 N 次，性能项取中位数，功能结果保留最后一次。 */
  runs?: number;
  /** 只生成计划/覆盖预览时使用，当前 compare 不启用。 */
  dryRun?: boolean;
}

export interface ScenarioContext {
  pageKey: string;
  pageName: string;
  scenarioName: string;
  /** 页签名。 */
  tabName?: string;
  filterName?: string;
  filterValue?: string;
  filterLabel?: string;
}

export interface ResultRow extends ScenarioContext {
  category: VerificationCategory;
  itemName: string;
  vue2Value?: string;
  vue3Value?: string;
  /** HTML with highlighted difference. Only safe to render in our generated HTML report. */
  vue2DiffHtml?: string;
  vue3DiffHtml?: string;
  diffSummary?: string;
  status: ResultStatus;
  /** 非技术人员能看懂的原因分类。 */
  attribution?: DifferenceAttribution;
  /** 严重级别，用于筛选和派单。 */
  severity?: Severity;
  /** 建议动作：开发修复 / 配置修正 / 业务确认 / 登录检查等。 */
  suggestion?: string;
  message?: string;
  errorType?: string;
  selector?: string;
  vue2Screenshot?: string;
  vue3Screenshot?: string;
  durationVue2Ms?: number;
  durationVue3Ms?: number;
  /** 面向报告展示：提升 20.00% / 下降 20.00% / 持平 0.00%。 */
  performanceChange?: string;
  retryCount?: number;
}

export interface SelectorCheckRow {
  pageKey: string;
  pageName: string;
  side: Side;
  selectorType: '指标' | '筛选器' | '页签' | '交互入口' | '交互等待区' | '交互对比区' | '关闭按钮' | '页面等待区';
  name: string;
  selector: string;
  foundCount: number;
  status: '通过' | '不通过' | '执行异常';
  message?: string;
  suggestion?: string;
}

export interface DiscoveredInteraction {
  side: Side;
  key: string;
  type: string;
  name: string;
  role: string;
  href?: string;
  visible: boolean;
  enabled: boolean;
  dangerous: boolean;
  safe: boolean;
  descriptor: string;
  /** 匹配置信度：high 才进入确定性交互一致性。 */
  confidence?: 'high' | 'medium' | 'low';
  /** 匹配依据：testId / aria / title / href / uniqueText / formLabel 等。 */
  matchBy?: string;
}

export interface CoverageRow {
  module: string;
  discovered: number;
  planned: number;
  verified: number;
  ignored: number;
  unknown: number;
  coverageRate: string;
  gap: string;
  suggestion: string;
}

export interface PlanPreview {
  pageKey: string;
  pageName: string;
  strategy: RunMode;
  scenarioCount: number;
  metricChecks: number;
  interactionChecks: number;
  performanceChecks: number;
  filterScenarios: Array<{ filterName: string; options: FilterOption[]; strategy: string }>;
  tabScenarios: string[];
  warnings: string[];
}

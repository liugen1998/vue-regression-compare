import type { CollectedMetric, ResultRow, ScenarioContext } from './types.js';
import { buildTextDiff } from './diff.js';
import { invalidValueErrorType, invalidValueMessage, isInvalidCollectedValue, isPerformanceDegraded, performanceChangeText } from './utils.js';

export function compareMetricRows(
  scenario: ScenarioContext,
  vue2Metrics: CollectedMetric[],
  vue3Metrics: CollectedMetric[]
): ResultRow[] {
  const vue2ByName = new Map(vue2Metrics.map(m => [m.name, m]));
  const vue3ByName = new Map(vue3Metrics.map(m => [m.name, m]));
  const names = new Set([...vue2ByName.keys(), ...vue3ByName.keys()]);
  const rows: ResultRow[] = [];

  if (names.size === 0) {
    return [{
      ...scenario,
      category: '指标描述一致',
      itemName: '指标配置',
      vue2Value: '[NO_METRICS_CONFIGURED]',
      vue3Value: '[NO_METRICS_CONFIGURED]',
      diffSummary: '当前页面未配置 metrics，指标描述一致未实际验证。',
      status: '需人工确认',
      attribution: '覆盖缺口',
      severity: 'S2一般',
      errorType: '未配置指标',
      message: '未配置指标时不能判定 Vue2/Vue3 展示值一致。',
      suggestion: '请在页面配置中补充关键数字、表格、标题、空态等 metrics；优先使用 data-testid 等稳定 selector。'
    }];
  }

  for (const name of names) {
    const vue2Metric = vue2ByName.get(name);
    const vue3Metric = vue3ByName.get(name);
    const vue2Value = vue2Metric?.value ?? '[MISSING]';
    const vue3Value = vue3Metric?.value ?? '[MISSING]';
    const diff = buildTextDiff(vue2Value, vue3Value);
    const invalid = isInvalidCollectedValue(vue2Value) || isInvalidCollectedValue(vue3Value);

    rows.push({
      ...scenario,
      category: '指标描述一致',
      itemName: name,
      selector: vue2Metric?.selector || vue3Metric?.selector,
      vue2Value,
      vue3Value,
      vue2DiffHtml: diff.vue2DiffHtml,
      vue3DiffHtml: diff.vue3DiffHtml,
      diffSummary: invalid ? invalidValueMessage(vue2Value, vue3Value) : diff.summary,
      status: invalid ? '执行异常' : diff.equal ? '通过' : '不通过',
      attribution: invalid ? 'selector配置问题' : diff.equal ? '无法归因' : '展示值差异',
      severity: invalid ? 'S1严重' : diff.equal ? 'S3提示' : 'S1严重',
      errorType: invalid ? invalidValueErrorType(vue2Value, vue3Value) : undefined,
      message: invalid ? invalidValueMessage(vue2Value, vue3Value) : diff.equal ? '' : '展示值不完全一致'
    });
  }
  return rows;
}

export function performanceRow(
  scenario: ScenarioContext,
  itemName: string,
  vue2Ms: number,
  vue3Ms: number
): ResultRow {
  const change = performanceChangeText(vue2Ms, vue3Ms);
  const degraded = isPerformanceDegraded(vue2Ms, vue3Ms);
  return {
    ...scenario,
    category: '性能不下降',
    itemName,
    vue2Value: `${vue2Ms}ms`,
    vue3Value: `${vue3Ms}ms`,
    durationVue2Ms: vue2Ms,
    durationVue3Ms: vue3Ms,
    performanceChange: change,
    status: degraded ? '性能下降' : '通过',
    attribution: degraded ? '性能退化' : '无法归因',
    severity: degraded ? 'S2一般' : 'S3提示',
    message: degraded ? `Vue3 性能下降：${change}` : `Vue3 性能未下降：${change}`
  };
}

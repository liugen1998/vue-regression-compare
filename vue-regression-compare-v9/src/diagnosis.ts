import type { DifferenceAttribution, ResultRow, Severity } from './types.js';
import { isPerformanceDegraded, performanceChangeText } from './utils.js';

export function enrichRows(rows: ResultRow[]): ResultRow[] {
  return rows.map(enrichRow);
}

export function enrichRow(row: ResultRow): ResultRow {
  const normalized = normalizePerformanceRow(row);
  const attribution = normalized.attribution ?? inferAttribution(normalized);
  const severity = normalized.severity ?? inferSeverity(normalized, attribution);
  const suggestion = normalized.suggestion ?? inferSuggestion(normalized, attribution, severity);
  return { ...normalized, attribution, severity, suggestion };
}

function normalizePerformanceRow(row: ResultRow): ResultRow {
  if (row.category !== '性能不下降') return row;
  const degraded = isPerformanceDegraded(row.durationVue2Ms, row.durationVue3Ms);
  const change = performanceChangeText(row.durationVue2Ms, row.durationVue3Ms);
  const status = degraded ? '性能下降' : '通过';
  return {
    ...row,
    performanceChange: change,
    status,
    attribution: degraded ? '性能退化' : '无法归因',
    severity: degraded ? 'S2一般' : 'S3提示',
    message: degraded ? `Vue3 性能下降：${change}` : `Vue3 性能未下降：${change}`
  };
}

function inferAttribution(row: ResultRow): DifferenceAttribution {
  const text = `${row.status} ${row.errorType ?? ''} ${row.message ?? ''} ${row.diffSummary ?? ''}`;
  if (row.status === '性能下降' || row.category === '性能不下降') return row.status === '性能下降' ? '性能退化' : '无法归因';
  if (/Vue3.*缺失|Vue2 有.*Vue3 未找到|不存在/.test(text)) return 'Vue3缺失';
  if (/Vue3.*多出|Vue2 未找到.*Vue3 有|需人工确认/.test(text)) return 'Vue3多出';
  if (/selector|NOT_FOUND|MISSING|采集/.test(text)) return 'selector配置问题';
  if (/登录|权限|storageState/.test(text)) return '登录或权限问题';
  if (/页面打不开|加载超时|Navigation|goto|net::ERR/.test(text)) return '页面加载问题';
  if (/点击|悬停|交互/.test(text) && row.status !== '通过') return '交互执行失败';
  if (row.category === '指标描述一致' && row.status === '不通过') return '展示值差异';
  return '无法归因';
}

function inferSeverity(row: ResultRow, attribution: DifferenceAttribution): Severity {
  if (row.status === '通过' || row.status === '跳过') return 'S3提示';
  if (row.status === '执行异常') {
    if (attribution === '登录或权限问题' || attribution === '页面加载问题') return 'S0阻断';
    return 'S1严重';
  }
  if (attribution === 'Vue3缺失') return 'S1严重';
  if (attribution === '展示值差异') return 'S1严重';
  if (attribution === '性能退化') return 'S2一般';
  if (attribution === 'Vue3多出') return row.status === '需人工确认' ? 'S2一般' : 'S1严重';
  if (attribution === '交互状态不一致' || attribution === '交互执行失败') return 'S1严重';
  if (row.status === '无法判断') return 'S2一般';
  return 'S2一般';
}

function inferSuggestion(row: ResultRow, attribution: DifferenceAttribution, severity: Severity): string {
  if (row.status === '通过') return '-';
  switch (attribution) {
    case '展示值差异':
      return '请业务确认展示口径；若确认 Vue3 错误，由前端/接口修复后重跑。';
    case 'Vue3缺失':
      return 'Vue2 存在但 Vue3 缺失，优先检查 Vue3 页面是否漏迁移入口或字段。';
    case 'Vue3多出':
      return 'Vue3 多出交互入口，请业务确认是否为本次升级允许的新增能力；不允许则前端移除或隐藏。';
    case '交互状态不一致':
      return '检查按钮/链接/筛选器是否可见、可点击、禁用状态、文案和权限控制是否一致。';
    case '交互执行失败':
      return '先用 --headed 复现，确认 selector、弹窗/下钻等待区和页面权限。';
    case '性能退化':
      return '查看 Vue2/Vue3 耗时与性能变化，区分接口慢还是前端渲染慢，必要时单页 concurrency=1 重跑。';
    case 'selector配置问题':
      return '运行 npm run check-selectors；建议前端补充稳定 data-testid，避免使用易变 CSS 层级。';
    case '登录或权限问题':
      return '重新执行 npm run setup 或 npm run auth 保存登录态，确认账号对 Vue2/Vue3 均有权限。';
    case '页面加载问题':
      return '检查页面 URL、网络、登录跳转和 waitForSelector；必要时增加 waitAfterMs 或等待主容器。';
    case '未配置交互':
      return '可先依赖自动交互扫描；若需验证弹窗/下钻内容，由前端补充 interactions.compareSelectors。';
    case '工具异常':
      return '查看 result.json 和控制台堆栈；若可复现，按最小页面配置反馈。';
    default:
      return severity === 'S0阻断' ? '先处理阻断项，再继续验收。' : '人工复核后决定是否修复。';
  }
}

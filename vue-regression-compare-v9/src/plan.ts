import type { FilterOption, PageConfig, PlanPreview, RunMode, TabConfig } from './types.js';
import { inferStrategy, selectByStrategy } from './filters.js';
import { getEnabledTabs } from './tabs.js';

export function resolveEffectiveMode(mode: RunMode, cfg: PageConfig): RunMode {
  if (mode === 'standard' || mode === 'targeted' || mode === 'strict' || mode === 'smoke') return mode;
  if (cfg.testStrategy === 'smoke') return 'smoke';
  if (cfg.testStrategy === 'strict') return 'strict';
  return mode;
}

export function shouldRunFilters(mode: RunMode): boolean {
  return mode === 'single-filter' || mode === 'targeted' || mode === 'standard' || mode === 'strict';
}

export function shouldRunTabs(mode: RunMode): boolean {
  return mode === 'targeted' || mode === 'standard' || mode === 'strict';
}

export function estimatePlan(cfg: PageConfig, mode: RunMode): PlanPreview {
  const effective = resolveEffectiveMode(mode, cfg);
  const tabs = shouldRunTabs(effective) ? getEnabledTabs(cfg) : [];
  const metricCount = cfg.metrics?.length ?? 0;
  const interactionCount = (cfg.interactions?.length ?? 0) + (cfg.autoDiscoverInteractions === false ? 0 : 1);
  const warnings: string[] = [];
  if (metricCount === 0) warnings.push('未配置指标，只能核对页面加载、性能和确定性交互入口。');
  if ((cfg.filters?.length ?? 0) === 0 && shouldRunFilters(effective)) warnings.push('未配置筛选器，筛选场景不会执行。');
  if (tabs.length === 0 && shouldRunTabs(effective)) warnings.push('未配置页签，页签全量遍历不会执行。');
  if ((cfg.interactions?.length ?? 0) === 0) warnings.push('未配置关键 interactions，下钻/弹窗/tooltip 深度验证不会执行。');
  for (const f of cfg.filters ?? []) {
    if (!f.values || f.values.length === 0) warnings.push(`筛选器 ${f.name} 未显式配置 values，策略预览只能估算；运行时会尝试从 Vue2 页面读取。`);
  }

  const filterScenarios = (cfg.filters ?? []).map(f => {
    const base = f.values ?? [];
    const strategy = f.strategy ?? inferStrategy(f, effective);
    const options = selectByStrategy(base, f, strategy);
    return { filterName: f.name, options, strategy };
  });
  const filterCount = shouldRunFilters(effective) ? filterScenarios.reduce((sum, f) => sum + Math.max(0, f.options.length), 0) : 0;
  const tabCount = shouldRunTabs(effective) ? tabs.length : 0;
  const scenarioCount = 1 + filterCount + tabCount;
  return {
    pageKey: cfg.pageKey,
    pageName: cfg.pageName,
    strategy: effective,
    scenarioCount,
    metricChecks: scenarioCount * metricCount,
    interactionChecks: scenarioCount * interactionCount,
    performanceChecks: scenarioCount * 2,
    filterScenarios,
    tabScenarios: tabs.map(t => t.name),
    warnings
  };
}

export function coverageFromConfigAndRows(cfgs: PageConfig[], rows: any[]) {
  const verifiedByPage = new Map<string, any[]>();
  for (const row of rows) {
    const list = verifiedByPage.get(row.pageKey) ?? [];
    list.push(row as any);
    verifiedByPage.set(row.pageKey, list);
  }
  return cfgs.flatMap(cfg => {
    const pageRows = verifiedByPage.get(cfg.pageKey) ?? [];
    const metricRows = pageRows.filter(r => r.category === '指标描述一致');
    const interactionRows = pageRows.filter(r => r.category === '页面交互功能一致');
    const perfRows = pageRows.filter(r => r.category === '性能不下降');
    const tabs = getEnabledTabs(cfg);
    const filters = cfg.filters ?? [];
    const metrics = cfg.metrics ?? [];
    const configuredInteractions = cfg.interactions ?? [];
    const coverage = (verified: number, planned: number) => planned <= 0 ? '0.00%' : `${Math.min(100, (verified / planned) * 100).toFixed(2)}%`;
    return [
      {
        module: `${cfg.pageName}｜指标`,
        discovered: metrics.length,
        planned: metrics.length,
        verified: new Set(metricRows.map(r => r.itemName)).size,
        ignored: 0,
        unknown: metrics.length === 0 ? 1 : 0,
        coverageRate: coverage(new Set(metricRows.map(r => r.itemName)).size, metrics.length),
        gap: metrics.length ? '-' : '未配置指标',
        suggestion: metrics.length ? '继续维护关键指标清单。' : '建议通过页面学习或前端补 data-testid 后确认关键指标。'
      },
      {
        module: `${cfg.pageName}｜筛选器`,
        discovered: filters.length,
        planned: filters.length,
        verified: new Set(pageRows.filter(r => r.filterName).map(r => r.filterName)).size,
        ignored: 0,
        unknown: filters.length === 0 ? 1 : 0,
        coverageRate: coverage(new Set(pageRows.filter(r => r.filterName).map(r => r.filterName)).size, filters.length),
        gap: filters.length ? '-' : '未配置筛选器',
        suggestion: filters.length ? '检查时间/地区/普通筛选策略是否符合业务。' : '建议确认是否存在时间、地区、状态等筛选器。'
      },
      {
        module: `${cfg.pageName}｜页签`,
        discovered: tabs.length,
        planned: tabs.length,
        verified: new Set(pageRows.filter(r => (r as any).tabName).map(r => (r as any).tabName)).size,
        ignored: 0,
        unknown: tabs.length === 0 ? 1 : 0,
        coverageRate: coverage(new Set(pageRows.filter(r => (r as any).tabName).map(r => (r as any).tabName)).size, tabs.length),
        gap: tabs.length ? '-' : '未配置页签',
        suggestion: tabs.length ? '标准/严格模式会全量遍历页签。' : '如页面存在页签，建议在页面学习工作台确认。'
      },
      {
        module: `${cfg.pageName}｜交互`,
        discovered: configuredInteractions.length + (cfg.autoDiscoverInteractions === false ? 0 : 1),
        planned: configuredInteractions.length + (cfg.autoDiscoverInteractions === false ? 0 : 1),
        verified: interactionRows.length,
        ignored: 0,
        unknown: interactionRows.length === 0 ? 1 : 0,
        coverageRate: coverage(interactionRows.length, Math.max(1, configuredInteractions.length + (cfg.autoDiscoverInteractions === false ? 0 : 1))),
        gap: configuredInteractions.length ? '-' : '未配置关键交互，只有保守入口扫描',
        suggestion: configuredInteractions.length ? '关键下钻/弹窗/tooltip 已纳入配置化验证。' : '建议人工确认关键交互，并配置 waitForSelector/compareSelectors。'
      },
      {
        module: `${cfg.pageName}｜性能`,
        discovered: 1,
        planned: 1,
        verified: perfRows.length,
        ignored: 0,
        unknown: perfRows.length === 0 ? 1 : 0,
        coverageRate: perfRows.length ? '100.00%' : '0.00%',
        gap: perfRows.length ? '-' : '未采集性能',
        suggestion: '性能严谨验收建议 concurrency=1，并对关键动作多次执行取中位数。'
      }
    ];
  });
}

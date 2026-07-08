import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { CollectedMetric, FilterConfig, FilterOption, PageConfig, ResultRow, RunContext, ScenarioContext, TabConfig } from './types.js';
import { collectMetrics } from './collector.js';
import { compareMetricRows, performanceRow } from './compare.js';
import { applyFilter, resolveFilterOptions, resolveFilterOptionsForMode } from './filters.js';
import { runInteractions } from './interactions.js';
import { openAndWait } from './pageOps.js';
import { capturePagePair, type ScreenshotPair } from './screenshot.js';
import { launchManagedBrowser } from './browser.js';
import { applyTab, getEnabledTabs } from './tabs.js';
import { resolveEffectiveMode, shouldRunFilters, shouldRunTabs } from './plan.js';
import { classifyError, ensureDir, median, pathExists, promisePool, sanitizeFileName } from './utils.js';

export async function runAll(configs: PageConfig[], ctx: RunContext): Promise<ResultRow[]> {
  await ensureDir(ctx.outputDir);
  const browser = await launchManagedBrowser(ctx);
  const enabledConfigs = configs.filter(c => c.enabled !== false);

  try {
    const pageResults = await promisePool(enabledConfigs, ctx.concurrency, async (cfg) => {
      console.log(`\n[PAGE] ${cfg.pageName} (${cfg.pageKey})`);
      return await runOnePage(browser, cfg, ctx).catch((err) => [{
        pageKey: cfg.pageKey,
        pageName: cfg.pageName,
        scenarioName: 'system',
        category: '页面交互功能一致' as const,
        itemName: '页面执行',
        status: '执行异常' as const,
        attribution: '工具异常' as const,
        severity: 'S0阻断' as const,
        errorType: classifyError(err),
        message: (err as Error).stack ?? (err as Error).message,
        suggestion: '页面级执行异常，先查看控制台堆栈和 result.json，确认 URL、登录态和配置。'
      }]);
    });
    return pageResults.flat();
  } finally {
    await browser.close();
  }
}

async function runOnePage(browser: Browser, cfg: PageConfig, ctx: RunContext): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];
  const mode = resolveEffectiveMode(ctx.mode, cfg);

  rows.push(...await runScenario(browser, cfg, ctx, {
    pageKey: cfg.pageKey,
    pageName: cfg.pageName,
    scenarioName: '默认条件'
  }));

  if (shouldRunTabs(mode)) {
    for (const tab of getEnabledTabs(cfg)) {
      rows.push(...await runScenario(browser, cfg, ctx, {
        pageKey: cfg.pageKey,
        pageName: cfg.pageName,
        scenarioName: `页签=${tab.name}`,
        tabName: tab.name
      }, undefined, undefined, tab));
    }
  }

  if (shouldRunFilters(mode)) {
    const filters = cfg.filters ?? [];
    for (const filter of filters) {
      // Use Vue2 page to discover options so Vue3 follows the same option set.
      const discovery = await createPagePair(browser, cfg);
      try {
        await openAndWait(discovery.vue2Page, cfg.vue2Url, cfg);
        const options = mode === 'single-filter'
          ? await resolveFilterOptions(discovery.vue2Page, filter)
          : await resolveFilterOptionsForMode(discovery.vue2Page, filter, mode);
        for (const option of options) {
          rows.push(...await runScenario(browser, cfg, ctx, {
            pageKey: cfg.pageKey,
            pageName: cfg.pageName,
            scenarioName: `${filter.name}=${option.label}`,
            filterName: filter.name,
            filterValue: option.value,
            filterLabel: option.label
          }, filter, option));
        }
      } finally {
        await closePagePair(discovery);
      }
    }
  }

  return rows;
}

async function runScenario(
  browser: Browser,
  cfg: PageConfig,
  ctx: RunContext,
  scenario: ScenarioContext,
  filter?: FilterConfig,
  option?: FilterOption,
  tab?: TabConfig
): Promise<ResultRow[]> {
  const runs = Math.max(1, Math.floor(ctx.runs ?? 1));
  if (runs === 1) return runScenarioOnce(browser, cfg, ctx, scenario, filter, option, tab, 1, 1);

  const allRuns: ResultRow[][] = [];
  for (let i = 1; i <= runs; i++) {
    console.log(`    [RUN ${i}/${runs}] ${scenario.scenarioName}`);
    allRuns.push(await runScenarioOnce(browser, cfg, ctx, scenario, filter, option, tab, i, runs));
  }
  return mergeScenarioRuns(scenario, allRuns, runs);
}

async function runScenarioOnce(
  browser: Browser,
  cfg: PageConfig,
  ctx: RunContext,
  scenario: ScenarioContext,
  filter?: FilterConfig,
  option?: FilterOption,
  tab?: TabConfig,
  runIndex = 1,
  totalRuns = 1
): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];
  const pair = await createPagePair(browser, cfg);
  try {
    console.log(`  [SCENARIO] ${scenario.scenarioName}${totalRuns > 1 ? ` (${runIndex}/${totalRuns})` : ''}`);
    const [vue2LoadMs, vue3LoadMs] = await Promise.all([
      openAndWait(pair.vue2Page, cfg.vue2Url, cfg),
      openAndWait(pair.vue3Page, cfg.vue3Url, cfg)
    ]);
    rows.push(performanceRow(scenario, '页面加载到稳定', vue2LoadMs, vue3LoadMs));

    if (tab) {
      const [vue2TabMs, vue3TabMs] = await Promise.all([
        applyTab(pair.vue2Page, tab, cfg),
        applyTab(pair.vue3Page, tab, cfg)
      ]);
      rows.push(performanceRow(scenario, `${tab.name}页签切换`, vue2TabMs, vue3TabMs));
    }

    if (filter && option) {
      const [vue2FilterMs, vue3FilterMs] = await Promise.all([
        applyFilter(pair.vue2Page, filter, option, cfg),
        applyFilter(pair.vue3Page, filter, option, cfg)
      ]);
      rows.push(performanceRow(scenario, `${filter.name}筛选响应`, vue2FilterMs, vue3FilterMs));
    }

    const [vue2Metrics, vue3Metrics] = await Promise.all([
      collectMetrics(pair.vue2Page, cfg.metrics),
      collectMetrics(pair.vue3Page, cfg.metrics)
    ]);

    const metricRows = compareMetricRows(scenario, vue2Metrics, vue3Metrics);
    await attachMetricEvidence(pair.vue2Page, pair.vue3Page, cfg, scenario, metricRows, vue2Metrics, vue3Metrics, ctx.outputDir);
    rows.push(...metricRows);

    rows.push(...await runInteractions(pair.vue2Page, pair.vue3Page, cfg, scenario, ctx.outputDir));
  } catch (err) {
    rows.push({
      ...scenario,
      category: '页面交互功能一致',
      itemName: '场景执行',
      status: '执行异常',
      attribution: classifyError(err).includes('页面') ? '页面加载问题' : '工具异常',
      severity: 'S0阻断',
      errorType: classifyError(err),
      message: (err as Error).stack ?? (err as Error).message,
      suggestion: '场景执行异常，建议 --headed 单页重跑并检查页面加载、登录态、页签/筛选器定位和等待条件。'
    });
  } finally {
    await closePagePair(pair);
  }
  return rows;
}

function mergeScenarioRuns(scenario: ScenarioContext, allRuns: ResultRow[][], runs: number): ResultRow[] {
  const perfGroups = new Map<string, ResultRow[]>();
  for (const rows of allRuns) {
    for (const row of rows) {
      if (row.category !== '性能不下降') continue;
      const list = perfGroups.get(row.itemName) ?? [];
      list.push(row);
      perfGroups.set(row.itemName, list);
    }
  }

  const mergedPerf: ResultRow[] = [];
  for (const [itemName, rows] of perfGroups) {
    const vue2Samples = rows.map(r => r.durationVue2Ms).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const vue3Samples = rows.map(r => r.durationVue3Ms).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (!vue2Samples.length || !vue3Samples.length) {
      mergedPerf.push({
        ...scenario,
        category: '性能不下降',
        itemName,
        status: '执行异常',
        attribution: '性能退化',
        severity: 'S2一般',
        errorType: '性能样本不足',
        message: `性能采样 ${runs} 次，但有效样本不足，无法计算中位数。`,
        suggestion: '建议检查页面加载稳定性，或使用 --headed --runs 1 先定位异常。'
      });
      continue;
    }
    const vue2Median = Math.round(median(vue2Samples));
    const vue3Median = Math.round(median(vue3Samples));
    const merged = performanceRow(scenario, itemName, vue2Median, vue3Median);
    merged.message = `${merged.message || ''}；性能采样 ${runs} 次取中位数。Vue2样本=${vue2Samples.join('/')}ms；Vue3样本=${vue3Samples.join('/')}ms`;
    merged.retryCount = runs - 1;
    mergedPerf.push(merged);
  }

  const lastUseful = [...allRuns].reverse().find(rows => rows.some(r => r.category !== '性能不下降')) ?? allRuns.at(-1) ?? [];
  const nonPerf = lastUseful.filter(r => r.category !== '性能不下降');
  return [...mergedPerf, ...nonPerf];
}

async function attachMetricEvidence(
  vue2Page: Page,
  vue3Page: Page,
  cfg: PageConfig,
  scenario: ScenarioContext,
  rows: ResultRow[],
  vue2Metrics: CollectedMetric[],
  vue3Metrics: CollectedMetric[],
  outputDir: string
): Promise<void> {
  const vue2ByName = new Map(vue2Metrics.map(m => [m.name, m]));
  const vue3ByName = new Map(vue3Metrics.map(m => [m.name, m]));

  for (const row of rows) {
    if (row.category !== '指标描述一致' || row.status === '通过') continue;
    try {
      const vue2Metric = vue2ByName.get(row.itemName);
      const vue3Metric = vue3ByName.get(row.itemName);
      const selector = vue2Metric?.selector || vue3Metric?.selector;
      if (!selector) continue;
      const shots: ScreenshotPair = await capturePagePair(
        vue2Page,
        vue3Page,
        cfg,
        scenario,
        `metric_${sanitizeFileName(row.itemName)}`,
        outputDir,
        {
          vue2HighlightSelector: vue2Metric?.selector ?? selector,
          vue3HighlightSelector: vue3Metric?.selector ?? selector,
          fullPage: true
        }
      );

      row.vue2Screenshot = shots.vue2;
      row.vue3Screenshot = shots.vue3;
    } catch (err) {
      // P0：截图只是证据附件，不能影响指标结果。截图失败时保留指标行并降级为“无截图”。
      const reason = classifyError(err);
      const suffix = `截图失败，已降级为无截图，不影响本指标结果。原因：${reason}`;
      row.message = row.message ? `${row.message}；${suffix}` : suffix;
      row.suggestion = row.suggestion || '优先处理指标差异；如需截图证据，请单页 --headed 重跑并检查页面是否遮挡、跳转或关闭。';
      row.vue2Screenshot = row.vue2Screenshot || undefined;
      row.vue3Screenshot = row.vue3Screenshot || undefined;
    }
  }
}

interface PagePair {
  vue2Context: BrowserContext;
  vue3Context: BrowserContext;
  vue2Page: Page;
  vue3Page: Page;
}

async function createPagePair(browser: Browser, cfg: PageConfig): Promise<PagePair> {
  const storageStatePath = cfg.storageState ? path.resolve(cfg.storageState) : undefined;
  const storageState = storageStatePath && await pathExists(storageStatePath) ? storageStatePath : undefined;
  const contextOptions = {
    storageState,
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true
  };
  const [vue2Context, vue3Context] = await Promise.all([
    browser.newContext(contextOptions),
    browser.newContext(contextOptions)
  ]);
  const [vue2Page, vue3Page] = await Promise.all([
    vue2Context.newPage(),
    vue3Context.newPage()
  ]);
  vue2Page.setDefaultTimeout(cfg.timeoutMs ?? 60_000);
  vue3Page.setDefaultTimeout(cfg.timeoutMs ?? 60_000);
  return { vue2Context, vue3Context, vue2Page, vue3Page };
}

async function closePagePair(pair: PagePair): Promise<void> {
  await Promise.allSettled([pair.vue2Context.close(), pair.vue3Context.close()]);
}

import type { Page } from 'playwright';
import type { InteractionConfig, PageConfig, ResultRow, ScenarioContext } from './types.js';
import { compareAutoDiscoveredInteractions } from './interactionDiscovery.js';
import { buildTextDiff } from './diff.js';
import { safeText, waitPageReady } from './pageOps.js';
import { capturePagePair, type ScreenshotPair } from './screenshot.js';
import { classifyError, invalidValueErrorType, invalidValueMessage, isInvalidCollectedValue, isPerformanceDegraded, performanceChangeText, sleep } from './utils.js';

interface TimedInteractionResult {
  ok: boolean;
  durationMs: number;
  skipped?: boolean;
  errorType?: string;
  message?: string;
}

export async function runInteractions(
  vue2Page: Page,
  vue3Page: Page,
  cfg: PageConfig,
  scenario: ScenarioContext,
  outputDir: string
): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];

  if (cfg.autoDiscoverInteractions !== false) {
    rows.push(...await compareAutoDiscoveredInteractions(vue2Page, vue3Page, cfg, scenario));
  }

  const configuredInteractions = cfg.interactions ?? [];
  if (configuredInteractions.length === 0 && cfg.autoDiscoverInteractions === false) {
    rows.push({
      ...scenario,
      category: '页面交互功能一致',
      itemName: '交互配置检查',
      vue2Value: '未配置 interactions',
      vue3Value: '未配置 interactions',
      status: '无法判断',
      attribution: '未配置交互',
      severity: 'S2一般',
      message: '当前页面未配置交互项，且已关闭自动交互扫描，因此未执行交互一致性验证',
      suggestion: '建议打开 autoDiscoverInteractions，或由前端补充 interactions。'
    });
  }

  for (const interaction of configuredInteractions) {
    const [vue2Result, vue3Result] = await Promise.all([
      runTimedInteraction(vue2Page, interaction, cfg),
      runTimedInteraction(vue3Page, interaction, cfg)
    ]);

    const availabilityRow = await buildInteractionAvailabilityRow(
      vue2Page,
      vue3Page,
      cfg,
      scenario,
      interaction,
      vue2Result,
      vue3Result,
      outputDir
    );
    rows.push(availabilityRow);

    if (!vue2Result.ok || !vue3Result.ok || vue2Result.skipped || vue3Result.skipped) {
      await Promise.allSettled([
        closeInteraction(vue2Page, interaction, cfg),
        closeInteraction(vue3Page, interaction, cfg)
      ]);
      continue;
    }

    rows.push(buildInteractionPerformanceRow(scenario, interaction.name, vue2Result.durationMs, vue3Result.durationMs));

    if (interaction.compareUrl) {
      rows.push(await compareTextWithScreenshot(
        vue2Page,
        vue3Page,
        cfg,
        scenario,
        interaction,
        'URL',
        vue2Page.url(),
        vue3Page.url(),
        outputDir
      ));
    }

    for (const selector of interaction.compareSelectors ?? []) {
      const [vue2Text, vue3Text] = await Promise.all([
        safeText(vue2Page, selector, true).catch(err => `[ERROR] ${(err as Error).message}`),
        safeText(vue3Page, selector, true).catch(err => `[ERROR] ${(err as Error).message}`)
      ]);
      rows.push(await compareTextWithScreenshot(
        vue2Page,
        vue3Page,
        cfg,
        scenario,
        interaction,
        selector,
        vue2Text,
        vue3Text,
        outputDir,
        selector
      ));
    }

    await Promise.allSettled([
      closeInteraction(vue2Page, interaction, cfg),
      closeInteraction(vue3Page, interaction, cfg)
    ]);
  }
  return rows;
}

async function runTimedInteraction(page: Page, interaction: InteractionConfig, cfg: PageConfig): Promise<TimedInteractionResult> {
  const start = Date.now();
  try {
    const skipped = await performInteraction(page, interaction, cfg);
    return { ok: true, skipped, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      errorType: classifyError(err),
      message: (err as Error).message
    };
  }
}

async function performInteraction(page: Page, interaction: InteractionConfig, cfg: PageConfig): Promise<boolean> {
  const timeout = cfg.timeoutMs ?? 60_000;
  const target = page.locator(interaction.selector).first();
  await target.waitFor({ state: 'visible', timeout });

  if (interaction.executable === false) return true;

  if (interaction.type === 'click') await target.click({ timeout });
  else if (interaction.type === 'hover') await target.hover({ timeout });

  if (interaction.waitForSelector) {
    await page.locator(interaction.waitForSelector).first().waitFor({ state: 'visible', timeout });
  }
  await waitPageReady(page, cfg);
  if (interaction.waitAfterMs) await sleep(interaction.waitAfterMs);
  return false;
}

async function closeInteraction(page: Page, interaction: InteractionConfig, cfg: PageConfig): Promise<void> {
  if (!interaction.closeSelector) return;
  const loc = page.locator(interaction.closeSelector).first();
  if (await loc.count()) {
    await loc.click({ timeout: cfg.timeoutMs ?? 30_000 }).catch(() => undefined);
  }
}

async function buildInteractionAvailabilityRow(
  vue2Page: Page,
  vue3Page: Page,
  cfg: PageConfig,
  scenario: ScenarioContext,
  interaction: InteractionConfig,
  vue2Result: TimedInteractionResult,
  vue3Result: TimedInteractionResult,
  outputDir: string
): Promise<ResultRow> {
  const skipped = Boolean(vue2Result.skipped || vue3Result.skipped);
  const ok = vue2Result.ok && vue3Result.ok && !skipped;
  const shouldScreenshot = (!ok && !skipped) || interaction.screenshot;
  const shots: ScreenshotPair = shouldScreenshot
    ? await capturePagePair(vue2Page, vue3Page, cfg, scenario, `${interaction.name}_availability`, outputDir, {
        vue2HighlightSelector: interaction.selector,
        vue3HighlightSelector: interaction.selector,
        fullPage: true
      }).catch(() => ({} as ScreenshotPair))
    : {};

  const vue2Value = vue2Result.skipped ? '已按配置跳过执行' : vue2Result.ok ? '交互执行成功' : `交互执行失败：${vue2Result.message ?? ''}`;
  const vue3Value = vue3Result.skipped ? '已按配置跳过执行' : vue3Result.ok ? '交互执行成功' : `交互执行失败：${vue3Result.message ?? ''}`;
  const errorType = !ok && !skipped
    ? [vue2Result.ok ? '' : `Vue2:${vue2Result.errorType}`, vue3Result.ok ? '' : `Vue3:${vue3Result.errorType}`].filter(Boolean).join('；')
    : undefined;

  return {
    ...scenario,
    category: '页面交互功能一致',
    itemName: `${interaction.name} / 交互入口执行一致`,
    selector: interaction.selector,
    vue2Value,
    vue3Value,
    status: skipped ? '跳过' : ok ? '通过' : '执行异常',
    attribution: skipped ? '无法归因' : ok ? '无法归因' : '交互执行失败',
    severity: skipped ? 'S3提示' : ok ? 'S3提示' : 'S1严重',
    errorType,
    message: skipped ? '该交互配置 executable=false，未自动执行。' : ok ? 'Vue2 与 Vue3 均可执行该交互' : '至少一端交互执行失败',
    suggestion: skipped ? '如需纳入自动执行，确认无风险后将 executable 改为 true 或删除该字段。' : ok ? '-' : '先用 --headed 复现，检查交互 selector、等待区域、弹窗/下钻逻辑和权限。',
    vue2Screenshot: shots.vue2,
    vue3Screenshot: shots.vue3
  };
}

function buildInteractionPerformanceRow(
  scenario: ScenarioContext,
  interactionName: string,
  vue2Ms: number,
  vue3Ms: number
): ResultRow {
  const change = performanceChangeText(vue2Ms, vue3Ms);
  const degraded = isPerformanceDegraded(vue2Ms, vue3Ms);
  return {
    ...scenario,
    category: '性能不下降',
    itemName: `${interactionName} 耗时`,
    vue2Value: `${vue2Ms}ms`,
    vue3Value: `${vue3Ms}ms`,
    durationVue2Ms: vue2Ms,
    durationVue3Ms: vue3Ms,
    performanceChange: change,
    status: degraded ? '性能下降' : '通过',
    attribution: degraded ? '性能退化' : '无法归因',
    severity: degraded ? 'S2一般' : 'S3提示',
    message: degraded ? `Vue3 交互性能下降：${change}` : `Vue3 交互性能未下降：${change}`
  };
}

async function compareTextWithScreenshot(
  vue2Page: Page,
  vue3Page: Page,
  cfg: PageConfig,
  scenario: ScenarioContext,
  interaction: InteractionConfig,
  item: string,
  vue2Value: string,
  vue3Value: string,
  outputDir: string,
  highlightSelector?: string
): Promise<ResultRow> {
  const diff = buildTextDiff(vue2Value, vue3Value);
  const invalid = isInvalidCollectedValue(vue2Value) || isInvalidCollectedValue(vue3Value);
  const shouldScreenshot = invalid || !diff.equal || interaction.screenshot;
  const shots: ScreenshotPair = shouldScreenshot
    ? await capturePagePair(vue2Page, vue3Page, cfg, scenario, `${interaction.name}_${item}`, outputDir, {
        vue2HighlightSelector: highlightSelector,
        vue3HighlightSelector: highlightSelector,
        fullPage: true
      }).catch(() => ({} as ScreenshotPair))
    : {};

  return {
    ...scenario,
    category: '页面交互功能一致',
    itemName: `${interaction.name} / ${item}`,
    selector: highlightSelector ?? interaction.selector,
    vue2Value,
    vue3Value,
    vue2DiffHtml: diff.vue2DiffHtml,
    vue3DiffHtml: diff.vue3DiffHtml,
    diffSummary: invalid ? invalidValueMessage(vue2Value, vue3Value) : diff.summary,
    status: invalid ? '执行异常' : diff.equal ? '通过' : '不通过',
    attribution: invalid ? 'selector配置问题' : diff.equal ? '无法归因' : '展示值差异',
    severity: invalid ? 'S1严重' : diff.equal ? 'S3提示' : 'S1严重',
    errorType: invalid ? invalidValueErrorType(vue2Value, vue3Value) : undefined,
    message: invalid ? invalidValueMessage(vue2Value, vue3Value) : diff.equal ? '' : '交互后内容不完全一致',
    suggestion: invalid ? '运行 check-selectors，检查交互后 compareSelectors 是否正确。' : diff.equal ? '-' : '检查弹窗、下钻、tooltip 或 URL 参数是否一致。',
    vue2Screenshot: shots.vue2,
    vue3Screenshot: shots.vue3
  };
}

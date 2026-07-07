import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { Browser, Page } from 'playwright';
import { launchManagedBrowser } from './browser.js';
import { loadPageConfigs, parseArgs } from './config.js';
import { openAndWait } from './pageOps.js';
import type { PageConfig, SelectorCheckRow, Side } from './types.js';
import { getEnabledTabs } from './tabs.js';
import { classifyError, ensureDir, nowStamp, pathExists } from './utils.js';

async function main(): Promise<void> {
  const ctx = parseArgs(process.argv.slice(2));
  const outputDir = path.join(ctx.outputDir, `selector-check-${nowStamp()}`);
  await ensureDir(outputDir);

  const configs = await loadPageConfigs(ctx.configDir, ctx.page);
  const browser = await launchManagedBrowser(ctx);
  const rows: SelectorCheckRow[] = [];

  try {
    for (const cfg of configs) {
      console.log(`[CHECK] ${cfg.pageName}`);
      rows.push(...await checkPage(browser, cfg, 'vue2'));
      rows.push(...await checkPage(browser, cfg, 'vue3'));
    }
  } finally {
    await browser.close();
  }

  await writeSelectorReports(rows, outputDir);
  const fail = rows.filter(r => r.status !== '通过').length;
  console.log(`\n选择器健康检查完成：总数=${rows.length}, 问题=${fail}`);
  console.log(`报告目录：${outputDir}`);
  if (fail > 0) process.exitCode = 1;
}

async function checkPage(browser: Browser, cfg: PageConfig, side: Side): Promise<SelectorCheckRow[]> {
  const rows: SelectorCheckRow[] = [];
  const storageStatePath = cfg.storageState ? path.resolve(cfg.storageState) : undefined;
  const context = await browser.newContext({
    storageState: storageStatePath && await pathExists(storageStatePath) ? storageStatePath : undefined,
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeoutMs ?? 60_000);
  const url = side === 'vue2' ? cfg.vue2Url : cfg.vue3Url;

  try {
    await openAndWait(page, url, cfg);
    if (cfg.waitForSelector) rows.push(await checkSelector(page, cfg, side, '页面等待区', 'waitForSelector', cfg.waitForSelector));
    for (const metric of cfg.metrics ?? []) rows.push(await checkSelector(page, cfg, side, '指标', metric.name, metric.selector));
    for (const filter of cfg.filters ?? []) rows.push(await checkSelector(page, cfg, side, '筛选器', filter.name, filter.selector));
    for (const tab of getEnabledTabs(cfg)) rows.push(await checkSelector(page, cfg, side, '页签', tab.name, tab.selector));
    for (const interaction of cfg.interactions ?? []) {
      rows.push(await checkSelector(page, cfg, side, '交互入口', interaction.name, interaction.selector));
      if (interaction.waitForSelector) rows.push(await checkSelector(page, cfg, side, '交互等待区', interaction.name, interaction.waitForSelector, false));
      for (const selector of interaction.compareSelectors ?? []) rows.push(await checkSelector(page, cfg, side, '交互对比区', interaction.name, selector, false));
      if (interaction.closeSelector) rows.push(await checkSelector(page, cfg, side, '关闭按钮', interaction.name, interaction.closeSelector, false));
    }
  } catch (err) {
    rows.push({
      pageKey: cfg.pageKey,
      pageName: cfg.pageName,
      side,
      selectorType: '页面等待区',
      name: '页面打开',
      selector: url,
      foundCount: 0,
      status: '执行异常',
      message: `${classifyError(err)}：${(err as Error).message}`,
      suggestion: '检查 URL、登录态、权限和 waitForSelector；必要时先用 --headed 打开页面观察。'
    });
  } finally {
    await context.close();
  }
  return rows;
}

async function checkSelector(
  page: Page,
  cfg: PageConfig,
  side: Side,
  selectorType: SelectorCheckRow['selectorType'],
  name: string,
  selector: string,
  strict = true
): Promise<SelectorCheckRow> {
  try {
    const count = await page.locator(selector).count();
    return {
      pageKey: cfg.pageKey,
      pageName: cfg.pageName,
      side,
      selectorType,
      name,
      selector,
      foundCount: count,
      status: count > 0 || !strict ? '通过' : '不通过',
      message: count > 0 ? '' : strict ? '未找到元素' : '当前状态未出现，可能需要交互后出现',
      suggestion: count > 0 ? '-' : strict ? 'selector 没有命中元素。建议前端补充 data-testid，或在浏览器开发者工具中重新确认 selector。' : '这是交互后才出现的区域，如弹窗/tooltip；若主流程失败，再检查该 selector。'
    };
  } catch (err) {
    return {
      pageKey: cfg.pageKey,
      pageName: cfg.pageName,
      side,
      selectorType,
      name,
      selector,
      foundCount: 0,
      status: '执行异常',
      message: (err as Error).message,
      suggestion: 'selector 语法可能不合法，或页面上下文已关闭。请先复制到浏览器控制台 document.querySelector(...) 验证。'
    };
  }
}

async function writeSelectorReports(rows: SelectorCheckRow[], outputDir: string): Promise<void> {
  await fs.writeFile(path.join(outputDir, 'selector-check.json'), JSON.stringify(rows, null, 2), 'utf8');

  const htmlRows = rows.map(r => `<tr class="${r.status === '通过' ? '' : 'bad'}"><td>${r.pageName}</td><td>${r.side}</td><td>${r.selectorType}</td><td>${r.name}</td><td><code>${escape(r.selector)}</code></td><td>${r.foundCount}</td><td>${r.status}</td><td>${escape(r.message ?? '')}</td><td>${escape(r.suggestion ?? '')}</td></tr>`).join('\n');
  await fs.writeFile(path.join(outputDir, 'selector-check.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>选择器健康检查</title><style>body{font-family:Arial,'Microsoft YaHei';margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}th{background:#f2f4f7}.bad{background:#fff1f0}code{white-space:pre-wrap}</style><h1>选择器健康检查</h1><table><thead><tr><th>页面</th><th>端</th><th>类型</th><th>名称</th><th>selector</th><th>数量</th><th>结果</th><th>说明</th><th>建议</th></tr></thead><tbody>${htmlRows}</tbody></table></html>`, 'utf8');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('选择器健康检查');
  sheet.columns = [
    { header: '页面Key', key: 'pageKey', width: 18 },
    { header: '页面', key: 'pageName', width: 24 },
    { header: '端', key: 'side', width: 10 },
    { header: '类型', key: 'selectorType', width: 18 },
    { header: '名称', key: 'name', width: 28 },
    { header: 'selector', key: 'selector', width: 60 },
    { header: '数量', key: 'foundCount', width: 10 },
    { header: '结果', key: 'status', width: 12 },
    { header: '说明', key: 'message', width: 42 },
    { header: '建议', key: 'suggestion', width: 54 }
  ];
  rows.forEach(r => sheet.addRow(r));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'J1' };
  await workbook.xlsx.writeFile(path.join(outputDir, 'selector-check.xlsx'));
}

function escape(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

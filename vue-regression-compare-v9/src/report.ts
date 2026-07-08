import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { CoverageRow, PageConfig, ResultRow, ResultStatus, Severity } from './types.js';
import { enrichRows } from './diagnosis.js';
import { coverageFromConfigAndRows } from './plan.js';
import { ensureDir, escapeHtml } from './utils.js';

interface PageCoverageSummary {
  pageKey: string;
  pageName: string;
  status: '完成' | '有问题' | '有缺口';
  metrics: string;
  filters: string;
  tabs: string;
  interactions: string;
  performance: string;
  gaps: string;
  suggestion: string;
}

export async function writeReports(inputRows: ResultRow[], outputDir: string, configs: PageConfig[] = [], _ctx?: unknown): Promise<void> {
  await ensureDir(outputDir);
  const rows = enrichRows(inputRows);
  const coverage = coverageFromConfigAndRows(configs, rows as any) as CoverageRow[];
  const pageCoverage = summarizePageCoverage(configs, rows);

  await Promise.all([
    fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(rows, null, 2), 'utf8'),
    fs.writeFile(path.join(outputDir, 'coverage.json'), JSON.stringify(coverage, null, 2), 'utf8'),
    writeHtml(rows, pageCoverage, path.join(outputDir, 'report.html')),
    writeExcel(rows, pageCoverage, path.join(outputDir, 'report.xlsx'))
  ]);
}

async function writeHtml(rows: ResultRow[], pageCoverage: PageCoverageSummary[], file: string): Promise<void> {
  const summary = summarize(rows, pageCoverage);
  const detailRows = rows.map((r, idx) => {
    const searchText = [
      r.pageName, r.pageKey, r.scenarioName, r.tabName, r.filterName, r.filterLabel, r.category,
      r.itemName, r.vue2Value, r.vue3Value, r.status, r.errorType, r.attribution, r.severity,
      r.message, r.diffSummary, r.suggestion, r.selector, r.performanceChange
    ].join(' ').toLowerCase();
    return `<tr data-page="${escapeHtml(r.pageName)}" data-category="${escapeHtml(r.category)}" data-status="${escapeHtml(r.status)}" data-severity="${escapeHtml(r.severity ?? '')}" data-attribution="${escapeHtml(r.attribution ?? '')}" data-search="${escapeHtml(searchText)}">
      <td>${idx + 1}</td><td>${escapeHtml(r.pageName)}<div class="sub">${escapeHtml(r.pageKey)}</div></td><td>${escapeHtml(r.scenarioName)}</td><td>${escapeHtml(r.tabName ?? '-')}</td>
      <td>${escapeHtml(r.filterName ?? '-')}</td><td>${escapeHtml(r.filterLabel ?? r.filterValue ?? '-')}</td><td>${escapeHtml(r.category)}</td><td>${escapeHtml(r.itemName)}</td>
      <td><span class="sev ${severityClass(r.severity)}">${escapeHtml(r.severity || '-')}</span></td><td>${escapeHtml(r.attribution || '-')}</td>
      <td class="value-cell">${r.vue2DiffHtml ?? escapeHtml(r.vue2Value ?? '')}</td><td class="value-cell">${r.vue3DiffHtml ?? escapeHtml(r.vue3Value ?? '')}</td>
      <td><span class="badge ${statusClass(r.status)}">${escapeHtml(r.status)}</span></td><td>${escapeHtml(r.errorType || '-')}</td><td>${escapeHtml(r.message || '-')}</td>
      <td>${escapeHtml(r.diffSummary || '-')}</td><td>${escapeHtml(r.suggestion || '-')}</td><td><code>${escapeHtml(r.selector || '-')}</code></td>
      <td>${r.durationVue2Ms ?? '-'}</td><td>${r.durationVue3Ms ?? '-'}</td><td>${escapeHtml(r.performanceChange || '-')}</td><td>${imgCell(r.vue2Screenshot)}</td><td>${imgCell(r.vue3Screenshot)}</td>
    </tr>`;
  }).join('\n');

  const coverageRows = pageCoverage.map(c => `<tr data-page="${escapeHtml(c.pageName)}">
    <td>${escapeHtml(c.pageName)}<div class="sub">${escapeHtml(c.pageKey)}</div></td>
    <td><span class="badge ${c.status === '完成' ? 'badge-pass' : c.status === '有问题' ? 'badge-fail' : 'badge-perf'}">${escapeHtml(c.status)}</span></td>
    <td>${escapeHtml(c.metrics)}</td><td>${escapeHtml(c.filters)}</td><td>${escapeHtml(c.tabs)}</td>
    <td>${escapeHtml(c.interactions)}</td><td>${escapeHtml(c.performance)}</td>
    <td>${escapeHtml(c.gaps)}</td><td>${escapeHtml(c.suggestion)}</td>
  </tr>`).join('\n');

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>Vue2/Vue3 升级验收报告</title>
<style>
body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:24px;color:#1f2328;background:#fff}h1{margin:0 0 8px}h2{margin-top:28px}.meta,.sub{color:#6a737d;font-size:12px}.business-summary{margin:16px 0;padding:14px 16px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;line-height:1.8}.business-summary b{color:#0a3069}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}.card{border:1px solid #d0d7de;border-radius:8px;padding:12px;background:#fff;cursor:pointer}.card:hover{background:#f6f8fa}.card .label{color:#57606a;font-size:13px}.card .num{font-weight:700;font-size:24px;margin-top:4px}.toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;padding:12px;border:1px solid #d0d7de;border-radius:8px;background:#fff}.toolbar label{display:block;font-size:12px;color:#57606a;margin-bottom:4px}.toolbar select,.toolbar input{height:32px;min-width:150px;border:1px solid #d0d7de;border-radius:6px;padding:0 8px}.toolbar input{min-width:320px}.toolbar button{height:32px;border:1px solid #0969da;background:#0969da;color:#fff;border-radius:6px;padding:0 10px;cursor:pointer}.countbar{margin:10px 0;color:#57606a}.table-wrap{overflow:auto;border:1px solid #d0d7de;border-radius:8px}table{border-collapse:collapse;width:100%;min-width:2200px}table.coverage{min-width:1200px}th,td{border-bottom:1px solid #d8dee4;border-right:1px solid #d8dee4;padding:8px;vertical-align:top;font-size:13px}th{background:#f6f8fa;text-align:left;white-space:nowrap}tr:hover{background:#fffef0}code{white-space:pre-wrap;font-family:Consolas,monospace;font-size:12px}.value-cell{max-width:360px;white-space:pre-wrap;word-break:break-word}.badge,.sev{display:inline-block;padding:2px 8px;border-radius:999px;font-weight:700;white-space:nowrap}.badge-pass{background:#dafbe1;color:#116329}.badge-fail{background:#ffebe9;color:#a40e26}.badge-perf{background:#fff1c2;color:#7d4e00}.badge-error{background:#ffebe9;color:#a40e26}.badge-skip{background:#eaeef2;color:#57606a}.sev-s0{background:#a40e26;color:#fff}.sev-s1{background:#ffebe9;color:#a40e26}.sev-s2{background:#fff1c2;color:#7d4e00}.sev-s3{background:#eaeef2;color:#57606a}.diff-old{background:#ffd6d6;color:#a40000;font-weight:700;border:1px solid #ff8a8a;border-radius:3px;padding:0 2px}.diff-new{background:#d6ecff;color:#004a99;font-weight:700;border:1px solid #8ac5ff;border-radius:3px;padding:0 2px}.thumb{display:inline-block;margin-top:4px;max-width:96px;max-height:72px;border:1px solid #ccc;border-radius:4px;vertical-align:top;cursor:zoom-in}.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:99;align-items:center;justify-content:center}.modal.open{display:flex}.modal img{max-width:94vw;max-height:90vh;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.35)}.modal .close{position:fixed;top:20px;right:28px;color:#fff;font-size:28px;cursor:pointer}
</style></head><body>
<h1>Vue2/Vue3 升级验收报告</h1><div class="meta">生成时间：${escapeHtml(new Date().toLocaleString())}</div>
<div class="business-summary"><div><b>验收口径：</b>展示值必须一致；Vue3 耗时高于 Vue2 即性能下降；交互只做确定性匹配，不做模糊猜测。</div><div><b>阅读顺序：</b>先看总览，再看页面覆盖概览，最后按页面/类型/结果筛选明细。</div></div>
<div class="summary">${summaryCards(summary)}</div>
<h2>页面覆盖概览</h2><div class="table-wrap"><table class="coverage"><thead><tr><th>页面</th><th>状态</th><th>指标</th><th>筛选器</th><th>页签</th><th>交互</th><th>性能</th><th>缺口</th><th>建议</th></tr></thead><tbody>${coverageRows || '<tr><td colspan="9">暂无页面覆盖信息</td></tr>'}</tbody></table></div>
<h2>全部明细</h2><div class="toolbar"><div><label>页面</label><select id="pageFilter"><option value="">全部页面</option></select></div><div><label>验证类型</label><select id="categoryFilter"><option value="">全部类型</option><option>指标描述一致</option><option>页面交互功能一致</option><option>性能不下降</option></select></div><div><label>结果</label><select id="statusFilter"><option value="">全部结果</option><option>通过</option><option>不通过</option><option>性能下降</option><option>执行异常</option><option>无法判断</option><option>需人工确认</option><option>跳过</option></select></div><div><label>级别</label><select id="severityFilter"><option value="">全部级别</option><option>S0阻断</option><option>S1严重</option><option>S2一般</option><option>S3提示</option></select></div><div><label>差异归因</label><select id="attributionFilter"><option value="">全部归因</option></select></div><div><label>关键词搜索</label><input id="searchBox" placeholder="页面/指标/归因/建议/selector"/></div><div><label>快捷操作</label><button id="onlyBad">只看问题</button><button id="resetFilter">重置</button></div></div><div class="countbar">当前显示 <b id="visibleCount">0</b> / <b>${rows.length}</b> 条</div>
<div class="table-wrap"><table id="detailTable"><thead><tr><th>#</th><th>页面</th><th>场景</th><th>页签</th><th>筛选器</th><th>筛选值</th><th>类型</th><th>验证项</th><th>级别</th><th>差异归因</th><th>Vue2 值</th><th>Vue3 值</th><th>结果</th><th>异常类型</th><th>说明</th><th>差异说明</th><th>建议处理动作</th><th>selector</th><th>Vue2耗时ms</th><th>Vue3耗时ms</th><th>性能变化</th><th>Vue2截图</th><th>Vue3截图</th></tr></thead><tbody>${detailRows || '<tr><td colspan="23">暂无明细</td></tr>'}</tbody></table></div><div id="imgModal" class="modal"><span class="close">×</span><img alt="截图"/></div>
<script>
const rows=[...document.querySelectorAll('#detailTable tbody tr')].filter(r=>r.dataset.page);const pageFilter=document.getElementById('pageFilter'),categoryFilter=document.getElementById('categoryFilter'),statusFilter=document.getElementById('statusFilter'),severityFilter=document.getElementById('severityFilter'),attributionFilter=document.getElementById('attributionFilter'),searchBox=document.getElementById('searchBox'),visibleCount=document.getElementById('visibleCount');
for(const p of [...new Set(rows.map(r=>r.dataset.page).filter(Boolean))].sort()){const o=document.createElement('option');o.value=p;o.textContent=p;pageFilter.appendChild(o)}for(const a of [...new Set(rows.map(r=>r.dataset.attribution).filter(Boolean))].sort()){const o=document.createElement('option');o.value=a;o.textContent=a;attributionFilter.appendChild(o)}
function applyFilters(){const page=pageFilter.value,cat=categoryFilter.value,st=statusFilter.value,sev=severityFilter.value,att=attributionFilter.value,kw=searchBox.value.trim().toLowerCase();let shown=0;for(const r of rows){const ok=(!page||r.dataset.page===page)&&(!cat||r.dataset.category===cat)&&(!st||r.dataset.status===st)&&(!sev||r.dataset.severity===sev)&&(!att||r.dataset.attribution===att)&&(!kw||(r.dataset.search||'').includes(kw));r.style.display=ok?'':'none';if(ok)shown++}visibleCount.textContent=String(shown)}for(const el of [pageFilter,categoryFilter,statusFilter,severityFilter,attributionFilter])el.addEventListener('change',applyFilters);searchBox.addEventListener('input',applyFilters);document.getElementById('resetFilter').addEventListener('click',()=>{pageFilter.value=categoryFilter.value=statusFilter.value=severityFilter.value=attributionFilter.value=searchBox.value='';applyFilters()});document.getElementById('onlyBad').addEventListener('click',()=>{pageFilter.value=categoryFilter.value=severityFilter.value=attributionFilter.value=searchBox.value='';statusFilter.value='';for(const r of rows){const bad=['不通过','性能下降','执行异常','无法判断','需人工确认'].includes(r.dataset.status||'');r.style.display=bad?'':'none'}visibleCount.textContent=String(rows.filter(r=>r.style.display!=='none').length)});document.querySelectorAll('.card[data-category],.card[data-status],.card[data-severity],.card[data-attribution]').forEach(card=>{card.addEventListener('click',()=>{if(card.dataset.category)categoryFilter.value=card.dataset.category;if(card.dataset.status)statusFilter.value=card.dataset.status;if(card.dataset.severity)severityFilter.value=card.dataset.severity;if(card.dataset.attribution)attributionFilter.value=card.dataset.attribution;pageFilter.value='';searchBox.value='';applyFilters()})});const modal=document.getElementById('imgModal');const modalImg=modal.querySelector('img');document.querySelectorAll('img.thumb').forEach(img=>{img.addEventListener('click',()=>{modalImg.src=img.dataset.full;modal.classList.add('open')})});modal.querySelector('.close').addEventListener('click',()=>modal.classList.remove('open'));modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('open')});applyFilters();
</script></body></html>`;
  await fs.writeFile(file, html, 'utf8');
}

async function writeExcel(rows: ResultRow[], pageCoverage: PageCoverageSummary[], file: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'vue-regression-compare';
  workbook.created = new Date();

  const detailSheet = workbook.addWorksheet('明细');
  detailSheet.columns = detailColumns();
  rows.forEach((r, index) => {
    const row = detailSheet.addRow({ index: index + 1, ...r, errorType: r.errorType || '-', message: r.message || '-', diffSummary: r.diffSummary || '-', suggestion: r.suggestion || '-', attribution: r.attribution || '-', severity: r.severity || '-', tabName: r.tabName || '-' });
    if (r.vue2Screenshot) row.getCell('V').value = { text: '查看', hyperlink: r.vue2Screenshot };
    if (r.vue3Screenshot) row.getCell('W').value = { text: '查看', hyperlink: r.vue3Screenshot };
  });
  formatDetailSheet(detailSheet);

  const coverageSheet = workbook.addWorksheet('页面覆盖概览');
  coverageSheet.columns = [
    { header: '页面', key: 'pageName', width: 24 }, { header: 'pageKey', key: 'pageKey', width: 22 }, { header: '状态', key: 'status', width: 12 },
    { header: '指标', key: 'metrics', width: 18 }, { header: '筛选器', key: 'filters', width: 18 }, { header: '页签', key: 'tabs', width: 18 },
    { header: '交互', key: 'interactions', width: 18 }, { header: '性能', key: 'performance', width: 18 }, { header: '缺口', key: 'gaps', width: 46 },
    { header: '建议', key: 'suggestion', width: 60 }
  ];
  pageCoverage.forEach(c => coverageSheet.addRow(c));
  formatGenericSheet(coverageSheet);

  const summarySheet = workbook.addWorksheet('总览');
  summarySheet.columns = [{ header: '类型', key: 'type', width: 30 }, { header: '数量', key: 'count', width: 12 }];
  Object.entries(summarize(rows, pageCoverage)).forEach(([type, count]) => summarySheet.addRow({ type, count }));
  formatGenericSheet(summarySheet);

  await workbook.xlsx.writeFile(file);
}

function detailColumns(): Partial<ExcelJS.Column>[] {
  return [
    { header: '#', key: 'index', width: 8 }, { header: '页面', key: 'pageName', width: 24 }, { header: '场景', key: 'scenarioName', width: 30 }, { header: '页签', key: 'tabName', width: 18 }, { header: '筛选器', key: 'filterName', width: 18 }, { header: '筛选值', key: 'filterLabel', width: 18 }, { header: '类型', key: 'category', width: 22 }, { header: '验证项', key: 'itemName', width: 34 }, { header: '级别', key: 'severity', width: 12 }, { header: '差异归因', key: 'attribution', width: 18 }, { header: 'Vue2 值', key: 'vue2Value', width: 44 }, { header: 'Vue3 值', key: 'vue3Value', width: 44 }, { header: '结果', key: 'status', width: 14 }, { header: '异常类型', key: 'errorType', width: 24 }, { header: '说明', key: 'message', width: 42 }, { header: '差异说明', key: 'diffSummary', width: 64 }, { header: '建议处理动作', key: 'suggestion', width: 54 }, { header: 'selector', key: 'selector', width: 42 }, { header: 'Vue2耗时ms', key: 'durationVue2Ms', width: 14 }, { header: 'Vue3耗时ms', key: 'durationVue3Ms', width: 14 }, { header: '性能变化', key: 'performanceChange', width: 16 }, { header: 'Vue2截图', key: 'vue2Screenshot', width: 36 }, { header: 'Vue3截图', key: 'vue3Screenshot', width: 36 }
  ];
}

function formatDetailSheet(sheet: ExcelJS.Worksheet): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: 'W1' };
  styleHeader(sheet);
  for (const row of sheet.getRows(2, Math.max(sheet.rowCount - 1, 0)) ?? []) {
    const status = String(row.getCell('M').value ?? '');
    const severity = String(row.getCell('I').value ?? '');
    if (severity === 'S0阻断') row.eachCell(cell => { cell.fill = fill('FFFFD6D6'); });
    else if (severity === 'S1严重') row.eachCell(cell => { cell.fill = fill('FFFFF1F0'); });
    else if (status === '性能下降' || severity === 'S2一般') row.eachCell(cell => { cell.fill = fill('FFFFF7E6'); });
    row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; });
  }
}

function formatGenericSheet(sheet: ExcelJS.Worksheet): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const colCount = sheet.columnCount || 1;
  sheet.autoFilter = { from: 'A1', to: `${columnLetter(colCount)}1` };
  styleHeader(sheet);
  sheet.eachRow(row => row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; }));
}

function summarizePageCoverage(configs: PageConfig[], rows: ResultRow[]): PageCoverageSummary[] {
  const configByKey = new Map(configs.map(c => [c.pageKey, c]));
  const rowKeys = [...new Set(rows.map(r => r.pageKey))];
  const keys = [...new Set([...configs.map(c => c.pageKey), ...rowKeys])];

  return keys.map(key => {
    const cfg = configByKey.get(key);
    const pageRows = rows.filter(r => r.pageKey === key);
    const pageName = cfg?.pageName ?? pageRows[0]?.pageName ?? key;
    const plannedMetrics = cfg?.metrics?.length ?? 0;
    const plannedFilters = cfg?.filters?.length ?? 0;
    const plannedTabs = Array.isArray(cfg?.tabs) ? cfg?.tabs.length ?? 0 : cfg?.tabs?.items?.filter(t => t.enabled !== false).length ?? 0;
    const plannedInteractions = (cfg?.interactions?.length ?? 0) + (cfg?.autoDiscoverInteractions === false ? 0 : 1);

    const metricRows = pageRows.filter(r => r.category === '指标描述一致' && r.itemName !== '指标配置');
    const filterNames = new Set(pageRows.filter(r => r.filterName).map(r => r.filterName as string));
    const tabNames = new Set(pageRows.filter(r => r.tabName).map(r => r.tabName as string));
    const interactionNames = new Set(pageRows.filter(r => r.category === '页面交互功能一致').map(r => r.itemName));
    const perfRows = pageRows.filter(r => r.category === '性能不下降');
    const pageHasProblem = pageRows.some(isProblem);

    const gaps: string[] = [];
    if (plannedMetrics === 0) gaps.push('未配置指标');
    else if (metricRows.length < plannedMetrics) gaps.push(`指标未全量验证 ${metricRows.length}/${plannedMetrics}`);
    if (plannedFilters === 0) gaps.push('未配置筛选器');
    if (plannedTabs === 0) gaps.push('未配置页签');
    if ((cfg?.interactions?.length ?? 0) === 0) gaps.push('未配置关键交互');
    if (perfRows.length === 0) gaps.push('未采集性能');

    const status: PageCoverageSummary['status'] = pageHasProblem ? '有问题' : gaps.length ? '有缺口' : '完成';
    return {
      pageKey: key,
      pageName,
      status,
      metrics: plannedMetrics ? `${Math.min(metricRows.length, plannedMetrics)}/${plannedMetrics}` : '未配置',
      filters: plannedFilters ? `${Math.min(filterNames.size, plannedFilters)}/${plannedFilters}` : '未配置',
      tabs: plannedTabs ? `${Math.min(tabNames.size, plannedTabs)}/${plannedTabs}` : '未配置',
      interactions: plannedInteractions ? `${Math.min(interactionNames.size, plannedInteractions)}/${plannedInteractions}` : '未配置',
      performance: perfRows.length ? `${perfRows.length}项` : '未采集',
      gaps: gaps.join('；') || '-',
      suggestion: coverageSuggestion(gaps)
    };
  });
}

function coverageSuggestion(gaps: string[]): string {
  if (gaps.some(g => g.includes('未配置指标'))) return '优先补充关键 metrics，否则“指标描述一致”无法形成有效结论。';
  if (gaps.some(g => g.includes('关键交互'))) return '补充弹窗、下钻、tooltip 等关键 interactions。';
  if (gaps.some(g => g.includes('筛选器'))) return '确认页面是否有时间、地区、状态等筛选器，并补充稳定 selector。';
  if (gaps.some(g => g.includes('页签'))) return '确认页面是否有页签/维度切换，并补充 tabs 配置。';
  if (gaps.some(g => g.includes('性能'))) return '先检查页面是否执行成功，再重跑性能采样。';
  return '覆盖完整，优先处理明细中的不通过、性能下降和执行异常。';
}

function summarize(rows: ResultRow[], pageCoverage: PageCoverageSummary[]): Record<string, number> {
  return {
    '页面数': new Set([...pageCoverage.map(c => c.pageKey), ...rows.map(r => r.pageKey)]).size,
    '总项数': rows.length,
    '通过': rows.filter(r => r.status === '通过').length,
    '问题项': rows.filter(isProblem).length,
    'S0阻断': rows.filter(r => r.severity === 'S0阻断').length,
    'S1严重': rows.filter(r => r.severity === 'S1严重').length,
    'S2一般': rows.filter(r => r.severity === 'S2一般').length,
    '不通过': rows.filter(r => r.status === '不通过').length,
    '需人工确认': rows.filter(r => r.status === '需人工确认').length,
    '性能下降': rows.filter(r => r.status === '性能下降').length,
    '执行异常': rows.filter(r => r.status === '执行异常').length,
    '覆盖缺口页面': pageCoverage.filter(c => c.status === '有缺口').length,
    '指标未配置页面': pageCoverage.filter(c => c.metrics === '未配置').length,
    'Vue3缺失': rows.filter(r => r.attribution === 'Vue3缺失').length,
    'Vue3多出': rows.filter(r => r.attribution === 'Vue3多出').length,
    '展示值差异': rows.filter(r => r.attribution === '展示值差异').length,
    'selector配置问题': rows.filter(r => r.attribution === 'selector配置问题').length,
    '指标描述一致问题': rows.filter(r => r.category === '指标描述一致' && isProblem(r)).length,
    '页面交互功能一致问题': rows.filter(r => r.category === '页面交互功能一致' && isProblem(r)).length,
    '性能不下降问题': rows.filter(r => r.category === '性能不下降' && r.status === '性能下降').length
  };
}

function summaryCards(summary: Record<string, number>): string {
  const cardAttrs: Record<string, string> = {
    '通过': 'data-status="通过"',
    '不通过': 'data-status="不通过"',
    '需人工确认': 'data-status="需人工确认"',
    '性能下降': 'data-status="性能下降"',
    '执行异常': 'data-status="执行异常"',
    'S0阻断': 'data-severity="S0阻断"',
    'S1严重': 'data-severity="S1严重"',
    'S2一般': 'data-severity="S2一般"',
    'Vue3缺失': 'data-attribution="Vue3缺失"',
    'Vue3多出': 'data-attribution="Vue3多出"',
    '展示值差异': 'data-attribution="展示值差异"',
    'selector配置问题': 'data-attribution="selector配置问题"',
    '指标描述一致问题': 'data-category="指标描述一致"',
    '页面交互功能一致问题': 'data-category="页面交互功能一致"',
    '性能不下降问题': 'data-category="性能不下降" data-status="性能下降"'
  };
  return Object.entries(summary).map(([k, v]) => `<div class="card" ${cardAttrs[k] ?? ''}><div class="label">${escapeHtml(k)}</div><div class="num">${v}</div></div>`).join('');
}

function statusClass(status: ResultStatus): string { if (status === '通过') return 'badge-pass'; if (status === '不通过' || status === '需人工确认') return 'badge-fail'; if (status === '性能下降') return 'badge-perf'; if (status === '执行异常' || status === '无法判断') return 'badge-error'; return 'badge-skip'; }
function severityClass(severity?: Severity): string { if (severity === 'S0阻断') return 'sev-s0'; if (severity === 'S1严重') return 'sev-s1'; if (severity === 'S2一般') return 'sev-s2'; return 'sev-s3'; }
function isProblem(row: ResultRow): boolean { return ['不通过', '性能下降', '执行异常', '无法判断', '需人工确认'].includes(row.status); }
function imgCell(src?: string): string { if (!src) return '-'; const safe = escapeHtml(src); return `<img class="thumb" src="${safe}" data-full="${safe}" alt="截图" />`; }
function styleHeader(sheet: ExcelJS.Worksheet): void { const header = sheet.getRow(1); header.font = { bold: true }; header.fill = fill('FFEFF3F6'); header.alignment = { vertical: 'middle', wrapText: true }; sheet.eachRow(row => { row.eachCell(cell => { cell.border = { top: { style: 'thin', color: { argb: 'FFD0D7DE' } }, left: { style: 'thin', color: { argb: 'FFD0D7DE' } }, bottom: { style: 'thin', color: { argb: 'FFD0D7DE' } }, right: { style: 'thin', color: { argb: 'FFD0D7DE' } } }; }); }); }
function fill(argb: string): ExcelJS.Fill { return { type: 'pattern', pattern: 'solid', fgColor: { argb } }; }
function columnLetter(n: number): string { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s || 'A'; }

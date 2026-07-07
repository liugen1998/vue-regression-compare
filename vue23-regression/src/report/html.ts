import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CaseResult, Finding, RunResults } from '../types.js';

const TYPE_META: Record<string, { label: string; color: string }> = {
  'render-bug': { label: '渲染缺陷', color: '#d93026' },
  'interaction-fail': { label: '交互不一致', color: '#d93026' },
  'perf-regression': { label: '性能退化', color: '#d93026' },
  'visual-minor': { label: '视觉微差(VL判等价)', color: '#b8860b' },
  'visual-pending': { label: '视觉差异待复核', color: '#b8860b' },
  'data-drift': { label: '数据漂移', color: '#b8860b' },
  'flaky': { label: '不稳定', color: '#b8860b' },
  'tool-error': { label: '工具错误', color: '#888' },
};
const STATUS_META: Record<string, { label: string; color: string }> = {
  pass: { label: '通过', color: '#1a8f4a' },
  warn: { label: '告警', color: '#b8860b' },
  fail: { label: '缺陷', color: '#d93026' },
  error: { label: '工具错误', color: '#888' },
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtVal = (v: unknown) => {
  if (v === null || v === undefined) return '<i>空</i>';
  const s = Array.isArray(v) ? JSON.stringify(v) : String(v);
  return esc(s.length > 300 ? s.slice(0, 300) + '…' : s);
};

function imgTag(runDir: string, rel: string | undefined, alt: string): string {
  if (!rel) return '';
  const p = join(runDir, rel);
  if (!existsSync(p)) return `<div class="noimg">（无截图：${esc(rel)}）</div>`;
  const b64 = readFileSync(p).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}" alt="${esc(alt)}" onclick="this.classList.toggle('zoom')"><figcaption>${esc(alt)}</figcaption></figure>`;
}

function findingsHtml(fs: Finding[]): string {
  if (!fs.length) return '<p class="ok">未发现差异。</p>';
  return '<ul class="findings">' + fs.map(f => {
    const m = TYPE_META[f.type] ?? { label: f.type, color: '#555' };
    const vv = (f.v2 !== undefined || f.v3 !== undefined)
      ? `<div class="vv"><span>Vue2：${fmtVal(f.v2)}</span><span>Vue3：${fmtVal(f.v3)}</span></div>` : '';
    const extra = f.extra ? `<details><summary>详情</summary><pre>${esc(JSON.stringify(f.extra, null, 1).slice(0, 4000))}</pre></details>` : '';
    return `<li><span class="tag" style="background:${m.color}">${m.label}</span> <b>${esc(f.id)}</b>（${f.layer} 层）：${esc(f.message)}${vv}${extra}</li>`;
  }).join('') + '</ul>';
}

function metricsTable(c: CaseResult): string {
  if (!c.metrics.length) return '';
  const rows = c.metrics.map(m => `<tr class="${m.equal ? '' : 'bad'}"><td>${esc(m.name)}</td><td>${fmtVal(m.v2)}</td><td>${fmtVal(m.v3)}</td><td>${m.equal ? '✔ 一致' : '✘ ' + esc(m.note ?? '不一致')}</td></tr>`).join('');
  return `<table><thead><tr><th>指标</th><th>Vue2</th><th>Vue3</th><th>结论</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function perfTable(c: CaseResult): string {
  if (!c.perf) return '';
  const rows = c.perf.metrics.map(m =>
    `<tr class="${m.regressed ? 'bad' : ''}"><td>${esc(m.metric)}</td><td>${m.v2.median.toFixed(0)} / ${m.v2.p75.toFixed(0)}</td><td>${m.v3.median.toFixed(0)} / ${m.v3.p75.toFixed(0)}</td><td>×${m.ratio}（${m.deltaMs >= 0 ? '+' : ''}${m.deltaMs}ms）</td><td>${m.regressed ? '⚠ 退化' : '✔'}</td></tr>`).join('');
  return `<h4>性能对比（中位数 / p75，单位 ms；采样 ${c.perf.samples} 次 + 预热 ${c.perf.warmup} 次，ABAB 交替）</h4>
  <table><thead><tr><th>指标</th><th>Vue2</th><th>Vue3</th><th>倍率(差值)</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function caseCard(c: CaseResult, runDir: string): string {
  const st = STATUS_META[c.status];
  const comboStr = Object.entries(c.combo).map(([k, v]) => `${k}=${v}`).join('，') || '（无筛选/默认）';
  const shots = c.shots.map(s => `
    <div class="triple"><div class="triple-head">${esc(s.label)}${s.ratio !== undefined ? `（像素差异率 ${(s.ratio * 100).toFixed(3)}%）` : ''}</div>
      <div class="imgs">${imgTag(runDir, s.v2, 'Vue2')}${imgTag(runDir, s.v3, 'Vue3')}${imgTag(runDir, s.diff, '差异高亮')}</div>
    </div>`).join('');
  return `<section class="case" id="${esc(c.caseId)}">
    <h3><span class="dot" style="background:${st.color}"></span>${esc(c.pageName)}（${esc(c.pageId)}）<span class="status" style="color:${st.color}">${st.label}</span>
      ${c.confirmed === true ? '<span class="badge">已二次确认</span>' : ''}</h3>
    <p class="meta">筛选组合：${esc(comboStr)}｜耗时 ${(c.durationMs / 1000).toFixed(1)}s｜产物目录 ${esc(c.artifactDir)}</p>
    ${metricsTable(c)}
    ${findingsHtml(c.findings)}
    ${shots}
    ${perfTable(c)}
  </section>`;
}

export function generateHtmlReport(r: RunResults, runDir: string): string {
  const chips = Object.entries(r.summary.byType)
    .map(([t, n]) => { const m = TYPE_META[t] ?? { label: t, color: '#555' }; return `<span class="chip" style="border-color:${m.color};color:${m.color}">${m.label} × ${n}</span>`; }).join('');
  const toc = r.cases.map(c => `<a href="#${esc(c.caseId)}"><span class="dot" style="background:${STATUS_META[c.status].color}"></span>${esc(c.pageName)}｜${esc(Object.values(c.combo).join('，') || '默认')}</a>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Vue2/Vue3 回归比对报告 ${esc(r.runId)}</title>
<style>
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f6f7f9;color:#222}
.wrap{max-width:1180px;margin:0 auto;padding:24px}
h1{font-size:22px} h3{margin:0 0 6px} h4{margin:14px 0 6px}
.summary{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:16px 20px;margin-bottom:16px}
.nums{display:flex;gap:24px;font-size:15px;margin:8px 0}
.nums b{font-size:22px;display:block}
.chip{display:inline-block;border:1px solid;border-radius:20px;padding:2px 10px;margin:3px 6px 0 0;font-size:12px}
.notes{font-size:13px;color:#555;margin-top:8px}
.toc{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px}
.toc a{display:inline-block;margin:2px 12px 2px 0;color:#2b5aa7;text-decoration:none}
.case{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:16px 20px;margin-bottom:16px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.status{margin-left:10px;font-size:14px}
.badge{margin-left:8px;font-size:12px;background:#eef;border-radius:4px;padding:1px 6px;color:#2b5aa7}
.meta{color:#666;font-size:13px;margin:4px 0 10px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 10px}
th,td{border:1px solid #e3e6ea;padding:6px 8px;text-align:left;vertical-align:top}
tr.bad{background:#fdecea}
.findings{font-size:13px;padding-left:18px}
.findings li{margin:6px 0}
.tag{color:#fff;border-radius:4px;padding:1px 6px;font-size:12px;margin-right:4px}
.vv{display:flex;gap:24px;color:#555;margin-top:2px}
.ok{color:#1a8f4a;font-size:13px}
.triple{margin:10px 0}
.triple-head{font-size:13px;color:#444;margin-bottom:4px}
.imgs{display:flex;gap:8px}
figure{margin:0;flex:1;min-width:0}
figcaption{font-size:12px;color:#888;text-align:center}
img{width:100%;border:1px solid #e3e6ea;border-radius:6px;cursor:zoom-in;background:#fff}
img.zoom{position:fixed;inset:2%;width:96%;height:96%;object-fit:contain;z-index:9;box-shadow:0 0 0 100vmax rgba(0,0,0,.5);cursor:zoom-out}
pre{background:#f2f3f5;padding:8px;border-radius:6px;overflow:auto;max-height:260px;font-size:12px}
.noimg{color:#999;font-size:12px}
footer{color:#999;font-size:12px;margin:24px 0}
</style></head><body><div class="wrap">
<h1>Vue2 / Vue3 升级回归比对报告</h1>
<div class="summary">
  <div>运行 ID：<b>${esc(r.runId)}</b>｜模式：${r.mode === 'replay' ? 'replay（数据冻结·权威判定）' : 'live（双端同刻·漂移归因）'}｜组合策略：${esc(r.combo)}｜seed=${r.seed}</div>
  <div style="font-size:12px;color:#666">Vue2：${esc(r.baseUrl.vue2)}　Vue3：${esc(r.baseUrl.vue3)}　${esc(r.startedAt)} → ${esc(r.finishedAt)}</div>
  <div class="nums">
    <span><b>${r.summary.total}</b>用例总数</span>
    <span style="color:#1a8f4a"><b>${r.summary.pass}</b>通过</span>
    <span style="color:#b8860b"><b>${r.summary.warn}</b>告警</span>
    <span style="color:#d93026"><b>${r.summary.fail}</b>缺陷</span>
    <span style="color:#888"><b>${r.summary.error}</b>工具错误</span>
    <span><b>${r.exitCode}</b>退出码</span>
  </div>
  <div>${chips}</div>
  ${r.notes.length ? `<div class="notes">说明：${r.notes.map(esc).join('；')}</div>` : ''}
</div>
<div class="toc"><b>用例导航：</b><br>${toc}</div>
${r.cases.map(c => caseCard(c, runDir)).join('\n')}
<footer>vue23-regression 自动生成 · 本报告完全自包含（截图已内嵌），可直接归档或转发。</footer>
</div></body></html>`;
  const out = join(runDir, 'report.html');
  writeFileSync(out, html);
  return out;
}

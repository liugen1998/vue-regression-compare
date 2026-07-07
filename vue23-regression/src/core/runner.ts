import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { Browser } from 'playwright';
import type { Config, InteractionDef, MetricDef, PageConfig } from '../config/load.js';
import type { CaseResult, CaseStatus, Finding, RunResults, ShotTriple, Side } from '../types.js';
import { ToolError } from '../types.js';
import { buildCombos, comboKey, type Combo, type ComboStrategy } from './combos.js';
import { NetLayer, RecordStore, diffApiPairs } from './net.js';
import { createSideContext, launchBrowser, pageUrl, waitReady } from './session.js';
import { applyCombo, discoverOptions } from './interact_filters.js';
import { compareMetric, extractMetric, type MetricValue } from './extract.js';
import { execStep, runInteraction, type SideCtx } from './interact.js';
import { takeShot, visualCompare, VlClient } from './visual.js';
import { measurePerf } from './perf.js';
import { ensureDir, nowIso, sanitizeName } from '../util/misc.js';
import { Logger, runLogger } from '../util/log.js';
import { generateHtmlReport } from '../report/html.js';
import { generateJUnit } from '../report/junit.js';

const RED = new Set(['render-bug', 'interaction-fail', 'perf-regression']);
const YELLOW = new Set(['visual-minor', 'visual-pending', 'data-drift', 'flaky']);

export interface RunOptions {
  configPath: string;
  mode: 'replay' | 'live';
  combo: ComboStrategy;
  maxCases: number;
  seed: number;
  pages?: string[];
  perf: boolean;
  perfOnly: boolean;
  workers: number;
  resume?: string;
  autoRecord: boolean;
  junit: boolean;
  confirm: boolean;
}

function statusOf(findings: Finding[]): CaseStatus {
  if (findings.some(f => RED.has(f.type))) return 'fail';
  if (findings.some(f => f.type === 'tool-error')) return 'error';
  if (findings.some(f => YELLOW.has(f.type))) return 'warn';
  return 'pass';
}

function redKeySet(findings: Finding[]): string {
  return findings.filter(f => RED.has(f.type)).map(f => `${f.type}|${f.layer}|${f.id}`).sort().join(';');
}

interface CaseCtx {
  browser: Browser; cfg: Config; opts: RunOptions; runDir: string; vl: VlClient | null; log: Logger;
}

/** 录制：在 v2 侧完整走一遍旅程（加载→筛选→各交互），捕获全部 API */
async function recordCase(cc: CaseCtx, pageCfg: PageConfig, combo: Combo, ck: string): Promise<number> {
  const store = new RecordStore(RecordStore.dirFor(process.cwd(), pageCfg.id, ck));
  const ctx = await createSideContext(cc.browser, cc.cfg, 'v2', cc.log);
  try {
    const page = await ctx.newPage();
    const net = new NetLayer('v2', pageCfg, cc.cfg, 'record', store, cc.log);
    await net.attach(page);
    const side: SideCtx = { side: 'v2', page, net };
    await page.goto(pageUrl(cc.cfg, pageCfg, 'v2'), { waitUntil: 'commit' });
    await waitReady(page, pageCfg, cc.cfg, cc.log, { apiDoneCheck: net.apiDoneCheck });
    await applyCombo(page, pageCfg, combo, cc.log);
    await waitReady(page, pageCfg, cc.cfg, cc.log, { apiDoneCheck: net.apiDoneCheck });
    for (const inter of pageCfg.interactions) {
      for (const st of inter.steps) {
        if ((st as { do: string }).do === 'compare') continue;
        const o = await execStep(st, side, pageCfg, cc.cfg, cc.log);
        if (!o.ok) { cc.log.warn(`[record] 交互 ${inter.id} 步骤失败，已跳过后续：${o.err}`); break; }
      }
    }
    return store.size();
  } finally { await ctx.close().catch(() => undefined); }
}

/** 执行单用例（单次，不含二次确认包装） */
async function execCaseOnce(cc: CaseCtx, pageCfg: PageConfig, combo: Combo, ck: string): Promise<CaseResult> {
  const { cfg, opts, runDir, vl } = cc;
  const caseId = `${pageCfg.id}__${ck}`;
  const artifactRel = join('cases', sanitizeName(caseId));
  const artifactDir = ensureDir(join(runDir, artifactRel));
  const clog = cc.log.child(caseId, join(runDir, 'logs', sanitizeName(caseId) + '.log'));
  const startedAt = nowIso();
  const t0 = Date.now();
  const findings: Finding[] = [];
  const shots: ShotTriple[] = [];
  const metricRows: CaseResult['metrics'] = [];

  const store2 = opts.mode === 'replay' ? new RecordStore(RecordStore.dirFor(process.cwd(), pageCfg.id, ck)) : null;
  const store3 = opts.mode === 'replay' ? new RecordStore(RecordStore.dirFor(process.cwd(), pageCfg.id, ck)) : null;
  if (opts.mode === 'replay') {
    const n = store2!.load(); store3!.load();
    if (!n) {
      if (opts.autoRecord) {
        clog.info('无录制数据，--auto-record 生效，先在 Vue2 侧录制…');
        const saved = await recordCase(cc, pageCfg, combo, ck);
        clog.info(`录制完成，共 ${saved} 个接口签名`);
        store2!.load(); store3!.load();
      } else {
        throw new ToolError('no-recording', `无录制数据（页面 ${pageCfg.id}，组合 ${ck}）。请先执行 vmr record，或加 --auto-record。`);
      }
    }
  }

  const ctx2 = await createSideContext(cc.browser, cfg, 'v2', clog);
  const ctx3 = await createSideContext(cc.browser, cfg, 'v3', clog);
  try {
    const [p2, p3] = await Promise.all([ctx2.newPage(), ctx3.newPage()]);
    const net2 = new NetLayer('v2', pageCfg, cfg, opts.mode === 'replay' ? 'replay' : 'live', store2, clog);
    const net3 = new NetLayer('v3', pageCfg, cfg, opts.mode === 'replay' ? 'replay' : 'live', store3, clog);
    await Promise.all([net2.attach(p2), net3.attach(p3)]);
    const s2: SideCtx = { side: 'v2', page: p2, net: net2 };
    const s3: SideCtx = { side: 'v3', page: p3, net: net3 };

    // 双端同刻加载与筛选（live 模式对齐每一步；replay 下并行同样安全）
    await Promise.all([
      p2.goto(pageUrl(cfg, pageCfg, 'v2'), { waitUntil: 'commit' }),
      p3.goto(pageUrl(cfg, pageCfg, 'v3'), { waitUntil: 'commit' }),
    ]);
    await Promise.all([
      waitReady(p2, pageCfg, cfg, clog, { apiDoneCheck: net2.apiDoneCheck }),
      waitReady(p3, pageCfg, cfg, clog, { apiDoneCheck: net3.apiDoneCheck }),
    ]);
    await Promise.all([applyCombo(p2, pageCfg, combo, clog), applyCombo(p3, pageCfg, combo, clog)]);
    await Promise.all([
      waitReady(p2, pageCfg, cfg, clog, { apiDoneCheck: net2.apiDoneCheck }),
      waitReady(p3, pageCfg, cfg, clog, { apiDoneCheck: net3.apiDoneCheck }),
    ]);

    const allMetricDefs = new Map<string, MetricDef>(pageCfg.metrics.map(m => [m.id, m]));
    for (const i of pageCfg.interactions) for (const m of i.extraMetrics) allMetricDefs.set(m.id, m);

    const extractBoth = async (m: MetricDef): Promise<{ v2?: MetricValue; v3?: MetricValue; errs: Partial<Record<Side, string>> }> => {
      const errs: Partial<Record<Side, string>> = {};
      const [a, b] = await Promise.all([
        extractMetric(p2, m, { net: net2, vl }).catch(e => { errs.v2 = String(e instanceof Error ? e.message : e); return undefined; }),
        extractMetric(p3, m, { net: net3, vl }).catch(e => { errs.v3 = String(e instanceof Error ? e.message : e); return undefined; }),
      ]);
      return { v2: a, v3: b, errs };
    };

    const compareMetricIds = async (ids: string[], scopeNote?: string) => {
      for (const id of ids) {
        const m = allMetricDefs.get(id);
        if (!m) { findings.push({ type: 'tool-error', layer: 'metric', id, message: `配置引用了不存在的指标 ${id}` }); continue; }
        const { v2, v3, errs } = await extractBoth(m);
        if (errs.v2 || errs.v3) {
          findings.push({ type: 'tool-error', layer: 'metric', id, message: `指标提取失败${scopeNote ?? ''}：${errs.v2 ? 'v2:' + errs.v2 : ''} ${errs.v3 ? 'v3:' + errs.v3 : ''}`.trim() });
          metricRows.push({ id, name: m.name || id, v2: errs.v2 ? '(提取失败)' : v2, v3: errs.v3 ? '(提取失败)' : v3, equal: false, note: '提取失败' });
          continue;
        }
        const r = compareMetric(v2!, v3!, m, cfg);
        metricRows.push({ id, name: m.name || id, v2, v3, equal: r.equal, note: r.note });
        if (!r.equal) {
          findings.push({ type: 'render-bug', layer: 'metric', id, message: `指标「${m.name || id}」双端不一致${r.note ? '（' + r.note + '）' : ''}${scopeNote ?? ''}`, v2, v3 });
        }
      }
    };

    if (!opts.perfOnly) {
      // ① 数据层：页面级指标
      await compareMetricIds(pageCfg.metrics.map(m => m.id));
      // ③ 视觉层：整页
      const shot2 = join(artifactDir, 'page.v2.png');
      const shot3 = join(artifactDir, 'page.v3.png');
      await Promise.all([takeShot(p2, pageCfg, cfg, shot2), takeShot(p3, pageCfg, cfg, shot3)]);
      const vres = await visualCompare('page', shot2, shot3, artifactDir, pageCfg, cfg, vl, clog);
      shots.push({ label: '整页', v2: join(artifactRel, 'page.v2.png'), v3: join(artifactRel, 'page.v3.png'), diff: join(artifactRel, 'page.diff.png'), ratio: vres.ratio });
      if (vres.finding) findings.push(vres.finding);
      // ② 网络层：API 配对比对
      const apiRes = diffApiPairs(pageCfg, net2.captured, net3.captured, opts.mode === 'replay' ? 'replay' : 'live');
      findings.push(...apiRes.findings);
      // ④ 交互层
      for (const inter of pageCfg.interactions) {
        net2.mark(); net3.mark();
        const interFindings = await runInteraction(inter, s2, s3, pageCfg, cfg, clog, async (step, idx) => {
          const fs: Finding[] = [];
          const before = findings.length + fs.length;
          if (step.metrics?.length) {
            const cur = findings.length;
            await compareMetricIds(step.metrics, `（交互 ${inter.name || inter.id}）`);
            fs.push(...findings.splice(cur));
          }
          if (step.visual) {
            const lb = `${inter.id}-${idx}`;
            const a = join(artifactDir, `${lb}.v2.png`);
            const b = join(artifactDir, `${lb}.v3.png`);
            await Promise.all([
              takeShot(p2, pageCfg, cfg, a, step.scope),
              takeShot(p3, pageCfg, cfg, b, step.scope),
            ]);
            const vr = await visualCompare(lb, a, b, artifactDir, pageCfg, cfg, vl, clog);
            shots.push({ label: `${inter.name || inter.id}`, v2: join(artifactRel, `${lb}.v2.png`), v3: join(artifactRel, `${lb}.v3.png`), diff: join(artifactRel, `${lb}.diff.png`), ratio: vr.ratio });
            if (vr.finding) fs.push(vr.finding);
          }
          if (step.api) {
            const r = diffApiPairs(pageCfg, net2.sinceMark(), net3.sinceMark(), opts.mode === 'replay' ? 'replay' : 'live');
            fs.push(...r.findings);
          }
          void before;
          return fs;
        });
        findings.push(...interFindings);
      }
      // live 漂移归因：源数据不同导致的指标差异降级为黄色
      if (opts.mode === 'live' && apiRes.driftDetected) {
        for (const f of findings) {
          if (f.type === 'render-bug' && f.layer === 'metric') {
            f.type = 'data-drift';
            f.message += '（检测到双端 API 响应存在实时数据漂移，本差异不计缺陷；如需权威判定请用 replay 模式）';
          }
        }
      }
    }

    // 性能（仅默认组合触发，避免组合遍历时时长爆炸）
    let perf: CaseResult['perf'];
    const isDefaultCombo = ck === comboKey(Object.fromEntries(pageCfg.filters.map(f => [f.key, f.default])));
    if ((opts.perf || opts.perfOnly) && isDefaultCombo) {
      clog.info('开始性能采样（ABAB 交替）…');
      perf = await measurePerf(cc.browser, cfg, pageCfg, combo, ck, opts.mode, clog);
      for (const m of perf.metrics) {
        if (m.regressed) {
          findings.push({
            type: 'perf-regression', layer: 'perf', id: m.metric,
            message: `性能退化：${m.metric} 中位数 v2=${m.v2.median.toFixed(0)}ms → v3=${m.v3.median.toFixed(0)}ms（×${m.ratio}，+${m.deltaMs}ms）`,
          });
        }
      }
    }

    const result: CaseResult = {
      caseId, pageId: pageCfg.id, pageName: pageCfg.name, comboKey: ck, combo,
      status: statusOf(findings), findings, shots, metrics: metricRows, perf,
      durationMs: Date.now() - t0, startedAt, artifactDir: artifactRel,
    };
    writeFileSync(join(artifactDir, 'case.json'), JSON.stringify(result, null, 1));
    return result;
  } finally {
    await Promise.all([ctx2.close().catch(() => undefined), ctx3.close().catch(() => undefined)]);
  }
}

/** 二次确认包装：红色结论复跑一次，一致才定论，不一致标记 flaky */
async function execCaseConfirmed(cc: CaseCtx, pageCfg: PageConfig, combo: Combo, ck: string): Promise<CaseResult> {
  const first = await execCaseOnce(cc, pageCfg, combo, ck);
  if (first.status !== 'fail' || !cc.opts.confirm) return first;
  cc.log.info(`[${first.caseId}] 检出缺陷，进行二次确认复跑…`);
  const second = await execCaseOnce(cc, pageCfg, combo, ck);
  if (redKeySet(first.findings) === redKeySet(second.findings)) {
    second.confirmed = true;
  } else {
    second.findings.push({ type: 'flaky', layer: 'tool', id: 'confirm', message: '两次运行的缺陷结论不一致，判定为不稳定用例，请人工复核（保留第二次结果）' });
    second.status = statusOf(second.findings);
    second.confirmed = false;
  }
  // 回写最终结论：execCaseOnce 内部写 case.json 早于 confirmed 赋值，此处以定论覆盖
  if (second.artifactDir) {
    writeFileSync(join(cc.runDir, second.artifactDir, 'case.json'), JSON.stringify(second, null, 1));
  }
  return second;
}

export async function recordAll(configPath: string, combo: ComboStrategy, maxCases: number, seed: number, pagesFilter?: string[]) {
  const { loadConfig } = await import('../config/load.js');
  const cfg = loadConfig(configPath);
  const log = new Logger();
  const browser = await launchBrowser(cfg, log);
  const cc: CaseCtx = { browser, cfg, opts: {} as RunOptions, runDir: '', vl: null, log };
  try {
    for (const pageCfg of cfg.pages.filter(p => !pagesFilter?.length || pagesFilter.includes(p.id))) {
      // 自动发现（仅在配置了 discover 且未显式枚举时）
      if (pageCfg.filters.some(f => f.discover && !f.values.length)) {
        const dctx = await createSideContext(browser, cfg, 'v2', log);
        const dpage = await dctx.newPage();
        await dpage.goto(pageUrl(cfg, pageCfg, 'v2'), { waitUntil: 'commit' }).catch(() => undefined);
        await waitReady(dpage, pageCfg, cfg, log).catch(() => undefined);
        await discoverOptions(dpage, pageCfg, log);
        await dctx.close();
      }
      const combos = buildCombos(pageCfg, combo, maxCases, seed);
      log.info(`录制页面 ${pageCfg.id}（${pageCfg.name}）：${combos.list.length} 个组合`);
      for (const c of combos.list) {
        const ck = comboKey(c);
        const n = await recordCase(cc, pageCfg, c, ck);
        log.info(`  组合 ${ck}：${n} 个接口签名`);
      }
    }
  } finally { await browser.close(); }
}

export async function runAll(opts: RunOptions): Promise<RunResults> {
  const { loadConfig } = await import('../config/load.js');
  const cfg = loadConfig(opts.configPath);
  const runId = opts.resume ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = ensureDir(join(process.cwd(), 'runs', runId));
  const log = runLogger(runDir);
  const vl = VlClient.fromEnv(cfg, log);
  const notes: string[] = [];
  log.info(`运行 ${runId}｜模式=${opts.mode}｜组合策略=${opts.combo}｜seed=${opts.seed}｜VL=${vl ? '已启用' : '未启用（视觉差异将标记待人工复核）'}`);
  if (!vl) notes.push('Qwen2.5-VL 未启用（未设置 VL_BASE_URL 环境变量），超阈值视觉差异统一记为 visual-pending 待人工复核。');
  if (opts.mode === 'live') notes.push('live 模式：双端同刻执行；检测到 API 数据漂移时，数值差异自动降级为 data-drift（黄色），权威判定请使用 replay 模式。');

  const statePath = join(runDir, 'state.json');
  const state: { done: Record<string, string> } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { done: {} };
  const prevCases: CaseResult[] = [];
  if (opts.resume && existsSync(join(runDir, 'results.json'))) {
    prevCases.push(...(JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as RunResults).cases);
    log.info(`断点续跑：已完成 ${prevCases.length} 个用例，跳过继续`);
  }

  const browser = await launchBrowser(cfg, log);
  const cc: CaseCtx = { browser, cfg, opts, runDir, vl, log };
  const startedAt = nowIso();
  const cases: CaseResult[] = [...prevCases];
  const limit = pLimit(Math.max(1, opts.workers));
  try {
    const pages = cfg.pages.filter(p => !opts.pages?.length || opts.pages.includes(p.id));
    if (!pages.length) throw new Error('没有匹配 --pages 的页面');
    await Promise.all(pages.map(pageCfg => limit(async () => {
      // 自动发现选项（仅影响本进程内的配置副本）
      if (pageCfg.filters.some(f => f.discover && !f.values.length)) {
        try {
          const dctx = await createSideContext(browser, cfg, 'v2', log);
          const dpage = await dctx.newPage();
          await dpage.goto(pageUrl(cfg, pageCfg, 'v2'), { waitUntil: 'commit' });
          await waitReady(dpage, pageCfg, cfg, log).catch(() => undefined);
          await discoverOptions(dpage, pageCfg, log);
          await dctx.close();
        } catch { /* 发现失败不阻塞 */ }
      }
      const combos = buildCombos(pageCfg, opts.combo, opts.maxCases, opts.seed);
      if (combos.capped) notes.push(`页面 ${pageCfg.id} 组合数 ${combos.totalBeforeCap} 超过上限，已截断为 ${combos.list.length}（--max-cases 可调）。`);
      log.info(`页面 ${pageCfg.id}（${pageCfg.name}）：${combos.list.length} 个组合`);
      for (const c of combos.list) {
        const ck = comboKey(c);
        const caseId = `${pageCfg.id}__${ck}`;
        if (state.done[caseId]) { log.info(`跳过已完成用例 ${caseId}`); continue; }
        let result: CaseResult;
        try {
          result = await execCaseConfirmed(cc, pageCfg, c, ck);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result = {
            caseId, pageId: pageCfg.id, pageName: pageCfg.name, comboKey: ck, combo: c,
            status: 'error', metrics: [], shots: [], durationMs: 0, startedAt: nowIso(), artifactDir: '',
            findings: [{ type: 'tool-error', layer: 'tool', id: e instanceof ToolError ? e.id : 'unknown', message: msg }],
          };
          log.error(`[${caseId}] 用例异常：${msg}`);
        }
        cases.push(result);
        state.done[caseId] = result.status;
        writeFileSync(statePath, JSON.stringify(state, null, 1));
        log.info(`[${caseId}] ${result.status.toUpperCase()}｜发现 ${result.findings.length} 条｜耗时 ${(result.durationMs / 1000).toFixed(1)}s`);
      }
    })));
  } finally { await browser.close(); }

  const byType: Record<string, number> = {};
  for (const c of cases) for (const f of c.findings) byType[f.type] = (byType[f.type] ?? 0) + 1;
  const summary = {
    total: cases.length,
    pass: cases.filter(c => c.status === 'pass').length,
    warn: cases.filter(c => c.status === 'warn').length,
    fail: cases.filter(c => c.status === 'fail').length,
    error: cases.filter(c => c.status === 'error').length,
    byType,
  };
  const exitCode = summary.fail > 0 ? 1 : summary.error > 0 ? 2 : 0;
  const results: RunResults = {
    runId, mode: opts.mode, combo: opts.combo, seed: opts.seed, startedAt, finishedAt: nowIso(),
    configPath: opts.configPath, baseUrl: cfg.global.baseUrl, cases, summary, exitCode, notes: [...new Set(notes)],
  };
  writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 1));
  generateHtmlReport(results, runDir);
  if (opts.junit) generateJUnit(results, runDir);
  log.info(`完成：${summary.pass} 通过 / ${summary.warn} 告警 / ${summary.fail} 缺陷 / ${summary.error} 工具错误 → 报告 runs/${runId}/report.html`);
  return results;
}

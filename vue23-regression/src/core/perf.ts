import type { Browser } from 'playwright';
import type { Config, PageConfig } from '../config/load.js';
import type { PerfMetricResult, PerfResult, Side } from '../types.js';
import { createSideContext, pageUrl, waitReady } from './session.js';
import { NetLayer, RecordStore } from './net.js';
import { execStep, type SideCtx } from './interact.js';
import { median, percentile } from '../util/misc.js';
import type { Logger } from '../util/log.js';
import type { Combo } from './combos.js';
import { applyCombo } from './interact_filters.js';

type SampleMetrics = Record<string, number>;

async function sampleOnce(
  browser: Browser, cfg: Config, pageCfg: PageConfig, side: Side, combo: Combo,
  mode: 'replay' | 'live', recDir: string, log: Logger,
): Promise<SampleMetrics> {
  const ctx = await createSideContext(browser, cfg, side, log);
  const page = await ctx.newPage();
  const store = mode === 'replay' ? new RecordStore(recDir) : null;
  store?.load();
  const net = new NetLayer(side, pageCfg, cfg, mode === 'replay' ? 'replay' : 'live', store, log);
  await net.attach(page);
  if (cfg.global.perf.cpuThrottle > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.global.perf.cpuThrottle }).catch(() => undefined);
  }
  const t0 = Date.now();
  try {
    await page.goto(pageUrl(cfg, pageCfg, side), { waitUntil: 'commit', timeout: cfg.global.waits.readyTimeoutMs });
    if (Object.keys(combo).length) {
      await waitReady(page, pageCfg, cfg, log, { apiDoneCheck: net.apiDoneCheck });
      await applyCombo(page, pageCfg, combo, log);
    }
    await waitReady(page, pageCfg, cfg, log, { apiDoneCheck: net.apiDoneCheck });
    const readyTime = Date.now() - t0;
    const inPage = await page.evaluate(() => {
      const w = window as unknown as { __vmr?: { perf: { fcp: number; lcp: number; longTasksTotal: number } } };
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return {
        fcp: w.__vmr?.perf.fcp ?? 0,
        lcp: w.__vmr?.perf.lcp ?? 0,
        longTasksTotal: w.__vmr?.perf.longTasksTotal ?? 0,
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : 0,
        load: nav ? nav.loadEventEnd : 0,
      };
    });
    const out: SampleMetrics = { ...inPage, readyTime, apiTotal: net.apiTotalMs() };
    // 交互耗时：按配置逐个执行（跳过 compare），计"动作→就绪"时长
    const sideCtx: SideCtx = { side, page, net };
    for (const iid of pageCfg.perf.interactions) {
      const inter = pageCfg.interactions.find(x => x.id === iid);
      if (!inter) continue;
      const s0 = Date.now();
      for (const st of inter.steps) {
        if ((st as { do: string }).do === 'compare') continue;
        const o = await execStep(st, sideCtx, pageCfg, cfg, log);
        if (!o.ok) { log.warn(`[perf][${side}] 交互 ${iid} 步骤失败，计为超时样本`); break; }
      }
      out[`interaction:${iid}`] = Date.now() - s0;
    }
    return out;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/** ABAB 交替采样并做双条件退化判定（任务书 D5） */
export async function measurePerf(
  browser: Browser, cfg: Config, pageCfg: PageConfig, combo: Combo, comboKey: string,
  mode: 'replay' | 'live', log: Logger,
): Promise<PerfResult> {
  const P = { ...cfg.global.perf, ...Object.fromEntries(Object.entries(pageCfg.perf).filter(([, v]) => v !== undefined && !Array.isArray(v))) } as typeof cfg.global.perf;
  const recDir = RecordStore.dirFor(process.cwd(), pageCfg.id, comboKey);
  const total = P.warmup + P.samples;
  const acc: Record<Side, SampleMetrics[]> = { v2: [], v3: [] };
  for (let i = 0; i < total; i++) {
    for (const side of ['v2', 'v3'] as Side[]) {
      const m = await sampleOnce(browser, cfg, pageCfg, side, combo, mode, recDir, log);
      if (i >= P.warmup) acc[side].push(m);
      log.debug(`[perf] 第 ${i + 1}/${total} 轮 ${side} readyTime=${m.readyTime}ms`);
    }
  }
  const names = [...P.metrics, ...pageCfg.perf.interactions.map(i => `interaction:${i}`)];
  const metrics: PerfMetricResult[] = names.map(name => {
    const xs2 = acc.v2.map(s => s[name] ?? 0);
    const xs3 = acc.v3.map(s => s[name] ?? 0);
    const m2 = median(xs2), m3 = median(xs3);
    const deltaMs = m3 - m2;
    const ratio = m2 > 0 ? m3 / m2 : (m3 > 0 ? Infinity : 1);
    const regressed = ratio > P.maxRatio && deltaMs > P.minAbsMs;
    return {
      metric: name,
      v2: { median: m2, p75: percentile(xs2, 75), samples: xs2 },
      v3: { median: m3, p75: percentile(xs3, 75), samples: xs3 },
      regressed, ratio: Number(ratio.toFixed(3)), deltaMs: Math.round(deltaMs),
    };
  });
  return { metrics, samples: P.samples, warmup: P.warmup };
}

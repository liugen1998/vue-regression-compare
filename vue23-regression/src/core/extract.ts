import type { Page } from 'playwright';
import type { Config, MetricDef, PageConfig } from '../config/load.js';
import type { NetLayer } from './net.js';
import { echartsGetOptionPath, hoverSweep } from './echarts.js';
import { jsonPathGet, urlMatch } from '../util/misc.js';
import { ToolError } from '../types.js';
import type { VlClient } from './visual.js';

const PLACEHOLDERS = new Set(['-', '--', '—', '－', 'n/a', 'na', 'null', 'undefined', '暂无', '暂无数据', '']);
const UNIT_MULTIPLIER: Record<string, number> = { 万: 1e4, 亿: 1e8, w: 1e4, k: 1e3, K: 1e3 };

export type MetricValue = string | number | null | Array<string | number | null>;

/** 单值归一化流水线 */
export function normalizeScalar(raw: unknown, steps: string[]): string | number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (PLACEHOLDERS.has(s.toLowerCase())) return null;
  for (const st of steps) {
    if (st === 'stripComma') s = s.replace(/[,，\s]/g, '');
    else if (st === 'stripSpace') s = s.replace(/\s+/g, '');
    else if (st === 'stripUnit') {
      const m = s.match(/^(-?[\d.,]+)\s*([万亿wkK])?\s*[^\d]*$/);
      if (m) {
        const base = Number(m[1].replace(/,/g, ''));
        s = String(m[2] ? base * UNIT_MULTIPLIER[m[2]] : base);
      }
    } else if (st === 'percent') {
      const m = s.match(/^(-?[\d.,]+)\s*%$/);
      if (m) s = String(Number(m[1].replace(/,/g, '')) / 100);
    } else if (st === 'lower') s = s.toLowerCase();
  }
  const n = Number(s.replace(/,/g, ''));
  return s !== '' && !Number.isNaN(n) && /^-?[\d.,]+(e-?\d+)?$/i.test(s.replace(/,/g, '')) ? n : s;
}

export function normalizeValue(raw: unknown, steps: string[]): MetricValue {
  if (Array.isArray(raw)) return raw.map(x => normalizeScalar(x, steps));
  return normalizeScalar(raw, steps);
}

export interface ExtractCtx { net: NetLayer; vl?: VlClient | null; artifactDir?: string }

/** 提取单个指标（单端） */
export async function extractMetric(page: Page, metric: MetricDef, ctx: ExtractCtx): Promise<MetricValue> {
  switch (metric.type) {
    case 'dom-text': {
      if (!metric.selector) throw new ToolError('config', `指标 ${metric.id} 缺少 selector`);
      const loc = page.locator(metric.selector);
      if (metric.all) {
        const texts = await loc.allInnerTexts();
        return normalizeValue(texts, metric.normalize);
      }
      await loc.first().waitFor({ state: 'visible', timeout: 8000 })
        .catch(() => { throw new ToolError('selector', `指标 ${metric.id} 选择器不可见：${metric.selector}`); });
      return normalizeValue(await loc.first().innerText(), metric.normalize);
    }
    case 'echarts': {
      if (!metric.chart || !metric.pick) throw new ToolError('config', `指标 ${metric.id} 需要 chart 与 pick`);
      const r = await echartsGetOptionPath(page, metric.chart, metric.pick);
      if (!r.ok) throw new ToolError('echarts-l1', `指标 ${metric.id}：${r.reason}`);
      return normalizeValue(r.value, metric.normalize);
    }
    case 'tooltip-sweep': {
      if (!metric.chart) throw new ToolError('config', `指标 ${metric.id} 需要 chart`);
      const texts = await hoverSweep(page, metric.chart, metric.points ?? 6);
      return normalizeValue(texts, metric.normalize);
    }
    case 'api-field': {
      if (!metric.request || !metric.path) throw new ToolError('config', `指标 ${metric.id} 需要 request 与 path`);
      const hit = [...ctx.net.captured].reverse().find(c => urlMatch(c.url, [metric.request!]) && c.bodyText);
      if (!hit) throw new ToolError('api-missing', `指标 ${metric.id}：未捕获到匹配请求 ${metric.request}`);
      try {
        const v = jsonPathGet(JSON.parse(hit.bodyText!), metric.path);
        return normalizeValue(v, metric.normalize);
      } catch { throw new ToolError('api-parse', `指标 ${metric.id}：响应非 JSON 或取值失败`); }
    }
    case 'vl-read': {
      if (!ctx.vl) throw new ToolError('vl-off', `指标 ${metric.id}：VL 未启用（设置 VL_BASE_URL 后可用）`);
      if (!metric.region || !metric.question) throw new ToolError('config', `指标 ${metric.id} 需要 region 与 question`);
      const buf = await page.locator(metric.region).first().screenshot();
      const ans = await ctx.vl.read(buf, metric.question);
      return normalizeValue(ans, metric.normalize);
    }
  }
}

export interface CompareResult { equal: boolean; note?: string }

function numEq(a: number, b: number, abs: number, relPct: number): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  if (d <= abs) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base > 0 && (d / base) * 100 <= relPct;
}

export function compareMetric(v2: MetricValue, v3: MetricValue, metric: MetricDef, cfg: Config): CompareResult {
  const abs = metric.toleranceAbs ?? cfg.global.tolerance.numberAbs;
  const rel = metric.toleranceRelPct ?? cfg.global.tolerance.numberRelPct;
  const one = (a: string | number | null, b: string | number | null): boolean => {
    if (a === null && b === null) return true;
    if (typeof a === 'number' && typeof b === 'number') return numEq(a, b, abs, rel);
    return String(a) === String(b);
  };
  if (Array.isArray(v2) || Array.isArray(v3)) {
    const A = Array.isArray(v2) ? v2 : [v2];
    const B = Array.isArray(v3) ? v3 : [v3];
    if (A.length !== B.length) return { equal: false, note: `长度不一致（v2=${A.length}，v3=${B.length}）` };
    for (let i = 0; i < A.length; i++) if (!one(A[i], B[i])) return { equal: false, note: `第 ${i + 1} 项不一致` };
    return { equal: true };
  }
  return { equal: one(v2, v3) };
}

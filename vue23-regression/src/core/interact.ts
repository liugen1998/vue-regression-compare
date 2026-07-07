import type { Page } from 'playwright';
import type { Config, InteractionDef, PageConfig, StepDef } from '../config/load.js';
import type { Finding, Side } from '../types.js';
import { ToolError } from '../types.js';
import { echartsClick, hoverSweep, type EChartsClickCfg } from './echarts.js';
import { waitReady } from './session.js';
import { normalizeValue } from './extract.js';
import type { NetLayer } from './net.js';
import type { Logger } from '../util/log.js';
import { globToRegExp } from '../util/misc.js';

export interface SideCtx { side: Side; page: Page; net: NetLayer }
export interface StepOutcome { ok: boolean; url?: string; err?: string; tooltips?: string[] }

interface AnyStep {
  do: string; selector?: string; text?: string; label?: string; option?: string;
  chart?: string; dataIndex?: number; seriesIndex?: number; relX?: number; relY?: number;
  points?: number; urlPattern?: string; compare?: string; tooltipSelector?: string;
  metrics?: string[]; visual?: boolean; scope?: string; api?: boolean; normalize?: string[];
}

/** 单端执行一个非 compare 步骤 */
export async function execStep(step: StepDef, ctx: SideCtx, pageCfg: PageConfig, cfg: Config, log: Logger): Promise<StepOutcome> {
  const s = step as AnyStep;
  const p = ctx.page;
  try {
    switch (s.do) {
      case 'click': await p.click(s.selector!, { timeout: 8000 }); return { ok: true };
      case 'fill': await p.fill(s.selector!, s.text ?? ''); return { ok: true };
      case 'hover': await p.hover(s.selector!, { timeout: 8000 }); return { ok: true };
      case 'select': await p.selectOption(s.selector!, { label: s.option ?? s.label ?? '' }); return { ok: true };
      case 'waitReady': await waitReady(p, pageCfg, cfg, log, { apiDoneCheck: ctx.net.apiDoneCheck }); return { ok: true };
      case 'echartsClick': {
        const lvl = await echartsClick(p, s as EChartsClickCfg, log);
        log.debug(`[${ctx.side}] echartsClick 走 ${lvl}`);
        return { ok: true };
      }
      case 'echartsHoverSweep': {
        const tips = await hoverSweep(p, s.chart!, s.points ?? 6, s.tooltipSelector);
        return { ok: true, tooltips: tips };
      }
      case 'expectNav': {
        await p.waitForURL(u => globToRegExp(s.urlPattern!.includes('://') ? s.urlPattern! : '**' + s.urlPattern!).test(String(u).split('#')[0]), { timeout: 10000 });
        await waitReady(p, pageCfg, cfg, log, { apiDoneCheck: ctx.net.apiDoneCheck, generic: true });
        return { ok: true, url: p.url() };
      }
      case 'expectModal': {
        await p.waitForSelector(s.selector!, { state: 'visible', timeout: 8000 });
        await waitReady(p, pageCfg, cfg, log, { apiDoneCheck: ctx.net.apiDoneCheck, generic: true });
        return { ok: true };
      }
      case 'closeModal': await p.click(s.selector!, { timeout: 8000 }); return { ok: true };
      case 'goBack': {
        await p.goBack({ timeout: 10000 });
        await waitReady(p, pageCfg, cfg, log, { apiDoneCheck: ctx.net.apiDoneCheck, generic: true });
        return { ok: true };
      }
      case 'screenshot': return { ok: true }; // 由 runner 的 compare 截图承担，此处保留兼容
      default: throw new ToolError('config', `未知交互步骤类型：${s.do}`);
    }
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/** URL 一致性归一：忽略主机与版本前缀差异，比较末段文件名 + 排序后的 query */
export function navUrlKey(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const qs = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    return `${last}?${qs}`;
  } catch { return url; }
}

export type CompareHook = (step: AnyStep, stepIdx: number) => Promise<Finding[]>;

/** 双端逐步对齐执行一个交互，返回 findings（compare 步骤经 hook 委托给 runner） */
export async function runInteraction(
  inter: InteractionDef, v2: SideCtx, v3: SideCtx, pageCfg: PageConfig, cfg: Config, log: Logger, compareHook: CompareHook,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (let i = 0; i < inter.steps.length; i++) {
    const s = inter.steps[i] as AnyStep;
    if (s.do === 'compare') {
      findings.push(...await compareHook(s, i));
      continue;
    }
    const [o2, o3] = await Promise.all([
      execStep(inter.steps[i], v2, pageCfg, cfg, log),
      execStep(inter.steps[i], v3, pageCfg, cfg, log),
    ]);
    if (!o2.ok && !o3.ok) {
      findings.push({ type: 'tool-error', layer: 'interaction', id: `${inter.id}#${i}`, message: `双端步骤 ${s.do} 均失败（多为配置/选择器问题）：${o2.err}`, extra: { step: s } });
      return findings; // 后续步骤依赖前置状态，终止本交互
    }
    if (o2.ok !== o3.ok) {
      const bad = o2.ok ? 'Vue3' : 'Vue2';
      findings.push({ type: 'interaction-fail', layer: 'interaction', id: `${inter.id}#${i}`, message: `${bad} 侧无法完成步骤 ${s.do}（元素缺失或行为不一致）：${(o2.ok ? o3 : o2).err}`, extra: { step: s } });
      return findings;
    }
    if (s.do === 'expectNav' && o2.url && o3.url && navUrlKey(o2.url) !== navUrlKey(o3.url)) {
      findings.push({ type: 'interaction-fail', layer: 'interaction', id: `${inter.id}#${i}`, message: `下钻目标不一致`, v2: o2.url, v3: o3.url });
    }
    if (s.do === 'echartsHoverSweep' && o2.tooltips && o3.tooltips) {
      const norm = (arr: string[]) => arr.map(t => normalizeValue(t.replace(/\s+/g, ' '), s.normalize ?? []));
      const a = norm(o2.tooltips), b = norm(o3.tooltips);
      const bads: number[] = [];
      for (let k = 0; k < Math.max(a.length, b.length); k++) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) bads.push(k + 1);
      if (bads.length) {
        findings.push({
          type: 'render-bug', layer: 'interaction', id: `${inter.id}#hover`,
          message: `悬停提示不一致（采样点 ${bads.join('、')}）`,
          v2: o2.tooltips, v3: o3.tooltips,
        });
      }
    }
  }
  return findings;
}

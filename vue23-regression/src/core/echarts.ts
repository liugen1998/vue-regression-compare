import type { Page } from 'playwright';
import { ToolError } from '../types.js';
import { sleep } from '../util/misc.js';

/** L1：经 window.echarts.getInstanceByDom 取 option 指定路径 */
export async function echartsGetOptionPath(page: Page, chartSel: string, pick: string): Promise<{ ok: boolean; value?: unknown; reason?: string }> {
  return page.evaluate(({ sel, pick }) => {
    const pickFn = (opt: unknown, path: string): unknown => {
      const segs = path.match(/[\w$]+|\[\d+\]/g) || [];
      let cur: unknown = opt;
      for (const sg of segs) {
        if (cur == null) return undefined;
        const o = cur as Record<string, unknown> & unknown[];
        cur = sg.startsWith('[') ? o[Number(sg.slice(1, -1))] : o[sg as keyof typeof o];
      }
      return cur;
    };
    const w = window as unknown as { echarts?: { getInstanceByDom: (el: Element) => { getOption: () => unknown } | undefined } };
    if (!w.echarts) return { ok: false, reason: 'window.echarts 不存在（L1 不可用）' };
    const root = document.querySelector(sel);
    if (!root) return { ok: false, reason: `选择器无匹配：${sel}` };
    const el = root.hasAttribute('_echarts_instance_') ? root : root.querySelector('[_echarts_instance_]') ?? root;
    const inst = w.echarts.getInstanceByDom(el);
    if (!inst) return { ok: false, reason: '未取到 ECharts 实例' };
    try { return { ok: true, value: pickFn(inst.getOption(), pick) }; }
    catch (e) { return { ok: false, reason: '取值失败：' + String(e) }; }
  }, { sel: chartSel, pick });
}

/** L1：数据点像素坐标（页面绝对坐标）。失败返回 null。 */
async function dataPointPixel(page: Page, chartSel: string, seriesIndex: number, dataIndex: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(({ sel, seriesIndex, dataIndex }) => {
    const w = window as unknown as {
      echarts?: { getInstanceByDom: (el: Element) => { getOption: () => Record<string, unknown>; convertToPixel: (f: unknown, v: unknown) => number[] } | undefined };
    };
    if (!w.echarts) return null;
    const root = document.querySelector(sel);
    if (!root) return null;
    const el = root.hasAttribute('_echarts_instance_') ? root : root.querySelector('[_echarts_instance_]') ?? root;
    const inst = w.echarts.getInstanceByDom(el);
    if (!inst) return null;
    try {
      const opt = inst.getOption() as { series?: Array<{ data?: unknown[] }> };
      const raw = opt.series?.[seriesIndex]?.data?.[dataIndex];
      const val = typeof raw === 'object' && raw !== null && 'value' in (raw as object) ? (raw as { value: unknown }).value : raw;
      const px = inst.convertToPixel({ seriesIndex }, [dataIndex, Number(val)]);
      if (!px) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + px[0], y: r.top + px[1] };
    } catch { return null; }
  }, { sel: chartSel, seriesIndex, dataIndex });
}

export interface EChartsClickCfg { chart: string; dataIndex?: number; seriesIndex?: number; relX?: number; relY?: number }

/** 点击数据点：L1 convertToPixel → 真实鼠标点击；L2 relX/relY 相对坐标兜底 */
export async function echartsClick(page: Page, cfg: EChartsClickCfg, log?: { debug: (m: string) => void }): Promise<'L1' | 'L2'> {
  if (cfg.dataIndex !== undefined) {
    const pt = await dataPointPixel(page, cfg.chart, cfg.seriesIndex ?? 0, cfg.dataIndex);
    if (pt) {
      await page.mouse.click(pt.x, pt.y + 4); // 柱顶稍下方，确保命中图形
      log?.debug(`echartsClick L1 命中 (${pt.x.toFixed(0)},${pt.y.toFixed(0)})`);
      return 'L1';
    }
  }
  if (cfg.relX !== undefined && cfg.relY !== undefined) {
    const box = await page.locator(cfg.chart).first().boundingBox();
    if (!box) throw new ToolError('echarts-locate', `图表不可见：${cfg.chart}`);
    await page.mouse.click(box.x + box.width * cfg.relX, box.y + box.height * cfg.relY);
    log?.debug('echartsClick L2 相对坐标命中');
    return 'L2';
  }
  throw new ToolError('echarts-locate', `无法定位图表数据点（L1 实例不可用且未提供 relX/relY 兜底）：${cfg.chart}`);
}

/** tooltip 启发式抓取：容器内 position:absolute 且可见、有文本的 div，取最后一个 */
async function readTooltip(page: Page, chartSel: string, tooltipSelector?: string): Promise<string> {
  return page.evaluate(({ sel, tip }) => {
    const root = document.querySelector(sel);
    if (!root) return '';
    const scope = tip ? document : root;
    const cands = Array.from(scope.querySelectorAll(tip || 'div')).filter(d => {
      const el = d as HTMLElement;
      if (tip) return el.offsetWidth > 0 && !!el.textContent?.trim();
      const st = el.style;
      return st.position === 'absolute' && el.offsetWidth > 0 && st.visibility !== 'hidden' && !!el.textContent?.trim() && !el.querySelector('canvas');
    }) as HTMLElement[];
    const last = cands[cands.length - 1];
    return last ? (last.innerText || last.textContent || '').trim() : '';
  }, { sel: chartSel, tip: tooltipSelector });
}

/** 悬停扫描：横向 N 等分采样 tooltip 文本（两端使用完全相同的采样点） */
export async function hoverSweep(page: Page, chartSel: string, points: number, tooltipSelector?: string): Promise<string[]> {
  const box = await page.locator(chartSel).first().boundingBox();
  if (!box) throw new ToolError('echarts-locate', `图表不可见：${chartSel}`);
  const out: string[] = [];
  for (let i = 0; i < points; i++) {
    const x = box.x + box.width * ((i + 0.5) / points);
    const y = box.y + box.height * 0.45;
    await page.mouse.move(x, y, { steps: 3 });
    await sleep(280);
    out.push(await readTooltip(page, chartSel, tooltipSelector));
  }
  await page.mouse.move(2, 2); // 移开，避免残留 tooltip 影响截图
  await sleep(150);
  return out;
}

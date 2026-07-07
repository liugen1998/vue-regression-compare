import type { Page } from 'playwright';
import type { Config, FilterDef, PageConfig } from '../config/load.js';
import type { Combo } from './combos.js';
import { ToolError } from '../types.js';
import type { Logger } from '../util/log.js';

function pickValue(f: FilterDef, label: string) {
  const v = f.values.find(x => x.label === label);
  if (v) return v;
  if (f.discover) return { label, option: label };
  throw new ToolError('config', `筛选 ${f.key} 不存在取值 "${label}"`);
}

/** 在单端页面上按组合设置全部筛选（不含等待，调用方在之后执行就绪协议） */
export async function applyCombo(page: Page, pageCfg: PageConfig, combo: Combo, log: Logger): Promise<void> {
  for (const f of pageCfg.filters) {
    const label = combo[f.key];
    if (label === undefined) continue;
    const v = pickValue(f, label);
    try {
      switch (f.type) {
        case 'select':
          await page.selectOption(f.selector!, { label: v.option ?? v.label });
          break;
        case 'multiselect':
          await page.selectOption(f.selector!, (v.options ?? []).map(o => ({ label: o })));
          break;
        case 'daterange':
        case 'radio':
          await page.click(v.clickSelector!);
          break;
        case 'input':
          await page.fill(f.selector!, v.text ?? v.label);
          break;
        case 'cascader':
        case 'custom': {
          for (const st of v.steps ?? []) {
            const s = st as { do: string; selector?: string; text?: string };
            if (s.do === 'click' && s.selector) await page.click(s.selector);
            else if (s.do === 'fill' && s.selector) await page.fill(s.selector, s.text ?? '');
            else throw new ToolError('config', `custom 筛选步骤不支持：${s.do}`);
          }
          break;
        }
      }
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError('filter-apply', `设置筛选 ${f.key}=${label} 失败：${String(e).slice(0, 200)}`);
    }
    log.debug(`筛选 ${f.key} ← ${label}`);
  }
  if (pageCfg.submitSelector) {
    await page.click(pageCfg.submitSelector)
      .catch(e => { throw new ToolError('filter-apply', `点击查询按钮失败：${String(e).slice(0, 160)}`); });
  }
}

/** 运行期自动发现：对 discover=true 且未显式枚举的 select 型筛选，从 v2 页面读取全部选项注入配置副本 */
export async function discoverOptions(page: Page, pageCfg: PageConfig, log: Logger): Promise<void> {
  for (const f of pageCfg.filters) {
    if (!f.discover || f.values.length || f.type !== 'select' || !f.selector) continue;
    const labels = await page.$$eval(`${f.selector} option`, os => os.map(o => (o.textContent || '').trim()).filter(Boolean))
      .catch(() => [] as string[]);
    if (!labels.length) { log.warn(`筛选 ${f.key} 自动发现失败，仅使用默认值`); continue; }
    f.values = labels.map(l => ({ label: l, option: l }));
    if (!labels.includes(f.default)) f.default = labels[0];
    log.info(`筛选 ${f.key} 自动发现 ${labels.length} 个选项（报告将标注"自动发现"）`);
  }
}

export type { Config };

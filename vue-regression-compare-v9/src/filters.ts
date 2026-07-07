import type { Page } from 'playwright';
import type { FilterConfig, FilterOption, PageConfig, RunMode } from './types.js';
import { waitPageReady } from './pageOps.js';
import { sleep } from './utils.js';

export async function resolveFilterOptions(page: Page, filter: FilterConfig): Promise<FilterOption[]> {
  if (filter.values && filter.values.length > 0) return normalizeOptions(filter.values);

  if (filter.type === 'select') {
    return await page.locator(`${filter.selector} option`).evaluateAll(nodes => {
      return nodes
        .map((n) => {
          const option = n as HTMLOptionElement;
          return { label: option.innerText.trim(), value: option.value };
        })
        .filter(o => o.value !== undefined && o.label !== undefined && o.label !== '');
    });
  }

  throw new Error(`Filter ${filter.name} requires explicit values when type=${filter.type}`);
}

export async function resolveFilterOptionsForMode(page: Page, filter: FilterConfig, mode: RunMode): Promise<FilterOption[]> {
  const all = await resolveFilterOptions(page, filter);
  if (mode === 'single-filter' || mode === 'strict') return uniqueOptions(selectByStrategy(all, filter, filter.strategy ?? inferStrategy(filter, mode)));
  if (mode === 'smoke' || mode === 'default') return [];
  return uniqueOptions(selectByStrategy(all, filter, filter.strategy ?? inferStrategy(filter, mode)));
}

export function inferStrategy(filter: FilterConfig, mode: RunMode): NonNullable<FilterConfig['strategy']> {
  if (mode === 'strict') {
    if (filter.businessType === 'time' || /时间|日期|月份|年度|周期/.test(filter.name)) return 'previous-and-current';
    if (filter.businessType === 'region' || /地区|区域|国家|省份|地域|海内外/.test(filter.name)) return 'region-representative';
    return 'all';
  }
  if (filter.businessType === 'time' || /时间|日期|月份|年度|周期/.test(filter.name)) return 'previous-and-current';
  if (filter.businessType === 'region' || /地区|区域|国家|省份|地域|海内外/.test(filter.name)) return 'region-representative';
  return 'all';
}

export function selectByStrategy(options: FilterOption[], filter: FilterConfig, strategy: NonNullable<FilterConfig['strategy']>): FilterOption[] {
  const cleaned = uniqueOptions(options).filter(o => !isLikelyPlaceholder(o));
  if (strategy === 'manual' || strategy === 'all') return cleaned;
  if (strategy === 'sample') return cleaned.slice(0, Math.max(1, filter.maxValues ?? 2));
  if (strategy === 'first-n') return cleaned.slice(0, Math.max(1, filter.maxValues ?? 3));
  if (strategy === 'previous-and-current') return selectPreviousAndCurrent(cleaned);
  if (strategy === 'region-representative') return selectRegionRepresentative(cleaned, filter);
  return cleaned;
}

function selectPreviousAndCurrent(options: FilterOption[]): FilterOption[] {
  if (options.length <= 2) return options;
  const labels = options.map(o => o.label);
  const currentKeywords = ['当前', '本月', '本周', '今天', '今日', '今年', '本年', '本季度', '近一月', '当月'];
  const previousKeywords = ['上一个', '上月', '上周', '昨日', '昨天', '去年', '上年', '上季度'];
  const selected: FilterOption[] = [];
  const prev = options.find(o => previousKeywords.some(k => o.label.includes(k)));
  const cur = options.find(o => currentKeywords.some(k => o.label.includes(k)));
  if (prev) selected.push(prev);
  if (cur && cur !== prev) selected.push(cur);
  if (selected.length) return selected;
  // 通常最后一个/倒数第二个是当前/上一个；保守取最后两个。
  return options.slice(-2);
}

function selectRegionRepresentative(options: FilterOption[], filter: FilterConfig): FilterOption[] {
  const domesticPreferred = filter.preferredDomestic ?? ['中国大陆', '中国', '全国', '境内', '国内', '华东', '北京', '上海', '广东', '深圳'];
  const overseasPreferred = filter.preferredOverseas ?? ['海外', '境外', '全球', '亚太', '欧洲', '北美', '美国', '新加坡', '日本'];
  const domestic = options.filter(o => isDomesticRegion(o.label, domesticPreferred));
  const overseas = options.filter(o => isOverseasRegion(o.label, overseasPreferred));
  const result: FilterOption[] = [];
  const d = pickPreferred(domestic, domesticPreferred) ?? domestic[0];
  const o = pickPreferred(overseas, overseasPreferred) ?? overseas[0];
  if (d) result.push(d);
  if (o && o.value !== d?.value) result.push(o);
  if (result.length) return result;
  return options.slice(0, 1);
}

function isDomesticRegion(label: string, preferred: string[]): boolean {
  if (preferred.some(k => label.includes(k))) return true;
  return /北京|上海|天津|重庆|广东|深圳|浙江|江苏|山东|河南|四川|湖北|湖南|福建|安徽|河北|山西|陕西|辽宁|吉林|黑龙江|云南|贵州|广西|海南|江西|内蒙古|新疆|西藏|宁夏|青海|甘肃/.test(label);
}

function isOverseasRegion(label: string, preferred: string[]): boolean {
  if (preferred.some(k => label.includes(k))) return true;
  return /美国|日本|新加坡|韩国|英国|法国|德国|欧洲|北美|亚太|澳洲|加拿大|印度|泰国|越南|马来|印尼|菲律宾|海外|境外|全球/.test(label);
}

function pickPreferred(options: FilterOption[], preferred: string[]): FilterOption | undefined {
  for (const key of preferred) {
    const match = options.find(o => o.label.includes(key));
    if (match) return match;
  }
  return undefined;
}

function normalizeOptions(values: FilterOption[]): FilterOption[] {
  return values.map(v => ({ label: String(v.label ?? v.value).trim(), value: String(v.value ?? v.label).trim() })).filter(v => v.label || v.value);
}

function uniqueOptions(values: FilterOption[]): FilterOption[] {
  const seen = new Set<string>();
  const out: FilterOption[] = [];
  for (const v of normalizeOptions(values)) {
    const key = `${v.label}::${v.value}`;
    if (!seen.has(key)) { seen.add(key); out.push(v); }
  }
  return out;
}

function isLikelyPlaceholder(o: FilterOption): boolean {
  const text = `${o.label} ${o.value}`.trim();
  return /^请选择|全部?$|^all$/i.test(text) || o.value === '';
}

export async function applyFilter(page: Page, filter: FilterConfig, option: FilterOption, cfg: PageConfig): Promise<number> {
  const start = Date.now();
  const timeout = cfg.timeoutMs ?? 60_000;

  if (filter.type === 'select') {
    await page.locator(filter.selector).selectOption(option.value, { timeout });
  } else if (filter.type === 'input') {
    await page.locator(filter.selector).fill(option.value, { timeout });
  } else if (filter.type === 'click-options') {
    if (!filter.optionSelector) throw new Error(`Filter ${filter.name} missing optionSelector`);
    const optionSelector = filter.optionSelector
      .replaceAll('{{value}}', cssEscape(option.value))
      .replaceAll('{{label}}', cssEscape(option.label));
    await page.locator(optionSelector).click({ timeout });
  }

  if (filter.submitSelector) {
    await page.locator(filter.submitSelector).click({ timeout });
  }

  if (filter.waitForSelector) {
    await page.locator(filter.waitForSelector).first().waitFor({ state: 'visible', timeout });
  }

  await waitPageReady(page, cfg);
  if (filter.waitAfterMs) await sleep(filter.waitAfterMs);
  return Date.now() - start;
}

function cssEscape(value: string): string {
  // This is intentionally simple for selector templates. Prefer stable data-testid selectors in configs.
  return value.replaceAll('"', '\\"').replaceAll("'", "\\'");
}

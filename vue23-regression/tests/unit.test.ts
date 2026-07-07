import { describe, expect, it } from 'vitest';
import { buildCombos, comboKey } from '../src/core/combos.js';
import { normalizeScalar, normalizeValue } from '../src/core/extract.js';
import { diffJson, signature, normalizeBody } from '../src/core/net.js';
import { globToRegExp, jsonPathDelete, jsonPathGet, sortArraysAt, urlMatch } from '../src/util/misc.js';
import type { PageConfig } from '../src/config/load.js';

const page = (over: Partial<PageConfig> = {}): PageConfig => ({
  id: 'p', name: '测试页', path: { vue2: '/a', vue3: '/b' },
  readyWhen: { apiDone: [] }, apiCapture: [], apiMap: [], apiIgnoreFields: [], unorderedPaths: [],
  masks: [], submitSelector: undefined, constraints: [], metrics: [], interactions: [],
  perf: { interactions: [] },
  filters: [
    { key: 'a', name: '', type: 'select', selector: '#a', default: 'a1', discover: false, values: [{ label: 'a1' }, { label: 'a2' }, { label: 'a3' }] },
    { key: 'b', name: '', type: 'select', selector: '#b', default: 'b1', discover: false, values: [{ label: 'b1' }, { label: 'b2' }] },
    { key: 'c', name: '', type: 'select', selector: '#c', default: 'c1', discover: false, values: [{ label: 'c1' }, { label: 'c2' }] },
  ],
  ...over,
} as PageConfig);

describe('组合策略', () => {
  it('default 只有 1 个默认组合', () => {
    const b = buildCombos(page(), 'default', 300, 42);
    expect(b.list).toEqual([{ a: 'a1', b: 'b1', c: 'c1' }]);
  });
  it('single = 1 + Σ(每维非默认取值数)', () => {
    expect(buildCombos(page(), 'single', 300, 42).list.length).toBe(1 + 2 + 1 + 1);
  });
  it('full = 笛卡尔积', () => {
    expect(buildCombos(page(), 'full', 300, 42).list.length).toBe(3 * 2 * 2);
  });
  it('pairwise 覆盖所有取值对且远小于全量上界成立', () => {
    const b = buildCombos(page(), 'pairwise', 300, 42);
    const dims = [['a', ['a1', 'a2', 'a3']], ['b', ['b1', 'b2']], ['c', ['c1', 'c2']]] as const;
    for (let i = 0; i < dims.length; i++) for (let j = i + 1; j < dims.length; j++)
      for (const x of dims[i][1]) for (const y of dims[j][1]) {
        expect(b.list.some(cmb => cmb[dims[i][0]] === x && cmb[dims[j][0]] === y),
          `pair ${dims[i][0]}=${x},${dims[j][0]}=${y} 未覆盖`).toBe(true);
      }
    expect(b.list.length).toBeLessThanOrEqual(12);
  });
  it('sample 固定 seed 可复现且包含默认组合', () => {
    const b1 = buildCombos(page(), 'sample', 5, 7);
    const b2 = buildCombos(page(), 'sample', 5, 7);
    expect(b1.list).toEqual(b2.list);
    expect(b1.list.length).toBe(5);
    expect(b1.list.some(c => comboKey(c) === comboKey({ a: 'a1', b: 'b1', c: 'c1' }))).toBe(true);
  });
  it('exclude 约束剔除组合', () => {
    const p = page({ constraints: [{ exclude: { a: 'a2', b: 'b2' } }] } as Partial<PageConfig>);
    const b = buildCombos(p, 'full', 300, 42);
    expect(b.list.some(c => c.a === 'a2' && c.b === 'b2')).toBe(false);
    expect(b.list.length).toBe(12 - 2);
  });
  it('无筛选页面的组合键为 default', () => {
    const p = page({ filters: [] } as Partial<PageConfig>);
    const b = buildCombos(p, 'full', 300, 42);
    expect(b.list).toEqual([{}]);
    expect(comboKey({})).toBe('default');
  });
});

describe('数值归一化', () => {
  it('千分位/单位/百分号/占位符', () => {
    expect(normalizeScalar('1,234,567', ['stripComma'])).toBe(1234567);
    expect(normalizeScalar('1,234.5 万', ['stripUnit'])).toBe(12345000);
    expect(normalizeScalar('12.5%', ['percent'])).toBe(0.125);
    expect(normalizeScalar('--', [])).toBeNull();
    expect(normalizeScalar('暂无数据', [])).toBeNull();
    expect(normalizeScalar('华东', [])).toBe('华东');
  });
  it('数组逐项归一化', () => {
    expect(normalizeValue(['1,000', '2,000'], ['stripComma'])).toEqual([1000, 2000]);
  });
});

describe('JSONPath-lite', () => {
  it('取值：普通/下标/递归', () => {
    const o = { data: { gmv: 9, list: [{ v: 1 }, { v: 2 }] } };
    expect(jsonPathGet(o, '$.data.gmv')).toBe(9);
    expect(jsonPathGet(o, '$.data.list[1].v')).toBe(2);
    expect(jsonPathGet(o, '$..v')).toEqual([1, 2]);
  });
  it('删除：递归剔除 timestamp', () => {
    const o = { a: { timestamp: 1, b: [{ timestamp: 2, x: 3 }] }, timestamp: 4 };
    jsonPathDelete(o, '$..timestamp');
    expect(JSON.stringify(o)).toBe('{"a":{"b":[{"x":3}]}}');
  });
  it('无序数组排序归一化', () => {
    const o = { list: [{ id: 2 }, { id: 1 }] };
    sortArraysAt(o, ['$.list']);
    expect((o.list[0] as { id: number }).id).toBe(1);
  });
});

describe('JSON diff 与网络层归一化', () => {
  it('输出路径级差异', () => {
    const d = diffJson({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3], c: 9 });
    const kinds = d.map(x => `${x.path}:${x.kind}`).sort();
    expect(kinds).toEqual(['$.a:changed', '$.b[1]:changed', '$.c:extra']);
  });
  it('签名对 query 顺序不敏感、剔除 body 忽略字段、v2 走 apiMap', () => {
    const p = page({ apiMap: [{ from: '^/api/v1/(.*)$', to: '/api/$1' }], apiIgnoreFields: ['$..ts'] } as Partial<PageConfig>);
    const s1 = signature(p, 'v2', 'POST', 'http://x/api/v1/sum?b=2&a=1', JSON.stringify({ q: 1, ts: 111 }));
    const s2 = signature(p, 'v3', 'POST', 'http://y/api/sum?a=1&b=2', JSON.stringify({ ts: 999, q: 1 }));
    expect(s1).toBe(s2);
  });
  it('响应归一化剔除忽略字段后无差异', () => {
    const p = page({ apiIgnoreFields: ['$..traceId'] } as Partial<PageConfig>);
    const a = normalizeBody(p, JSON.stringify({ v: 1, traceId: 'x' }));
    const b = normalizeBody(p, JSON.stringify({ v: 1, traceId: 'y' }));
    expect(diffJson(a, b)).toEqual([]);
  });
});

describe('glob', () => {
  it('** 与 * 语义', () => {
    expect(urlMatch('http://a/api/x/summary?r=1', ['**/api/**'])).toBe(true);
    expect(urlMatch('http://a/api/summary', ['**/api/*'])).toBe(true);
    expect(urlMatch('http://a/apix/summary', ['**/api/**'])).toBe(false);
    expect(globToRegExp('**/detail.html*').test('http://a/v2/detail.html?x=1'.split('#')[0])).toBe(true);
  });
});

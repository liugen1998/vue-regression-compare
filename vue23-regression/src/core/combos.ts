import type { PageConfig } from '../config/load.js';
import { makeRng, sanitizeName } from '../util/misc.js';

export type Combo = Record<string, string>;
export type ComboStrategy = 'default' | 'single' | 'pairwise' | 'full' | 'sample';

export function comboKey(combo: Combo): string {
  const parts = Object.keys(combo).sort().map(k => `${k}=${combo[k]}`);
  if (!parts.length) return 'default';
  return sanitizeName(parts.join('+'));
}

function labelsOf(page: PageConfig): Array<{ key: string; labels: string[]; def: string }> {
  return page.filters.map(f => ({
    key: f.key,
    labels: f.values.length ? f.values.map(v => v.label) : [f.default],
    def: f.default,
  }));
}

function defaultCombo(page: PageConfig): Combo {
  const c: Combo = {};
  for (const f of page.filters) c[f.key] = f.default;
  return c;
}

function passConstraints(page: PageConfig, combo: Combo): boolean {
  for (const c of page.constraints) {
    if ('exclude' in c) {
      const hit = Object.entries(c.exclude).every(([k, v]) => combo[k] === v);
      if (hit) return false;
    } else {
      const whenHit = Object.entries(c.when).every(([k, v]) => combo[k] === v);
      if (whenHit) {
        for (const [k, allowed] of Object.entries(c.then)) {
          if (combo[k] !== undefined && !allowed.includes(combo[k])) return false;
        }
      }
    }
  }
  return true;
}

function cartesian(dims: Array<{ key: string; labels: string[] }>): Combo[] {
  let acc: Combo[] = [{}];
  for (const d of dims) {
    const next: Combo[] = [];
    for (const base of acc) for (const l of d.labels) next.push({ ...base, [d.key]: l });
    acc = next;
  }
  return acc;
}

/** 贪心 pairwise：保证任意两维的任意取值对至少出现一次（单测校验覆盖性） */
function pairwise(dims: Array<{ key: string; labels: string[] }>, seed: number): Combo[] {
  if (dims.length <= 1) return cartesian(dims);
  const rng = makeRng(seed);
  type Pair = string; // "ki=va|kj=vb"（i<j）
  const uncovered = new Set<Pair>();
  for (let i = 0; i < dims.length; i++)
    for (let j = i + 1; j < dims.length; j++)
      for (const a of dims[i].labels)
        for (const b of dims[j].labels)
          uncovered.add(`${dims[i].key}=${a}|${dims[j].key}=${b}`);
  const combos: Combo[] = [];
  while (uncovered.size) {
    // 以一个未覆盖 pair 为种子，逐维选择"新增覆盖最多"的取值
    const seedPair = [...uncovered][Math.floor(rng() * uncovered.size)];
    const [pa, pb] = seedPair.split('|');
    const combo: Combo = {};
    for (const p of [pa, pb]) { const [k, v] = p.split('='); combo[k] = v; }
    for (const d of dims) {
      if (combo[d.key] !== undefined) continue;
      let best = d.labels[0], bestGain = -1;
      for (const l of d.labels) {
        let gain = 0;
        for (const [k, v] of Object.entries(combo)) {
          const [ki, kj] = [k, d.key].sort();
          const [vi, vj] = ki === k ? [v, l] : [l, v];
          if (uncovered.has(`${ki}=${vi}|${kj}=${vj}`)) gain++;
        }
        if (gain > bestGain) { bestGain = gain; best = l; }
      }
      combo[d.key] = best;
    }
    combos.push(combo);
    for (let i = 0; i < dims.length; i++)
      for (let j = i + 1; j < dims.length; j++)
        uncovered.delete(`${dims[i].key}=${combo[dims[i].key]}|${dims[j].key}=${combo[dims[j].key]}`);
  }
  return combos;
}

export interface ComboBuild { list: Combo[]; totalBeforeCap: number; capped: boolean }

export function buildCombos(page: PageConfig, strategy: ComboStrategy, maxCases: number, seed: number): ComboBuild {
  const dims = labelsOf(page);
  const def = defaultCombo(page);
  let list: Combo[];
  switch (strategy) {
    case 'default': list = [def]; break;
    case 'single': {
      list = [def];
      for (const d of dims) for (const l of d.labels) {
        if (l === d.def) continue;
        list.push({ ...def, [d.key]: l });
      }
      break;
    }
    case 'pairwise': list = dims.length ? pairwise(dims, seed) : [def]; break;
    case 'full': list = dims.length ? cartesian(dims) : [def]; break;
    case 'sample': {
      const all = dims.length ? cartesian(dims).filter(c => passConstraints(page, c)) : [def];
      const rng = makeRng(seed);
      const shuffled = [...all].sort(() => rng() - 0.5);
      const picked = shuffled.slice(0, Math.max(1, maxCases));
      if (!picked.some(c => comboKey(c) === comboKey(def)) && passConstraints(page, def)) picked[0] = def;
      return { list: picked, totalBeforeCap: all.length, capped: all.length > picked.length };
    }
  }
  list = list.filter(c => passConstraints(page, c));
  // 去重
  const seen = new Set<string>();
  list = list.filter(c => { const k = comboKey(c); if (seen.has(k)) return false; seen.add(k); return true; });
  const totalBeforeCap = list.length;
  const capped = list.length > maxCases;
  if (capped) list = list.slice(0, maxCases);
  return { list, totalBeforeCap, capped };
}

export function estimateAll(pages: PageConfig[], maxCases: number, seed: number) {
  const strategies: ComboStrategy[] = ['default', 'single', 'pairwise', 'full', 'sample'];
  return pages.map(p => {
    const row: Record<string, number | string> = { page: `${p.id}（${p.name}）` };
    for (const s of strategies) row[s] = buildCombos(p, s, maxCases, seed).list.length;
    return row;
  });
}

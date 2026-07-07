import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function ensureDir(p: string) { mkdirSync(p, { recursive: true }); return p; }

export function sha1(s: string) { return createHash('sha1').update(s).digest('hex'); }

export function nowIso() { return new Date().toISOString(); }

export function sanitizeName(s: string) {
  return s.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 80) || '_';
}

/** 键排序的稳定 JSON 序列化（对象键序无关） */
export function stableStringify(v: unknown): string {
  const seen = new Set<unknown>();
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return '[circular]';
    seen.add(x);
    if (Array.isArray(x)) return x.map(walk);
    const o = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = walk(o[k]);
    return out;
  };
  return JSON.stringify(walk(v));
}

/** 简化 glob → 正则：** 任意段，* 单段内任意，? 单字符。用于 URL 匹配。 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}
export function urlMatch(url: string, globs: string[]): boolean {
  const clean = url.split('#')[0];
  return globs.some(g => globToRegExp(g.includes('://') || g.startsWith('**') ? g : '**' + g).test(clean));
}

// ---------------- JSONPath-lite ----------------
// 支持：$.a.b、$.a[0].b、$..field（递归任意层字段）。满足 ignoreFields / api-field 场景。
type PathSeg = { key: string; recursive?: boolean } | { index: number };

function parsePath(path: string): PathSeg[] {
  const segs: PathSeg[] = [];
  let s = path.trim();
  if (s.startsWith('$')) s = s.slice(1);
  const re = /(\.\.?)([\w\u4e00-\u9fa5$-]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[3] !== undefined) segs.push({ index: Number(m[3]) });
    else segs.push({ key: m[2], recursive: m[1] === '..' });
  }
  return segs;
}

export function jsonPathGet(obj: unknown, path: string): unknown {
  const segs = parsePath(path);
  let cur: unknown[] = [obj];
  for (const seg of segs) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c === null || typeof c !== 'object') continue;
      if ('index' in seg) {
        if (Array.isArray(c) && seg.index < c.length) next.push(c[seg.index]);
      } else if (seg.recursive) {
        // 保序前序遍历（BFS 队列），保证 $..field 的结果顺序稳定
        const queue: unknown[] = [c];
        while (queue.length) {
          const t = queue.shift();
          if (t === null || typeof t !== 'object') continue;
          if (!Array.isArray(t) && seg.key in (t as object)) next.push((t as Record<string, unknown>)[seg.key]);
          for (const v of Object.values(t as object)) if (v && typeof v === 'object') queue.push(v);
        }
      } else if (!Array.isArray(c) && seg.key in (c as object)) {
        next.push((c as Record<string, unknown>)[seg.key]);
      }
    }
    cur = next;
    if (!cur.length) return undefined;
  }
  return cur.length === 1 ? cur[0] : cur;
}

/** 按路径删除字段（就地修改），用于归一化时剔除 traceId/timestamp 等 */
export function jsonPathDelete(obj: unknown, path: string): void {
  const segs = parsePath(path);
  if (!segs.length) return;
  const last = segs[segs.length - 1];
  const heads = segs.slice(0, -1);
  let cur: unknown[] = [obj];
  for (const seg of heads) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c === null || typeof c !== 'object') continue;
      if ('index' in seg) { if (Array.isArray(c)) next.push(c[seg.index]); }
      else if (seg.recursive) {
        const stack: unknown[] = [c];
        while (stack.length) {
          const t = stack.pop();
          if (t === null || typeof t !== 'object') continue;
          next.push(t);
          for (const v of Object.values(t as object)) if (v && typeof v === 'object') stack.push(v);
        }
      } else if (!Array.isArray(c)) next.push((c as Record<string, unknown>)[seg.key]);
    }
    cur = next;
  }
  const delFrom = (t: unknown) => {
    if (t === null || typeof t !== 'object') return;
    if ('index' in last) { if (Array.isArray(t)) t.splice(last.index, 1); return; }
    if (last.recursive) {
      const stack: unknown[] = [t];
      while (stack.length) {
        const x = stack.pop();
        if (x === null || typeof x !== 'object') continue;
        if (!Array.isArray(x)) delete (x as Record<string, unknown>)[last.key];
        for (const v of Object.values(x as object)) if (v && typeof v === 'object') stack.push(v);
      }
    } else if (!Array.isArray(t)) delete (t as Record<string, unknown>)[last.key];
  };
  for (const t of cur) delFrom(t);
}

/** 将指定路径下的数组按稳定序列化排序（unorderedPaths 归一化） */
export function sortArraysAt(obj: unknown, paths: string[]): void {
  for (const p of paths) {
    const v = jsonPathGet(obj, p);
    const arrs = Array.isArray(v) && v.every(x => Array.isArray(x)) ? (v as unknown[][]) : [v];
    for (const a of arrs) if (Array.isArray(a)) a.sort((x, y) => stableStringify(x).localeCompare(stableStringify(y)));
  }
}

/** 可复现随机数（mulberry32） */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from 'playwright';
import type { Config, PageConfig } from '../config/load.js';
import type { Finding, Side } from '../types.js';
import { ensureDir, jsonPathDelete, sha1, sortArraysAt, stableStringify, urlMatch, sleep } from '../util/misc.js';
import type { Logger } from '../util/log.js';

export interface CapturedResp {
  sig: string;
  method: string;
  url: string;
  status: number;
  bodyText: string | null;   // 仅 json/text 保留
  durationMs: number;
  fromReplay: boolean;
}

interface RecordEntry { status: number; contentType: string; bodyText: string; durationMs: number }
interface RecordFile { sig: string; method: string; urlSample: string; seq: RecordEntry[] }

/** 请求签名：method + （v2 侧经 apiMap 映射后的）路径 + 排序 query + 归一化 body 哈希 */
export function signature(pageCfg: PageConfig, side: Side, method: string, rawUrl: string, postData: string | null): string {
  const u = new URL(rawUrl);
  let path = u.pathname;
  if (side === 'v2') for (const m of pageCfg.apiMap) path = path.replace(new RegExp(m.from), m.to);
  const qs = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  let bodyKey = '';
  if (postData) {
    try {
      const j = JSON.parse(postData);
      for (const f of pageCfg.apiIgnoreFields) jsonPathDelete(j, f);
      bodyKey = stableStringify(j);
    } catch { bodyKey = postData; }
  }
  return `${method} ${path}?${qs}#${sha1(bodyKey).slice(0, 12)}`;
}

/** 归一化响应体用于比对：剔除忽略字段、无序数组排序 */
export function normalizeBody(pageCfg: PageConfig, bodyText: string | null): unknown {
  if (bodyText == null) return null;
  try {
    const j = JSON.parse(bodyText);
    for (const f of pageCfg.apiIgnoreFields) jsonPathDelete(j, f);
    sortArraysAt(j, pageCfg.unorderedPaths);
    return j;
  } catch { return bodyText; }
}

export interface JsonDiffItem { path: string; kind: 'missing' | 'extra' | 'changed'; v2?: unknown; v3?: unknown }

export function diffJson(a: unknown, b: unknown, path = '$', out: JsonDiffItem[] = [], cap = 50): JsonDiffItem[] {
  if (out.length >= cap) return out;
  if (a === b) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    if (stableStringify(a) !== stableStringify(b)) out.push({ path, kind: 'changed', v2: a, v3: b });
    return out;
  }
  if (ta === 'array') {
    const A = a as unknown[], B = b as unknown[];
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n && out.length < cap; i++) {
      if (i >= A.length) out.push({ path: `${path}[${i}]`, kind: 'extra', v3: B[i] });
      else if (i >= B.length) out.push({ path: `${path}[${i}]`, kind: 'missing', v2: A[i] });
      else diffJson(A[i], B[i], `${path}[${i}]`, out, cap);
    }
    return out;
  }
  const A = a as Record<string, unknown>, B = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (out.length >= cap) break;
    if (!(k in B)) out.push({ path: `${path}.${k}`, kind: 'missing', v2: A[k] });
    else if (!(k in A)) out.push({ path: `${path}.${k}`, kind: 'extra', v3: B[k] });
    else diffJson(A[k], B[k], `${path}.${k}`, out, cap);
  }
  return out;
}

// ---------------- 录制存储 ----------------
export class RecordStore {
  private map = new Map<string, RecordFile>();
  private cursor = new Map<string, number>();
  constructor(private dir: string) {}

  static dirFor(root: string, pageId: string, comboKey: string) {
    return join(root, 'recordings', pageId, comboKey);
  }
  load(): number {
    if (!existsSync(this.dir)) return 0;
    for (const f of readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
      const rec = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as RecordFile;
      this.map.set(rec.sig, rec);
    }
    return this.map.size;
  }
  save(sig: string, method: string, urlSample: string, entry: RecordEntry) {
    ensureDir(this.dir);
    const cur = this.map.get(sig) ?? { sig, method, urlSample, seq: [] };
    cur.seq.push(entry);
    this.map.set(sig, cur);
    writeFileSync(join(this.dir, sha1(sig).slice(0, 16) + '.json'), JSON.stringify(cur, null, 1));
  }
  next(sig: string): RecordEntry | undefined {
    const rec = this.map.get(sig);
    if (!rec) return undefined;
    const i = this.cursor.get(sig) ?? 0;
    const e = rec.seq[Math.min(i, rec.seq.length - 1)];
    this.cursor.set(sig, i + 1);
    return e;
  }
  resetCursor() { this.cursor.clear(); }
  size() { return this.map.size; }
}

// ---------------- 单端网络层 ----------------
export class NetLayer {
  captured: CapturedResp[] = [];
  misses: string[] = [];
  private marks: number[] = [];

  constructor(
    private side: Side,
    private pageCfg: PageConfig,
    private cfg: Config,
    private mode: 'record' | 'replay' | 'live',
    private store: RecordStore | null,
    private log: Logger,
  ) {}

  /** 在页面上挂载路由与响应监听 */
  async attach(page: Page): Promise<void> {
    const captureGlobs = this.pageCfg.apiCapture;
    if (!captureGlobs.length) return;
    await page.route('**/*', async (route: Route) => {
      const req = route.request();
      const url = req.url();
      if (req.resourceType() === 'document' || !urlMatch(url, captureGlobs)) return route.fallback();
      const sig = signature(this.pageCfg, this.side, req.method(), url, req.postData());
      if (this.mode === 'replay' && this.store) {
        const e = this.store.next(sig);
        if (e) {
          await sleep(Math.min(e.durationMs, 1000));
          this.captured.push({ sig, method: req.method(), url, status: e.status, bodyText: e.bodyText, durationMs: e.durationMs, fromReplay: true });
          return route.fulfill({ status: e.status, contentType: e.contentType || 'application/json', body: e.bodyText });
        }
        this.misses.push(sig);
        if (this.cfg.global.replayMissPolicy === 'abort-fail') {
          this.log.warn(`[${this.side}] 回放未命中且策略为 abort-fail：${sig}`);
          return route.abort('failed');
        }
        this.log.warn(`[${this.side}] 回放未命中，放行真实请求：${sig}`);
      }
      const t0 = Date.now();
      try {
        const resp = await route.fetch();
        const durationMs = Date.now() - t0;
        const ct = resp.headers()['content-type'] || '';
        const isText = /json|text|javascript\+json/.test(ct);
        const bodyText = isText ? await resp.text() : null;
        this.captured.push({ sig, method: req.method(), url, status: resp.status(), bodyText, durationMs, fromReplay: false });
        if (this.mode === 'record' && this.store && bodyText !== null) {
          this.store.save(sig, req.method(), url, { status: resp.status(), contentType: ct, bodyText, durationMs });
        }
        return route.fulfill({ response: resp });
      } catch (err) {
        this.log.warn(`[${this.side}] 请求转发失败：${url} ${String(err).slice(0, 200)}`);
        return route.abort('failed').catch(() => undefined);
      }
    });
  }

  /** 供就绪协议检查 apiDone：给定 glob 是否至少有一次完成的捕获 */
  apiDoneCheck = (globs: string[]) => globs.every(g => this.captured.some(c => urlMatch(c.url, [g])));

  /** 交互步骤前打标，便于按需取"某步之后"的捕获（预留） */
  mark() { this.marks.push(this.captured.length); }
  sinceMark(): CapturedResp[] { return this.captured.slice(this.marks[this.marks.length - 1] ?? 0); }

  apiTotalMs(): number { return this.captured.reduce((s, c) => s + c.durationMs, 0); }
}

/** 双端 API 配对比对。live 模式下响应差异只作为漂移证据。 */
export function diffApiPairs(pageCfg: PageConfig, v2: CapturedResp[], v3: CapturedResp[], mode: 'record' | 'replay' | 'live'):
  { findings: Finding[]; driftDetected: boolean } {
  const findings: Finding[] = [];
  let drift = false;
  const g2 = new Map<string, CapturedResp>(); v2.forEach(c => g2.set(c.sig, c));
  const g3 = new Map<string, CapturedResp>(); v3.forEach(c => g3.set(c.sig, c));
  for (const [sig, c2] of g2) {
    const c3 = g3.get(sig);
    if (!c3) {
      findings.push({ type: 'render-bug', layer: 'api', id: sig, message: `Vue3 未发出与 Vue2 对应的请求（或参数不一致导致签名不同）`, v2: c2.url });
      continue;
    }
    if (c2.status !== c3.status) {
      findings.push({ type: mode === 'live' ? 'data-drift' : 'render-bug', layer: 'api', id: sig, message: `响应状态码不一致`, v2: c2.status, v3: c3.status });
      if (mode === 'live') drift = true;
      continue;
    }
    const n2 = normalizeBody(pageCfg, c2.bodyText);
    const n3 = normalizeBody(pageCfg, c3.bodyText);
    const diffs = diffJson(n2, n3);
    if (diffs.length) {
      if (mode === 'live') {
        drift = true;
        findings.push({ type: 'data-drift', layer: 'api', id: sig, message: `双端响应存在 ${diffs.length} 处差异（实时数据漂移，不计缺陷）`, extra: { diffs: diffs.slice(0, 10) } });
      } else {
        findings.push({ type: 'render-bug', layer: 'api', id: sig, message: `回放模式下响应仍不一致（异常，请检查回放命中）`, extra: { diffs: diffs.slice(0, 10) } });
      }
    }
  }
  for (const [sig, c3] of g3) if (!g2.has(sig)) {
    findings.push({ type: 'render-bug', layer: 'api', id: sig, message: `Vue3 发出了 Vue2 没有的请求`, v3: c3.url });
  }
  return { findings, driftDetected: drift };
}

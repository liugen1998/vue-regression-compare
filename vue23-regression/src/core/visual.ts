import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import pLimit from 'p-limit';
import type { Page } from 'playwright';
import type { Config, PageConfig } from '../config/load.js';
import type { Finding } from '../types.js';
import type { Logger } from '../util/log.js';
import { autoScroll, chartsSettled } from './session.js';

// ---------------- 截图 ----------------
export async function takeShot(page: Page, pageCfg: PageConfig, cfg: Config, outPath: string, scopeSelector?: string): Promise<void> {
  await autoScroll(page);
  await chartsSettled(page, cfg);
  const masks = pageCfg.masks.map(m => page.locator(m));
  if (scopeSelector) {
    await page.locator(scopeSelector).first().screenshot({ path: outPath, mask: masks, maskColor: '#FF00FF' });
  } else {
    await page.screenshot({ path: outPath, fullPage: true, mask: masks, maskColor: '#FF00FF' });
  }
}

// ---------------- 像素比对 ----------------
function padTo(png: PNG, w: number, h: number): PNG {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h, fill: true });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

export interface PixelResult { ratio: number; diffPixels: number; width: number; height: number; sizeNote?: string; boxes: Array<{ x: number; y: number; w: number; h: number }> }

/** 像素比对并输出 diff 图；返回差异率与差异聚集区（粗网格连通域，最多 maxBoxes 个） */
export function comparePng(p2Path: string, p3Path: string, diffPath: string, cfg: Config, maxBoxes: number): PixelResult {
  const a0 = PNG.sync.read(readFileSync(p2Path));
  const b0 = PNG.sync.read(readFileSync(p3Path));
  const w = Math.max(a0.width, b0.width), h = Math.max(a0.height, b0.height);
  const sizeNote = a0.width !== b0.width || a0.height !== b0.height
    ? `截图尺寸不同：v2=${a0.width}×${a0.height}，v3=${b0.width}×${b0.height}（已补白对齐）` : undefined;
  const a = padTo(a0, w, h), b = padTo(b0, w, h);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: cfg.global.tolerance.pixelThreshold, includeAA: false });
  writeFileSync(diffPath, PNG.sync.write(diff));
  // 粗网格（16px）标记含差异的格子并合并为包围盒
  const cell = 16;
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (diff.data[i] > 200 && diff.data[i + 1] < 120 && diff.data[i + 2] < 120) grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] = 1;
  }
  const seen = new Uint8Array(gw * gh);
  const boxes: PixelResult['boxes'] = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const idx = gy * gw + gx;
    if (!grid[idx] || seen[idx]) continue;
    let minX = gx, maxX = gx, minY = gy, maxY = gy;
    const stack = [idx]; seen[idx] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      const cx = cur % gw, cy = Math.floor(cur / gw);
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (grid[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
      }
    }
    boxes.push({ x: minX * cell, y: minY * cell, w: (maxX - minX + 1) * cell, h: (maxY - minY + 1) * cell });
  }
  boxes.sort((p, q) => q.w * q.h - p.w * p.h);
  return { ratio: diffPixels / (w * h), diffPixels, width: w, height: h, sizeNote, boxes: boxes.slice(0, maxBoxes) };
}

function cropPng(srcPath: string, box: { x: number; y: number; w: number; h: number }, pad = 24): Buffer {
  const src = PNG.sync.read(readFileSync(srcPath));
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const w = Math.min(src.width - x, box.w + pad * 2), h = Math.min(src.height - y, box.h + pad * 2);
  const out = new PNG({ width: Math.max(1, w), height: Math.max(1, h) });
  PNG.bitblt(src, out, x, y, out.width, out.height, 0, 0);
  return PNG.sync.write(out);
}

// ---------------- Qwen2.5-VL 客户端 ----------------
const PROMPT_EQUIV = `你是前端升级回归的视觉审查员。给你同一页面区域的两张截图（图1=Vue2 基准，图2=Vue3）。判断二者是否"语义等价"。
应忽略：抗锯齿/亚像素/字体渲染微差、±2px 内的位移、不改变数据含义的图例顺序、滚动条样式。
必须报告：任何数字/文本内容差异、元素缺失或多出、颜色映射含义改变、图形形状或数据点差异、布局明显错位。
只输出 JSON：{"equivalent": true|false, "confidence": 0到1, "differences": [{"type":"text|number|element|color|layout|shape","desc":"中文描述","area":"大致位置"}]}
不要输出 JSON 以外的任何字符。`;

const PROMPT_READ = `给你一张图表/页面区域截图和一个问题。若问数值：读出并按 {"values":[{"label":"...","value":数值}],"confidence":0到1} 输出；若问位置：返回 {"cx":数值,"cy":数值,"bbox":[x1,y1,x2,y2],"confidence":0到1}，坐标为该图绝对像素。只输出 JSON，不要其他字符。`;

export interface VlVerdict { equivalent: boolean; confidence: number; differences: Array<{ type: string; desc: string; area?: string }> }

export class VlClient {
  private limit: ReturnType<typeof pLimit>;
  constructor(private baseUrl: string, private apiKey: string, private model: string, private timeoutMs: number, maxConcurrent: number, private log: Logger) {
    this.limit = pLimit(Math.max(1, maxConcurrent));
  }

  static fromEnv(cfg: Config, log: Logger): VlClient | null {
    const v = cfg.global.vl;
    const baseUrl = process.env[v.baseUrlEnv];
    if (!baseUrl) return null;
    return new VlClient(baseUrl.replace(/\/$/, ''), process.env[v.apiKeyEnv] || 'none', process.env[v.modelEnv] || 'qwen2.5-vl-72b-instruct', v.timeoutMs, v.maxConcurrent, log);
  }

  private async chat(content: unknown[]): Promise<string> {
    return this.limit(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        try {
          const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model: this.model, max_tokens: 800, temperature: 0, messages: [{ role: 'user', content }] }),
            signal: ac.signal,
          });
          clearTimeout(timer);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json() as { choices: Array<{ message: { content: string } }> };
          return j.choices[0].message.content;
        } catch (e) {
          clearTimeout(timer);
          this.log.warn(`VL 调用失败（第 ${attempt + 1} 次）：${String(e).slice(0, 200)}`);
          if (attempt === 2) throw e;
        }
      }
      throw new Error('unreachable');
    });
  }

  private static parseJson<T>(text: string): T {
    const clean = text.replace(/```json|```/g, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : clean) as T;
  }

  private img(buf: Buffer) {
    return { type: 'image_url', image_url: { url: `data:image/png;base64,${buf.toString('base64')}` } };
  }

  async judgeEquivalence(v2Crop: Buffer, v3Crop: Buffer): Promise<VlVerdict> {
    const txt = await this.chat([{ type: 'text', text: PROMPT_EQUIV }, this.img(v2Crop), this.img(v3Crop)]);
    return VlClient.parseJson<VlVerdict>(txt);
  }

  async read(shot: Buffer, question: string): Promise<string> {
    const txt = await this.chat([{ type: 'text', text: `${PROMPT_READ}\n问题：${question}` }, this.img(shot)]);
    return txt;
  }
}

// ---------------- 视觉比对主流程 ----------------
export async function visualCompare(
  label: string, p2Path: string, p3Path: string, artifactDir: string, pageCfg: PageConfig, cfg: Config,
  vl: VlClient | null, log: Logger,
): Promise<{ finding: Finding | null; diffPath: string; ratio: number }> {
  const diffPath = join(artifactDir, `${label}.diff.png`);
  const r = comparePng(p2Path, p3Path, diffPath, cfg, cfg.global.tolerance.vlReviewMaxRegions);
  if (r.sizeNote) log.warn(`[${label}] ${r.sizeNote}`);
  if (r.ratio <= cfg.global.tolerance.passDiffRatio) return { finding: null, diffPath, ratio: r.ratio };
  const pct = (r.ratio * 100).toFixed(3);
  if (!vl) {
    return {
      finding: { type: 'visual-pending', layer: 'visual', id: label, message: `像素差异率 ${pct}% 超阈值，VL 未启用，待人工复核（差异区 ${r.boxes.length} 处）`, extra: { boxes: r.boxes, sizeNote: r.sizeNote } },
      diffPath, ratio: r.ratio,
    };
  }
  try {
    const verdicts: VlVerdict[] = [];
    for (const box of r.boxes) {
      verdicts.push(await vl.judgeEquivalence(cropPng(p2Path, box), cropPng(p3Path, box)));
    }
    const bad = verdicts.filter(v => !v.equivalent);
    if (!bad.length) {
      return {
        finding: { type: 'visual-minor', layer: 'visual', id: label, message: `像素差异率 ${pct}%，VL 判定 ${verdicts.length} 处差异区均语义等价（渲染微差）`, extra: { verdicts } },
        diffPath, ratio: r.ratio,
      };
    }
    const descs = bad.flatMap(v => v.differences.map(d => d.desc)).slice(0, 5).join('；');
    return {
      finding: { type: 'render-bug', layer: 'visual', id: label, message: `像素差异率 ${pct}%，VL 判定存在真实差异：${descs}`, extra: { verdicts } },
      diffPath, ratio: r.ratio,
    };
  } catch (e) {
    return {
      finding: { type: 'visual-pending', layer: 'visual', id: label, message: `像素差异率 ${pct}%，VL 复核失败已降级待人工复核：${String(e).slice(0, 120)}`, extra: { boxes: r.boxes } },
      diffPath, ratio: r.ratio,
    };
  }
}

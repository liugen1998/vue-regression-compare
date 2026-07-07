import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import YAML from 'yaml';
import type { PageConfig, TestStrategy } from './types.js';
import { ensureDir, sanitizeFileName } from './utils.js';

export interface ImportedPageRow {
  pageName: string;
  vue2Url: string;
  vue3Url: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  files: string[];
  errors: string[];
  pages: PageConfig[];
}

export function parseMarkdownPageTable(content: string): ImportedPageRow[] {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('|') && l.endsWith('|'));
  if (lines.length < 2) return [];
  const header = splitMdRow(lines[0]).map(normalizeHeader);
  const pageIdx = header.findIndex(h => h === '页面');
  const v2Idx = header.findIndex(h => h === 'vue2链接' || h === 'vue2url' || h === 'vue2');
  const v3Idx = header.findIndex(h => h === 'vue3链接' || h === 'vue3url' || h === 'vue3');
  if (pageIdx < 0 || v2Idx < 0 || v3Idx < 0) throw new Error('Markdown 表头必须包含：页面 | VUE2链接 | VUE3链接');
  const rows: ImportedPageRow[] = [];
  for (const line of lines.slice(1)) {
    if (/^\|?\s*:?-+:?\s*\|/.test(line)) continue;
    const cells = splitMdRow(line);
    const pageName = cells[pageIdx]?.trim();
    const vue2Url = cells[v2Idx]?.trim();
    const vue3Url = cells[v3Idx]?.trim();
    if (pageName || vue2Url || vue3Url) rows.push({ pageName, vue2Url, vue3Url });
  }
  return rows;
}

export function parseCsvPageTable(content: string): ImportedPageRow[] {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map(normalizeHeader);
  const pageIdx = header.findIndex(h => h === '页面');
  const v2Idx = header.findIndex(h => h === 'vue2链接' || h === 'vue2url' || h === 'vue2');
  const v3Idx = header.findIndex(h => h === 'vue3链接' || h === 'vue3url' || h === 'vue3');
  if (pageIdx < 0 || v2Idx < 0 || v3Idx < 0) throw new Error('CSV 表头必须包含：页面,VUE2链接,VUE3链接');
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    return { pageName: cells[pageIdx]?.trim(), vue2Url: cells[v2Idx]?.trim(), vue3Url: cells[v3Idx]?.trim() };
  }).filter(r => r.pageName || r.vue2Url || r.vue3Url);
}

export async function parseXlsxPageTable(buffer: Buffer): Promise<ImportedPageRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.getWorksheet('页面清单') ?? wb.worksheets[0];
  if (!ws) return [];
  const header = (ws.getRow(1).values as any[]).slice(1).map(v => normalizeHeader(String(v ?? '')));
  const pageIdx = header.findIndex(h => h === '页面') + 1;
  const v2Idx = header.findIndex(h => h === 'vue2链接' || h === 'vue2url' || h === 'vue2') + 1;
  const v3Idx = header.findIndex(h => h === 'vue3链接' || h === 'vue3url' || h === 'vue3') + 1;
  if (!pageIdx || !v2Idx || !v3Idx) throw new Error('Excel 第一行表头必须包含：页面、VUE2链接、VUE3链接');
  const rows: ImportedPageRow[] = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const pageName = cellText(row.getCell(pageIdx).value);
    const vue2Url = cellText(row.getCell(v2Idx).value);
    const vue3Url = cellText(row.getCell(v3Idx).value);
    if (pageName || vue2Url || vue3Url) rows.push({ pageName, vue2Url, vue3Url });
  }
  return rows;
}

export async function importPageRows(rows: ImportedPageRow[], targetDir: string, strategy: TestStrategy = 'standard'): Promise<ImportResult> {
  await ensureDir(targetDir);
  const result: ImportResult = { imported: 0, skipped: 0, files: [], errors: [], pages: [] };
  const usedKeys = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `第 ${i + 1} 行`;
    if (!row.pageName?.trim()) { result.errors.push(`${label}：页面不能为空`); result.skipped++; continue; }
    if (!isHttpUrl(row.vue2Url)) { result.errors.push(`${label}：VUE2链接不是合法 URL：${row.vue2Url || ''}`); result.skipped++; continue; }
    if (!isHttpUrl(row.vue3Url)) { result.errors.push(`${label}：VUE3链接不是合法 URL：${row.vue3Url || ''}`); result.skipped++; continue; }
    const pageKey = uniqueKey(toPageKey(row.pageName, i + 1), usedKeys);
    const cfg: PageConfig = {
      pageKey,
      pageName: row.pageName.trim(),
      vue2Url: row.vue2Url.trim(),
      vue3Url: row.vue3Url.trim(),
      testStrategy: strategy,
      waitForSelector: 'body',
      waitForNetworkIdle: true,
      waitAfterMs: 300,
      timeoutMs: 60000,
      storageState: 'workspace/auth/storageState.json',
      autoDiscoverInteractions: true,
      interactionCheckMode: 'conservative',
      interactionExtraPolicy: 'manual',
      interactionUniqueTextMatch: true,
      reportVue3ExtraInteractions: true,
      metrics: [],
      filters: [],
      tabs: { strategy: 'all', items: [] },
      interactions: []
    };
    const file = path.join(targetDir, `${pageKey}.yaml`);
    await fs.writeFile(file, YAML.stringify(cfg), 'utf8');
    result.imported++;
    result.files.push(file);
    result.pages.push(cfg);
  }
  return result;
}

function splitMdRow(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
}
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let quote = false;
  for (let i=0;i<line.length;i++) { const ch=line[i]; if (ch === '"') { if (quote && line[i+1] === '"') { cur += '"'; i++; } else quote = !quote; } else if (ch === ',' && !quote) { out.push(cur); cur=''; } else cur += ch; }
  out.push(cur); return out;
}
function normalizeHeader(s: string): string { return s.replace(/\s+/g, '').trim().toLowerCase(); }
function cellText(v: any): string { if (v == null) return ''; if (typeof v === 'object' && 'text' in v) return String(v.text ?? ''); if (typeof v === 'object' && 'hyperlink' in v) return String(v.hyperlink ?? v.text ?? ''); return String(v).trim(); }
function isHttpUrl(s: string): boolean { try { const u = new URL(String(s)); return ['http:', 'https:'].includes(u.protocol); } catch { return false; } }
function toPageKey(name: string, idx: number): string { const ascii = sanitizeFileName(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); return ascii && /[a-z]/.test(ascii) ? ascii : `page-${String(idx).padStart(3, '0')}`; }
function uniqueKey(base: string, used: Set<string>): string { let key = base; let n = 2; while (used.has(key)) key = `${base}-${n++}`; used.add(key); return key; }

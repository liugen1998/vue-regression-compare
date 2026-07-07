import fs from 'node:fs/promises';
import path from 'node:path';
import { importPageRows, parseCsvPageTable, parseMarkdownPageTable, parseXlsxPageTable } from './importPages.js';
import type { TestStrategy } from './types.js';

async function main() {
  const args = process.argv.slice(2);
  const file = value(args, '--file');
  const format = value(args, '--format') ?? (file?.endsWith('.xlsx') ? 'xlsx' : file?.endsWith('.csv') ? 'csv' : 'markdown');
  const strategy = (value(args, '--strategy') ?? 'standard') as TestStrategy;
  const out = value(args, '--out') ?? 'workspace/pages';
  if (!file) throw new Error('请传入 --file pages.md|pages.csv|pages.xlsx');
  const buf = await fs.readFile(file);
  const rows = format === 'xlsx' ? await parseXlsxPageTable(buf) : format === 'csv' ? parseCsvPageTable(buf.toString('utf8')) : parseMarkdownPageTable(buf.toString('utf8'));
  const result = await importPageRows(rows, path.resolve(out), strategy);
  console.log(JSON.stringify({ ...result, files: result.files.map(f => path.relative(process.cwd(), f)) }, null, 2));
}
function value(args: string[], name: string) { const i = args.indexOf(name); return i >= 0 ? args[i+1] : undefined; }
main().catch(err => { console.error(err); process.exitCode = 1; });

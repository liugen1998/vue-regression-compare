import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResults } from '../types.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

export function generateJUnit(r: RunResults, runDir: string): string {
  const byPage = new Map<string, typeof r.cases>();
  for (const c of r.cases) {
    if (!byPage.has(c.pageId)) byPage.set(c.pageId, []);
    byPage.get(c.pageId)!.push(c);
  }
  const suites = [...byPage.entries()].map(([pid, cs]) => {
    const tests = cs.map(c => {
      const red = c.findings.filter(f => ['render-bug', 'interaction-fail', 'perf-regression'].includes(f.type));
      const body = c.status === 'fail'
        ? `<failure message="${esc(red.map(f => f.message).join('；'))}"/>`
        : c.status === 'error'
          ? `<error message="${esc(c.findings.map(f => f.message).join('；'))}"/>`
          : '';
      return `<testcase classname="${esc(pid)}" name="${esc(c.comboKey)}" time="${(c.durationMs / 1000).toFixed(1)}">${body}</testcase>`;
    }).join('\n');
    return `<testsuite name="${esc(pid)}" tests="${cs.length}" failures="${cs.filter(c => c.status === 'fail').length}" errors="${cs.filter(c => c.status === 'error').length}">\n${tests}\n</testsuite>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}\n</testsuites>\n`;
  const out = join(runDir, 'junit.xml');
  writeFileSync(out, xml);
  return out;
}

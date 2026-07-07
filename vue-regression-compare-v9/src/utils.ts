import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function sanitizeFileName(input: string): string {
  return input
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'unnamed';
}

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function relPath(fromDir: string, targetPath: string): string {
  return path.relative(fromDir, targetPath).replace(/\\/g, '/');
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function isInvalidCollectedValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  return /^\[(NOT_FOUND|ERROR|MISSING)\]/.test(value);
}

export function invalidValueErrorType(vue2Value?: string, vue3Value?: string): string {
  const values = [vue2Value, vue3Value].filter(Boolean).join(' | ');
  if (/\[NOT_FOUND\]/.test(values)) return 'selector 找不到';
  if (/\[ERROR\]/.test(values)) return '采集执行异常';
  if (/\[MISSING\]/.test(values)) return '配置或采集结果缺失';
  return '无法采集展示值';
}

export function invalidValueMessage(vue2Value?: string, vue3Value?: string): string {
  const v2Bad = isInvalidCollectedValue(vue2Value);
  const v3Bad = isInvalidCollectedValue(vue3Value);
  if (v2Bad && v3Bad) return 'Vue2 与 Vue3 均未采集到有效展示值，不能判定为通过';
  if (v2Bad) return 'Vue2 未采集到有效展示值，不能判定为通过';
  if (v3Bad) return 'Vue3 未采集到有效展示值，不能判定为通过';
  return '';
}

/**
 * 性能变化百分比：以 Vue2 耗时为基线。
 * - Vue3 耗时更短：提升 xx%
 * - Vue3 耗时更长：下降 xx%
 * 公式：(Vue2耗时 - Vue3耗时) / Vue2耗时 × 100%
 */
export function performanceChangePercent(vue2Ms?: number, vue3Ms?: number): number | undefined {
  if (vue2Ms === undefined || vue3Ms === undefined) return undefined;
  if (!Number.isFinite(vue2Ms) || !Number.isFinite(vue3Ms)) return undefined;
  if (vue2Ms <= 0) return vue3Ms <= 0 ? 0 : undefined;
  return ((vue2Ms - vue3Ms) / vue2Ms) * 100;
}

export function isPerformanceDegraded(vue2Ms?: number, vue3Ms?: number): boolean {
  if (vue2Ms === undefined || vue3Ms === undefined) return false;
  if (!Number.isFinite(vue2Ms) || !Number.isFinite(vue3Ms)) return false;
  return vue3Ms > vue2Ms;
}

export function performanceChangeText(vue2Ms?: number, vue3Ms?: number): string | undefined {
  const pct = performanceChangePercent(vue2Ms, vue3Ms);
  if (pct === undefined) return '无法计算';
  const abs = Math.abs(pct).toFixed(2);
  if (pct > 0) return `提升 ${abs}%`;
  if (pct < 0) return `下降 ${abs}%`;
  return '持平 0.00%';
}


export function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function classifyError(error: unknown): string {
  const msg = String((error as Error)?.message ?? error ?? '');
  if (/\[NOT_FOUND\]/.test(msg)) return 'selector 找不到';
  if (/net::ERR|Navigation|goto|load|timeout.*page/i.test(msg)) return '页面打不开或加载超时';
  if (/Target page, context or browser has been closed/i.test(msg)) return '浏览器或页面被关闭';
  if (/waiting for locator|locator.*waitFor|strict mode violation|Timeout.*selector|selector|No element/i.test(msg)) return 'selector 找不到或等待超时';
  if (/click/i.test(msg)) return '点击失败';
  if (/hover/i.test(msg)) return '悬停失败';
  if (/storageState|ENOENT/i.test(msg)) return '登录态文件缺失';
  return '未知异常';
}

export async function promisePool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

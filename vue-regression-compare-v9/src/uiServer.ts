import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import YAML from 'yaml';
import { importPageRows, parseCsvPageTable, parseMarkdownPageTable, parseXlsxPageTable } from './importPages.js';
import { estimatePlan } from './plan.js';
import { detectBrowserExecutable, writeEnvValue } from './browser.js';
import { collectConfigIssues, loadAllPageConfigFiles, loadPageConfigs } from './config.js';
import { defaultReadinessConfig } from './defaults.js';
import type { PageConfig } from './types.js';
import { ensureDir, nowStamp, pathExists } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(ROOT, 'src', 'ui');
const WORKSPACE_PAGES = path.join(ROOT, 'workspace', 'pages');
const REPORTS_DIR = path.join(ROOT, 'reports');
const MANUAL_CONFIRMATIONS = path.join(ROOT, 'workspace', 'manual-confirmations.json');
const DEFAULT_PORT = Number(process.env.UI_PORT || 3666);
const MAX_JOBS = 50;

type JobStatus = 'running' | 'success' | 'error' | 'stopped';
type JobType = 'compare' | 'validate' | 'check-selectors' | 'auth' | 'install-deps' | 'install-browsers';
type RunCommandType = 'compare' | 'validate' | 'check-selectors' | 'auth';
interface JobInfo {
  id: string;
  type: JobType;
  title: string;
  status: JobStatus;
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  logs: string[];
}

const jobs = new Map<string, JobInfo>();
const jobProcesses = new Map<string, ChildProcess>();

async function main(): Promise<void> {
  await ensureDir(WORKSPACE_PAGES);
  await ensureDir(REPORTS_DIR);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[UI] 请求处理失败：', err);
      sendJson(res, 500, {
        ok: false,
        message: (err as Error).message
      });
    }
  });

  server.listen(DEFAULT_PORT, () => {
    console.log(`Vue2/Vue3 回归对比 UI 已启动：`);
    console.log(`http://localhost:${DEFAULT_PORT}`);
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (url.pathname === '/api/env/status' && req.method === 'GET') return handleEnvStatus(res);
  if (url.pathname === '/api/browser' && req.method === 'GET') return handleBrowser(res);
  if (url.pathname === '/api/env/browser' && req.method === 'POST') return handleSaveBrowserPath(req, res);
  if (url.pathname === '/api/pages' && req.method === 'GET') return handleListPages(res);
  if (url.pathname === '/api/pages' && req.method === 'POST') return handleSavePage(req, res);
  if (url.pathname === '/api/import/pages' && req.method === 'POST') return handleImportPages(req, res);
  if (url.pathname === '/api/plan' && req.method === 'GET') return handlePlan(url, res);
  if (url.pathname.startsWith('/api/pages/') && req.method === 'GET') return handleGetPage(url, res);
  if (url.pathname === '/api/reports' && req.method === 'GET') return handleListReports(res);
  if (url.pathname === '/api/jobs' && req.method === 'GET') return handleListJobs(res);
  if (url.pathname === '/api/manual-confirmations' && req.method === 'GET') return handleGetManualConfirmations(res);
  if (url.pathname === '/api/manual-confirmations' && req.method === 'POST') return handleSaveManualConfirmation(req, res);
  if (url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/stop') && req.method === 'POST') return handleStopJob(url, res);
  if (url.pathname.startsWith('/api/jobs/') && req.method === 'GET') return handleGetJob(url, res);
  if (url.pathname === '/api/run/compare' && req.method === 'POST') return handleRunCommand(req, res, 'compare');
  if (url.pathname === '/api/run/validate' && req.method === 'POST') return handleRunCommand(req, res, 'validate');
  if (url.pathname === '/api/run/check-selectors' && req.method === 'POST') return handleRunCommand(req, res, 'check-selectors');
  if (url.pathname === '/api/run/auth' && req.method === 'POST') return handleRunCommand(req, res, 'auth');
  if (url.pathname === '/api/run/install-deps' && req.method === 'POST') return handleInstallDeps(res);
  if (url.pathname === '/api/run/install-browsers' && req.method === 'POST') return handleInstallBrowsers(res);
  if (url.pathname.startsWith('/reports/')) return serveFile(path.join(ROOT, decodeURIComponent(url.pathname.slice(1))), res);

  const staticPath = url.pathname === '/' ? path.join(UI_DIR, 'index.html') : path.resolve(UI_DIR, url.pathname.replace(/^\//, ''));
  if (isInside(UI_DIR, staticPath) && await pathExists(staticPath)) return serveFile(staticPath, res);
  sendJson(res, 404, { ok: false, message: 'Not found' });
}

async function handleBrowser(res: http.ServerResponse): Promise<void> {
  const browserPath = await detectBrowserExecutable();
  sendJson(res, 200, { ok: true, browserPath: browserPath ?? '' });
}

async function handleEnvStatus(res: http.ServerResponse): Promise<void> {
  const [browserPath, corepackVersion] = await Promise.all([
    detectBrowserExecutable().catch(() => undefined),
    runQuick(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', ['--version']).catch(() => '')
  ]);
  const nodeModules = await pathExists(path.join(ROOT, 'node_modules'));
  const tsxBin = await pathExists(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.CMD' : 'tsx'));
  const playwrightBin = await pathExists(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.CMD' : 'playwright'));
  const authPath = path.join(ROOT, 'workspace', 'auth', 'storageState.json');
  const authExists = await pathExists(authPath);
  const pages = await loadAllPageConfigFiles(WORKSPACE_PAGES).catch(() => []);
  const reports = await findReports().catch(() => []);

  sendJson(res, 200, {
    ok: true,
    root: ROOT,
    port: DEFAULT_PORT,
    nodeVersion: process.version,
    corepackVersion: corepackVersion.trim(),
    dependenciesInstalled: nodeModules && tsxBin,
    playwrightInstalled: playwrightBin,
    browserPath: browserPath ?? '',
    browserReady: Boolean(browserPath),
    authExists,
    authPath: path.relative(ROOT, authPath),
    pagesCount: pages.length,
    reportsCount: reports.length
  });
}

async function handleSaveBrowserPath(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ browserPath?: string }>(req);
  const browserPath = (body.browserPath ?? '').trim();
  if (!browserPath) return sendJson(res, 400, { ok: false, message: 'browserPath 不能为空' });
  if (!await pathExists(browserPath)) return sendJson(res, 400, { ok: false, message: `浏览器文件不存在：${browserPath}` });
  await writeEnvValue('CHROMIUM_EXECUTABLE_PATH', browserPath, path.join(ROOT, '.env'));
  process.env.CHROMIUM_EXECUTABLE_PATH = browserPath;
  sendJson(res, 200, { ok: true, message: '已写入 .env', browserPath });
}

async function handleListPages(res: http.ServerResponse): Promise<void> {
  const loaded = await loadAllPageConfigFiles(WORKSPACE_PAGES).catch(() => []);
  const pages = loaded.map(x => ({
    file: path.relative(ROOT, x.file),
    pageKey: x.cfg.pageKey,
    pageName: x.cfg.pageName,
    vue2Url: x.cfg.vue2Url,
    vue3Url: x.cfg.vue3Url,
    metricsCount: x.cfg.metrics?.length ?? 0,
    filtersCount: x.cfg.filters?.length ?? 0,
    interactionsCount: x.cfg.interactions?.length ?? 0,
    autoDiscoverInteractions: x.cfg.autoDiscoverInteractions !== false
  }));
  sendJson(res, 200, { ok: true, pages });
}

async function handleGetPage(url: URL, res: http.ServerResponse): Promise<void> {
  const pageKey = decodeURIComponent(url.pathname.split('/').pop() || '');
  const configs = await loadPageConfigs(WORKSPACE_PAGES, pageKey);
  const loaded = await loadAllPageConfigFiles(WORKSPACE_PAGES);
  const item = loaded.find(x => x.cfg.pageKey === configs[0].pageKey || x.baseName === pageKey);
  const raw = item ? await fs.readFile(item.file, 'utf8') : YAML.stringify(configs[0]);
  const issues = collectConfigIssues(configs[0], item?.file ?? '').map(x => ({ ...x, file: x.file ? path.relative(ROOT, x.file) : undefined }));
  sendJson(res, 200, { ok: true, page: configs[0], yaml: raw, file: item ? path.relative(ROOT, item.file) : '', issues });
}

async function handleSavePage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ mode?: 'form' | 'yaml'; yaml?: string; page?: Partial<PageConfig> }>(req);
  let cfg: PageConfig;
  let raw: string;

  if (body.mode === 'yaml') {
    if (!body.yaml?.trim()) return sendJson(res, 400, { ok: false, message: 'YAML 不能为空' });
    try {
      cfg = YAML.parse(body.yaml) as PageConfig;
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: `YAML 解析失败：${(err as Error).message}` });
    }
    raw = body.yaml;
  } else {
    const p = body.page ?? {};
    cfg = {
      pageKey: String(p.pageKey ?? '').trim(),
      pageName: String(p.pageName ?? '').trim(),
      testStrategy: (p as any).testStrategy ?? 'standard',
      vue2Url: String(p.vue2Url ?? '').trim(),
      vue3Url: String(p.vue3Url ?? '').trim(),
      waitForSelector: String(p.waitForSelector ?? 'body').trim() || 'body',
      waitForNetworkIdle: p.waitForNetworkIdle !== false,
      waitAfterMs: Number(p.waitAfterMs ?? 300),
      readiness: defaultReadinessConfig(),
      timeoutMs: Number(p.timeoutMs ?? 60000),
      storageState: String(p.storageState ?? 'workspace/auth/storageState.json').trim(),
      autoDiscoverInteractions: p.autoDiscoverInteractions !== false,
      interactionCheckMode: 'conservative',
      interactionExtraPolicy: 'manual',
      interactionUniqueTextMatch: true,
      reportVue3ExtraInteractions: true,
      metrics: [],
      filters: [],
      tabs: { strategy: 'all', items: [] },
      interactions: []
    };
    raw = YAML.stringify(cfg);
  }

  const issues = collectConfigIssues(cfg).filter(x => x.level === 'ERROR');
  if (issues.length) return sendJson(res, 400, { ok: false, message: issues.map(x => `${x.field}: ${x.message}`).join('\n') });

  await ensureDir(WORKSPACE_PAGES);
  const file = path.join(WORKSPACE_PAGES, `${cfg.pageKey}.yaml`);
  await fs.writeFile(file, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
  sendJson(res, 200, { ok: true, message: '页面配置已保存', file: path.relative(ROOT, file), pageKey: cfg.pageKey });
}

async function handleImportPages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ format?: string; content?: string; xlsxBase64?: string; strategy?: string }>(req);
  const format = body.format ?? 'markdown';
  const strategy = (body.strategy ?? 'standard') as any;
  let rows;
  if (format === 'xlsx') {
    if (!body.xlsxBase64) return sendJson(res, 400, { ok: false, message: 'xlsxBase64 不能为空' });
    rows = await parseXlsxPageTable(Buffer.from(body.xlsxBase64, 'base64'));
  } else if (format === 'csv') {
    rows = parseCsvPageTable(body.content ?? '');
  } else {
    rows = parseMarkdownPageTable(body.content ?? '');
  }
  const result = await importPageRows(rows, WORKSPACE_PAGES, strategy);
  sendJson(res, 200, { ok: true, ...result, files: result.files.map(f => path.relative(ROOT, f)) });
}

async function handlePlan(url: URL, res: http.ServerResponse): Promise<void> {
  const pageKey = url.searchParams.get('page') || undefined;
  const mode = (url.searchParams.get('mode') || 'standard') as any;
  const configs = await loadPageConfigs(WORKSPACE_PAGES, pageKey);
  const plans = configs.map(c => estimatePlan(c, mode));
  sendJson(res, 200, { ok: true, plans });
}

async function handleListReports(res: http.ServerResponse): Promise<void> {
  const reports = await findReports();
  sendJson(res, 200, { ok: true, reports });
}

async function handleListJobs(res: http.ServerResponse): Promise<void> {
  sendJson(res, 200, { ok: true, jobs: [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
}

async function handleGetJob(url: URL, res: http.ServerResponse): Promise<void> {
  const id = decodeURIComponent(url.pathname.split('/').pop() || '');
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { ok: false, message: '任务不存在' });
  sendJson(res, 200, { ok: true, job });
}

async function handleStopJob(url: URL, res: http.ServerResponse): Promise<void> {
  const id = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0] || '');
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { ok: false, message: '任务不存在' });
  if (job.status !== 'running') return sendJson(res, 200, { ok: true, message: '任务已结束', job });
  const child = jobProcesses.get(id);
  if (!child) return sendJson(res, 200, { ok: true, message: '任务进程不可用', job });
  killJobProcess(child);
  job.logs.push('用户已请求终止任务。');
  sendJson(res, 200, { ok: true, message: '已发送终止信号', job });
}

function killJobProcess(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false }).on('error', () => undefined);
  } else {
    child.kill('SIGTERM');
  }
}

async function handleRunCommand(req: http.IncomingMessage, res: http.ServerResponse, type: RunCommandType): Promise<void> {
  const body: { page?: string; mode?: string; headed?: boolean; concurrency?: number; runs?: number } = await readJson<{ page?: string; mode?: string; headed?: boolean; concurrency?: number; runs?: number }>(req).catch(() => ({}));
  const args: string[] = [];
  let script = '';
  let title = '';

  if (type === 'compare') {
    script = 'compare';
    title = '执行页面对比';
    if (body.page) args.push('--page', body.page);
    args.push('--mode', ['default','single-filter','targeted','smoke','standard','strict'].includes(String(body.mode)) ? String(body.mode) : 'default');
    if (body.headed) args.push('--headed');
    args.push('--concurrency', String(body.concurrency || 1));
    args.push('--runs', String(body.runs || 1));
  } else if (type === 'validate') {
    script = 'validate-config';
    title = '配置校验';
    if (body.page) args.push('--page', body.page);
  } else if (type === 'check-selectors') {
    script = 'check-selectors';
    title = '选择器健康检查';
    if (body.page) args.push('--page', body.page);
    if (body.headed) args.push('--headed');
  } else {
    script = 'auth';
    title = '登录态保存';
  }

  const job = runNpmScript(type, title, script, args);
  sendJson(res, 200, { ok: true, job });
}

async function handleInstallDeps(res: http.ServerResponse): Promise<void> {
  const job = runCommandJob('install-deps', '安装项目依赖', process.platform === 'win32' ? 'corepack.cmd' : 'corepack', ['pnpm', 'install']);
  sendJson(res, 200, { ok: true, job });
}

async function handleInstallBrowsers(res: http.ServerResponse): Promise<void> {
  const job = runNpmScript('install-browsers', '安装 Playwright 浏览器', 'install:browsers', []);
  sendJson(res, 200, { ok: true, job });
}

function runNpmScript(type: JobType, title: string, script: string, args: string[]): JobInfo {
  // 与工程 pnpm-lock.yaml / AGENTS.md 保持一致，统一通过 corepack pnpm 拉起子任务。
  const runnerCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  const runnerArgs = ['pnpm', 'run', script, ...(args.length ? ['--', ...args] : [])];
  return runCommandJob(type, title, runnerCmd, runnerArgs);
}

function runCommandJob(type: JobType, title: string, command: string, args: string[]): JobInfo {
  const id = `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const job: JobInfo = {
    id,
    type,
    title,
    status: 'running',
    command: `${command} ${args.join(' ')}`,
    startedAt: new Date().toISOString(),
    logs: []
  };
  jobs.set(id, job);
  pruneJobs();

  let child: ChildProcess;
  try {
    const target = createSpawnTarget(command, args);
    child = spawn(target.command, target.args, { cwd: ROOT, env: process.env, shell: false });
  } catch (err) {
    job.status = 'error';
    job.endedAt = new Date().toISOString();
    job.logs.push(`启动失败：${(err as Error).message}`);
    return job;
  }
  jobProcesses.set(id, child);
  const push = (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) job.logs.push(line);
    }
    if (job.logs.length > 1000) job.logs.splice(0, job.logs.length - 1000);
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('error', err => {
    if (job.status === 'running') job.status = 'error';
    job.endedAt = new Date().toISOString();
    job.logs.push(`启动失败：${err.message}`);
    jobProcesses.delete(id);
  });
  child.on('close', (code, signal) => {
    job.exitCode = code;
    if (signal || code === null) job.status = 'stopped';
    else job.status = code === 0 ? 'success' : 'error';
    job.endedAt = new Date().toISOString();
    jobProcesses.delete(id);
  });
  return job;
}

async function runQuick(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return await new Promise<string>((resolve) => {
    let output = '';
    let child: ChildProcess | undefined;
    const timer = setTimeout(() => {
      child?.kill();
      resolve(output);
    }, timeoutMs);
    try {
      const target = createSpawnTarget(command, args);
      child = spawn(target.command, target.args, { cwd: ROOT, env: process.env, shell: false });
    } catch {
      clearTimeout(timer);
      resolve(output);
      return;
    }
    child.stdout?.on('data', chunk => { output += chunk.toString(); });
    child.stderr?.on('data', chunk => { output += chunk.toString(); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(output);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

function createSpawnTarget(command: string, args: string[]): { command: string; args: string[] } {
  if (!shouldRunViaCmd(command)) return { command, args };
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ')]
  };
}

function shouldRunViaCmd(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function quoteCmdArg(value: string): string {
  return /^[\w.\-/:\\=]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter(j => j.status !== 'running')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let removable = jobs.size - MAX_JOBS;
  for (const job of finished) {
    if (removable <= 0) break;
    jobs.delete(job.id);
    jobProcesses.delete(job.id);
    removable--;
  }
}


async function handleGetManualConfirmations(res: http.ServerResponse): Promise<void> {
  const items = await readManualConfirmations();
  sendJson(res, 200, { ok: true, items });
}

async function handleSaveManualConfirmation(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<{ page?: string; item?: string; status?: string; reason?: string; reportDir?: string }>(req);
  const item = {
    id: `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    page: String(body.page || '').trim(),
    item: String(body.item || '').trim(),
    status: String(body.status || '已确认').trim(),
    reason: String(body.reason || '').trim(),
    reportDir: String(body.reportDir || '').trim(),
    createdAt: new Date().toISOString()
  };
  if (!item.page || !item.item) return sendJson(res, 400, { ok: false, message: '页面和确认项不能为空' });
  const items = await readManualConfirmations();
  items.unshift(item);
  await ensureDir(path.dirname(MANUAL_CONFIRMATIONS));
  await fs.writeFile(MANUAL_CONFIRMATIONS, JSON.stringify(items, null, 2), 'utf8');
  sendJson(res, 200, { ok: true, item });
}

async function readManualConfirmations(): Promise<any[]> {
  if (!await pathExists(MANUAL_CONFIRMATIONS)) return [];
  const raw = await fs.readFile(MANUAL_CONFIRMATIONS, 'utf8').catch(() => '[]');
  try { return JSON.parse(raw); } catch { return []; }
}

async function findReports(): Promise<Array<{ dir: string; html?: string; xlsx?: string; json?: string; mtimeMs: number }>> {
  if (!await pathExists(REPORTS_DIR)) return [];
  const result: Array<{ dir: string; html?: string; xlsx?: string; json?: string; mtimeMs: number }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.map(e => e.name));
    if (names.has('report.html') || names.has('report.xlsx') || names.has('result.json')) {
      const stat = await fs.stat(dir);
      const rel = path.relative(ROOT, dir).replaceAll(path.sep, '/');
      result.push({
        dir: rel,
        html: names.has('report.html') ? `${rel}/report.html` : undefined,
        xlsx: names.has('report.xlsx') ? `${rel}/report.xlsx` : undefined,
        json: names.has('result.json') ? `${rel}/result.json` : undefined,
        mtimeMs: stat.mtimeMs
      });
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
  }
  await walk(REPORTS_DIR);
  return result.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50);
}

function isInside(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

async function serveFile(filePath: string, res: http.ServerResponse): Promise<void> {
  const resolved = path.resolve(filePath);
  if (!isInside(ROOT, resolved) || !await pathExists(resolved)) return sendJson(res, 404, { ok: false, message: 'File not found' });
  const ext = path.extname(resolved).toLowerCase();
  const contentType = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'application/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : ext === '.json' ? 'application/json; charset=utf-8'
    : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : ext === '.png' ? 'image/png'
    : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fsSync.createReadStream(resolved).pipe(res);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as T : {} as T;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import type { Config, PageConfig } from '../config/load.js';
import type { Side } from '../types.js';
import { ToolError } from '../types.js';
import { sleep, urlMatch } from '../util/misc.js';
import type { Logger } from '../util/log.js';

/** 页面世界注入：请求水位计数、DOM 变更计数、性能观察器、关闭动画 */
const INIT_SCRIPT = `(() => {
  const S = window.__vmr = { pending: 0, mutations: 0, perf: { fcp: 0, lcp: 0, longTasksTotal: 0 } };
  const _fetch = window.fetch;
  window.fetch = function (...a) { S.pending++; return _fetch.apply(this, a).finally(() => S.pending--); };
  const _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...a) { return _open.apply(this, a); };
  XMLHttpRequest.prototype.send = function (...a) {
    S.pending++;
    this.addEventListener('loadend', () => S.pending--, { once: true });
    return _send.apply(this, a);
  };
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') S.perf.fcp = e.startTime; })
      .observe({ type: 'paint', buffered: true });
    new PerformanceObserver(l => { const es = l.getEntries(); if (es.length) S.perf.lcp = es[es.length - 1].startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) S.perf.longTasksTotal += e.duration; })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) { /* 旧内核降级 */ }
  const boot = () => {
    try {
      new MutationObserver(() => S.mutations++).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      const st = document.createElement('style');
      st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
      document.head.appendChild(st);
    } catch (e) { /* ignore */ }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();`;

/** 浏览器可执行文件解析顺序：环境变量 → @sparticuz/chromium（npm 内嵌二进制）→ Playwright 官方缓存 */
export async function launchBrowser(cfg: Config, log: Logger): Promise<Browser> {
  const opts: Parameters<typeof chromium.launch>[0] = { headless: cfg.global.browser.headless };
  const envPath = process.env.VMR_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) {
    opts.executablePath = envPath;
    opts.args = ['--no-sandbox', '--disable-gpu'];
    log.info(`使用环境变量指定的浏览器：${envPath}`);
  } else {
    try {
      const sp = await import('@sparticuz/chromium');
      const mod = (sp as { default?: { executablePath: () => Promise<string>; args: string[] } }).default ?? (sp as never);
      opts.executablePath = await mod.executablePath();
      // 关键：sparticuz 默认带 --single-process / --no-zygote / --headless='shell'，
      // 在需要多个 BrowserContext 的场景下，关闭任一 context 会连带杀死整个浏览器进程。
      // 这里过滤掉这些致命参数，改由 Playwright 的 headless 选项接管无头模式。
      const banned = new Set(['--single-process', '--no-zygote']);
      opts.args = [...mod.args.filter(a => !banned.has(a) && !a.startsWith('--headless')), '--no-sandbox', '--disable-gpu'];
      log.info(`使用 @sparticuz/chromium 内嵌浏览器：${opts.executablePath}`);
    } catch {
      log.info('未找到内嵌浏览器，回退 Playwright 官方 Chromium（需先 npx playwright install chromium）');
    }
  }
  return chromium.launch(opts);
}

export async function createSideContext(browser: Browser, cfg: Config, side: Side, log: Logger): Promise<BrowserContext> {
  const g = cfg.global;
  const storage = g.auth.strategy === 'storage' ? g.auth.storageState[side === 'v2' ? 'vue2' : 'vue3'] : undefined;
  if (g.auth.strategy === 'storage' && storage && !existsSync(storage)) {
    throw new ToolError('auth-missing', `登录态文件不存在：${storage}。请先运行 vmr login 或从本机导出后放置到该路径。`);
  }
  const ctx = await browser.newContext({
    viewport: g.browser.viewport,
    locale: g.browser.locale,
    timezoneId: g.browser.timezone,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    storageState: storage && existsSync(storage) ? storage : undefined,
  });
  await ctx.addInitScript(INIT_SCRIPT);
  if (g.browser.freezeClock) await ctx.clock.setFixedTime(new Date('2026-01-01T10:00:00+08:00'));
  ctx.on('page', p => {
    p.on('pageerror', e => log.warn(`[${side}] 页面脚本错误：${String(e.message).slice(0, 300)}`));
  });
  return ctx;
}

export function pageUrl(cfg: Config, page: PageConfig, side: Side): string {
  const base = side === 'v2' ? cfg.global.baseUrl.vue2 : cfg.global.baseUrl.vue3;
  const path = side === 'v2' ? page.path.vue2 : page.path.vue3;
  return base.replace(/\/$/, '') + path;
}

export interface ReadyDeps { apiDoneCheck?: (globs: string[]) => boolean; generic?: boolean }

/**
 * 请求水位就绪协议：pending===0 且 DOM 变更连续静默 quietMs，叠加页面级 selector / apiDone 条件。
 * 超时抛 ToolError('ready-timeout')。
 */
export async function waitReady(page: Page, pageCfg: PageConfig, cfg: Config, log: Logger, deps: ReadyDeps = {}): Promise<void> {
  const { quietMs, readyTimeoutMs } = cfg.global.waits;
  const started = Date.now();
  const sel = deps.generic ? undefined : pageCfg.readyWhen.selector;
  if (sel) {
    await page.waitForSelector(sel, { timeout: readyTimeoutMs, state: 'visible' })
      .catch(() => { throw new ToolError('ready-timeout', `等待就绪选择器超时：${sel}`); });
  }
  let quietStart = 0;
  let lastMut = -1;
  while (true) {
    if (Date.now() - started > readyTimeoutMs) throw new ToolError('ready-timeout', `就绪协议超时（${readyTimeoutMs}ms）：pending 未清零或 DOM 未静默`);
    const snap = await page.evaluate(() => {
      const s = (window as unknown as { __vmr?: { pending: number; mutations: number } }).__vmr;
      return s ? { pending: s.pending, mutations: s.mutations } : { pending: 0, mutations: 0 };
    }).catch(() => ({ pending: 0, mutations: 0 }));
    const apiOk = deps.generic || pageCfg.readyWhen.apiDone.length === 0 || !deps.apiDoneCheck || deps.apiDoneCheck(pageCfg.readyWhen.apiDone);
    const quietNow = snap.pending === 0 && snap.mutations === lastMut && apiOk;
    lastMut = snap.mutations;
    if (quietNow) {
      if (!quietStart) quietStart = Date.now();
      if (Date.now() - quietStart >= quietMs) break;
    } else quietStart = 0;
    await sleep(100);
  }
  log.debug(`就绪协议达成，用时 ${Date.now() - started}ms`);
}

/** 自动滚动到底再回顶（触发懒加载），两端行为一致 */
export async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const total = document.body.scrollHeight;
    for (let y = 0; y < total; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  }).catch(() => undefined);
}

/** 图表静默：连续两次全部 canvas 内容哈希一致（上限 chartSettleMs） */
export async function chartsSettled(page: Page, cfg: Config): Promise<void> {
  const limit = cfg.global.waits.chartSettleMs;
  const started = Date.now();
  let prev = '';
  while (Date.now() - started < limit) {
    const cur = await page.evaluate(() => {
      const cs = Array.from(document.querySelectorAll('canvas')).slice(0, 8);
      return cs.map(c => { try { return c.toDataURL().length + ':' + c.toDataURL().slice(-64); } catch { return 'x'; } }).join('|');
    }).catch(() => '');
    if (cur && cur === prev) return;
    prev = cur;
    await sleep(200);
  }
}

/** 判定 URL 是否命中给定 glob 列表（供 apiDone 使用的辅助闭包在 net 层构造） */
export { urlMatch };

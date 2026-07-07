import type { Locator, Page } from 'playwright';
import type { PageConfig } from './types.js';
import { sleep } from './utils.js';

const initScriptPages = new WeakSet<Page>();

const DEFAULT_LOADING_SELECTORS = [
  '.loading',
  '.loader',
  '.spinner',
  '.skeleton',
  '.ant-spin',
  '.ant-spin-spinning',
  '.ant-skeleton',
  '.el-loading-mask',
  '.el-loading-spinner',
  '.el-skeleton',
  '.van-loading',
  '.v-loading',
  '[aria-busy="true"]',
  '[data-loading="true"]',
  '[data-testid*="loading" i]',
  '[class*="loading" i]',
  '[class*="spinner" i]',
  '[class*="skeleton" i]'
];

const DEFAULT_LOADING_TEXT = [
  'loading',
  'loading...',
  'loading…',
  '加载中',
  '正在加载',
  '数据加载中',
  '请稍候'
];

export async function openAndWait(page: Page, url: string, cfg: PageConfig): Promise<number> {
  const start = Date.now();
  await installStabilityHooks(page, cfg);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs ?? 60_000 });
  await waitPageReady(page, cfg);
  return Date.now() - start;
}

export async function waitPageReady(page: Page, cfg: PageConfig): Promise<void> {
  const timeout = cfg.timeoutMs ?? 60_000;
  const started = Date.now();
  await installStabilityHooks(page, cfg);

  if (cfg.waitForSelector) {
    await page.locator(cfg.waitForSelector).first().waitFor({ state: 'visible', timeout: remainingTimeout(started, timeout) });
  }

  for (const selector of cfg.waitForHiddenSelectors ?? []) {
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout: remainingTimeout(started, timeout) }).catch(() => undefined);
  }

  if (cfg.waitForNetworkIdle !== false) {
    await page.waitForLoadState('networkidle', { timeout: Math.min(remainingTimeout(started, timeout), 10_000) }).catch(() => undefined);
  }

  await waitForStablePage(page, cfg, started, timeout);
  await waitForCanvasSettled(page, cfg);
  await sleep(cfg.waitAfterMs ?? 200);
}

export async function preparePageForScreenshot(page: Page, cfg: PageConfig): Promise<void> {
  await waitPageReady(page, cfg);
  if (cfg.readiness?.autoScrollBeforeScreenshot !== false) {
    await autoScrollPage(page);
    await waitForStablePage(page, cfg, Date.now(), Math.min(cfg.timeoutMs ?? 60_000, 15_000));
    await waitForCanvasSettled(page, cfg);
  }
}

async function installStabilityHooks(page: Page, cfg: PageConfig): Promise<void> {
  const disableAnimations = cfg.readiness?.disableAnimations !== false;
  const script = buildStabilityInitScript(disableAnimations);
  if (!initScriptPages.has(page)) {
    initScriptPages.add(page);
    await page.addInitScript(script).catch(() => undefined);
  }
  await page.evaluate(script).catch(() => undefined);
}

function buildStabilityInitScript(disableAnimations: boolean): string {
  return `(() => {
    const state = window.__vrcReady = window.__vrcReady || { pending: 0, mutations: 0 };
    const inc = () => { state.pending += 1; };
    const dec = () => { state.pending = Math.max(0, state.pending - 1); };

    if (!window.__vrcReadyInstalled) {
      window.__vrcReadyInstalled = true;
      const rawFetch = window.fetch;
      if (rawFetch && !window.__vrcFetchPatched) {
        window.__vrcFetchPatched = true;
        window.fetch = function (...args) {
          inc();
          try {
            return Promise.resolve(rawFetch.apply(this, args)).finally(dec);
          } catch (err) {
            dec();
            throw err;
          }
        };
      }

      const rawSend = XMLHttpRequest.prototype.send;
      if (rawSend && !window.__vrcXhrPatched) {
        window.__vrcXhrPatched = true;
        XMLHttpRequest.prototype.send = function (...args) {
          inc();
          this.addEventListener('loadend', dec, { once: true });
          try {
            return rawSend.apply(this, args);
          } catch (err) {
            dec();
            throw err;
          }
        };
      }
    }

    const boot = () => {
      try {
        if (!window.__vrcMutationObserver) {
          window.__vrcMutationObserver = new MutationObserver(() => { state.mutations += 1; });
          window.__vrcMutationObserver.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true
          });
        }
        if (${disableAnimations ? 'true' : 'false'} && !document.getElementById('__vrc_disable_animations')) {
          const style = document.createElement('style');
          style.id = '__vrc_disable_animations';
          style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
          document.head.appendChild(style);
        }
      } catch {}
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  })();`;
}

interface PageStableState {
  pending: number;
  mutations: number;
  readyState: string;
  loadingMatches: string[];
}

async function waitForStablePage(page: Page, cfg: PageConfig, started: number, timeout: number): Promise<void> {
  const readiness = cfg.readiness ?? {};
  const waitForRequestIdle = readiness.waitForRequestIdle !== false;
  const waitForDomStable = readiness.waitForDomStable !== false;
  const quietMs = readiness.stableQuietMs ?? 800;

  if (!waitForRequestIdle && !waitForDomStable && readiness.waitForCommonLoading === false && !readiness.loadingSelectors?.length && !cfg.waitForHiddenSelectors?.length) {
    return;
  }

  let quietStart = 0;
  let lastMutations = -1;
  let lastState: PageStableState | undefined;

  while (Date.now() - started < timeout) {
    const state = await readStableState(page, cfg).catch((err) => ({
      pending: waitForRequestIdle ? 1 : 0,
      mutations: waitForDomStable ? lastMutations + 1 : lastMutations,
      readyState: `evaluate-error:${String((err as Error).message ?? err).slice(0, 160)}`,
      loadingMatches: ['readiness-state-unavailable']
    }));
    lastState = state;

    const requestIdle = !waitForRequestIdle || state.pending === 0;
    const domStable = !waitForDomStable || state.mutations === lastMutations;
    const loadingGone = state.loadingMatches.length === 0;
    lastMutations = state.mutations;

    if (requestIdle && domStable && loadingGone) {
      if (!quietStart) quietStart = Date.now();
      if (Date.now() - quietStart >= quietMs) return;
    } else {
      quietStart = 0;
    }
    await sleep(100);
  }

  const loading = lastState?.loadingMatches.length ? `；仍检测到 Loading：${lastState.loadingMatches.slice(0, 5).join(', ')}` : '';
  throw new Error(
    `页面稳定等待超时：pending=${lastState?.pending ?? 'unknown'}，mutations=${lastState?.mutations ?? 'unknown'}，readyState=${lastState?.readyState ?? 'unknown'}${loading}。` +
    `如果页面有长轮询，可在 readiness.waitForRequestIdle=false；如果有自定义 Loading，请配置 readiness.loadingSelectors 或 waitForHiddenSelectors。`
  );
}

async function readStableState(page: Page, cfg: PageConfig): Promise<PageStableState> {
  const selectors = loadingSelectors(cfg);
  const loadingText = loadingTextNeedles(cfg);
  const script = `(() => {
    const selectors = ${jsonForScript(selectors)};
    const loadingText = ${jsonForScript(loadingText)};
    const state = window.__vrcReady || { pending: 0, mutations: 0 };
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const matches = [];

    for (const selector of selectors) {
      try {
        const hit = Array.from(document.querySelectorAll(selector)).some(isVisible);
        if (hit) matches.push(selector);
      } catch {
      }
    }

    const needles = loadingText.map(x => String(x).replace(/\\s+/g, '').toLowerCase()).filter(Boolean);
    if (needles.length) {
      const nodes = Array.from(document.querySelectorAll('body *')).slice(0, 2500);
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const raw = el.innerText || el.textContent || '';
        const compact = raw.replace(/\\s+/g, '').toLowerCase();
        if (!compact || compact.length > 40) continue;
        const normalized = compact.replace(/[.\\u3002\\u2026]+$/g, '');
        const looksLikeLoading = /^loading[.\\u3002\\u2026]*$/i.test(compact)
          || needles.some(n => normalized === n || (normalized.length <= n.length + 6 && normalized.includes(n)));
        if (looksLikeLoading) {
          matches.push('text:' + raw.trim().slice(0, 30));
          break;
        }
      }
    }

    return {
      pending: state.pending || 0,
      mutations: state.mutations || 0,
      readyState: document.readyState,
      loadingMatches: Array.from(new Set(matches))
    };
  })();`;
  return await page.evaluate(script) as PageStableState;
}

function loadingSelectors(cfg: PageConfig): string[] {
  const readiness = cfg.readiness ?? {};
  const selectors = [
    ...(cfg.waitForHiddenSelectors ?? []),
    ...(readiness.waitForCommonLoading === false ? [] : DEFAULT_LOADING_SELECTORS),
    ...(readiness.loadingSelectors ?? [])
  ];
  return [...new Set(selectors.map(s => String(s).trim()).filter(Boolean))];
}

function loadingTextNeedles(cfg: PageConfig): string[] {
  const readiness = cfg.readiness ?? {};
  return readiness.waitForCommonLoading === false && !readiness.loadingText?.length
    ? []
    : [...new Set([...(readiness.waitForCommonLoading === false ? [] : DEFAULT_LOADING_TEXT), ...(readiness.loadingText ?? [])])];
}

async function waitForCanvasSettled(page: Page, cfg: PageConfig): Promise<void> {
  if (cfg.readiness?.waitForCanvasStable === false) return;
  const timeout = cfg.readiness?.canvasSettleMs ?? 1200;
  const started = Date.now();
  let previous = '';

  while (Date.now() - started < timeout) {
    const current = await page.evaluate(`(() => {
      const canvases = Array.from(document.querySelectorAll('canvas')).slice(0, 12);
      return canvases.map(canvas => {
        try {
          const data = canvas.toDataURL();
          return canvas.width + 'x' + canvas.height + ':' + data.length + ':' + data.slice(-80);
        } catch {
          return canvas.width + 'x' + canvas.height + ':tainted';
        }
      }).join('|');
    })();`).then(value => String(value ?? '')).catch(() => '');
    if (!current) return;
    if (current === previous) return;
    previous = current;
    await sleep(200);
  }
}

async function autoScrollPage(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    const maxY = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < maxY; y += step) {
      window.scrollTo(0, y);
      await new Promise(resolve => window.setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
  })();`).catch(() => undefined);
}

function remainingTimeout(started: number, timeout: number): number {
  return Math.max(1_000, timeout - (Date.now() - started));
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export async function safeText(page: Page, selector: string, all = false, attribute?: string): Promise<string> {
  const loc = page.locator(selector);
  const count = await loc.count();
  if (count === 0) return '[NOT_FOUND]';

  if (all) {
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      values.push(await readOne(loc.nth(i), attribute));
    }
    return values.join('\n---\n');
  }
  return readOne(loc.first(), attribute);
}

async function readOne(locator: Locator, attribute?: string): Promise<string> {
  if (attribute) return (await locator.getAttribute(attribute)) ?? '';
  return await locator.innerText({ timeout: 10_000 });
}

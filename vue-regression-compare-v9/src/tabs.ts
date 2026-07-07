import type { Page } from 'playwright';
import type { PageConfig, TabConfig } from './types.js';
import { waitPageReady } from './pageOps.js';
import { sleep } from './utils.js';

export function getEnabledTabs(cfg: PageConfig): TabConfig[] {
  const tabs = Array.isArray(cfg.tabs) ? cfg.tabs : cfg.tabs?.items ?? [];
  const strategy = Array.isArray(cfg.tabs) ? 'all' : cfg.tabs?.strategy ?? 'all';
  if (strategy === 'none') return [];
  return tabs.filter(t => t.enabled !== false);
}

export async function applyTab(page: Page, tab: TabConfig, cfg: PageConfig): Promise<number> {
  const start = Date.now();
  const timeout = cfg.timeoutMs ?? 60_000;
  await page.locator(tab.selector).first().click({ timeout });
  if (tab.waitForSelector) await page.locator(tab.waitForSelector).first().waitFor({ state: 'visible', timeout });
  await waitPageReady(page, cfg);
  if (tab.waitAfterMs) await sleep(tab.waitAfterMs);
  return Date.now() - start;
}

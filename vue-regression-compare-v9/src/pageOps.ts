import type { Locator, Page } from 'playwright';
import type { PageConfig } from './types.js';
import { sleep } from './utils.js';

export async function openAndWait(page: Page, url: string, cfg: PageConfig): Promise<number> {
  const start = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs ?? 60_000 });
  await waitPageReady(page, cfg);
  return Date.now() - start;
}

export async function waitPageReady(page: Page, cfg: PageConfig): Promise<void> {
  const timeout = cfg.timeoutMs ?? 60_000;
  if (cfg.waitForSelector) {
    await page.locator(cfg.waitForSelector).first().waitFor({ state: 'visible', timeout });
  }
  for (const selector of cfg.waitForHiddenSelectors ?? []) {
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout }).catch(() => undefined);
  }
  if (cfg.waitForNetworkIdle !== false) {
    await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
  }
  await sleep(cfg.waitAfterMs ?? 200);
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

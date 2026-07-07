import path from 'node:path';
import type { Page } from 'playwright';
import type { PageConfig, ScenarioContext } from './types.js';
import { ensureDir, relPath, sanitizeFileName } from './utils.js';

export interface ScreenshotPair {
  vue2?: string;
  vue3?: string;
}

export async function capturePagePair(
  vue2Page: Page,
  vue3Page: Page,
  cfg: PageConfig,
  scenario: ScenarioContext,
  suffix: string,
  outputDir: string,
  options: { vue2HighlightSelector?: string; vue3HighlightSelector?: string; fullPage?: boolean } = {}
): Promise<ScreenshotPair> {
  const dir = path.join(outputDir, 'screenshots', sanitizeFileName(cfg.pageKey), sanitizeFileName(scenario.scenarioName));
  await ensureDir(dir);

  const base = sanitizeFileName(suffix);
  const vue2Path = path.join(dir, `${base}_vue2.png`);
  const vue3Path = path.join(dir, `${base}_vue3.png`);

  await Promise.all([
    options.vue2HighlightSelector ? highlightElements(vue2Page, options.vue2HighlightSelector) : Promise.resolve(0),
    options.vue3HighlightSelector ? highlightElements(vue3Page, options.vue3HighlightSelector) : Promise.resolve(0)
  ]);

  await Promise.all([
    vue2Page.screenshot({ path: vue2Path, fullPage: options.fullPage ?? true }),
    vue3Page.screenshot({ path: vue3Path, fullPage: options.fullPage ?? true })
  ]);

  await Promise.all([
    options.vue2HighlightSelector ? clearHighlights(vue2Page, options.vue2HighlightSelector) : Promise.resolve(),
    options.vue3HighlightSelector ? clearHighlights(vue3Page, options.vue3HighlightSelector) : Promise.resolve()
  ]).catch(() => undefined);

  return { vue2: relPath(outputDir, vue2Path), vue3: relPath(outputDir, vue3Path) };
}

async function highlightElements(page: Page, selector: string): Promise<number> {
  const loc = page.locator(selector);
  const count = await loc.count().catch(() => 0);
  if (count === 0) return 0;

  await loc.evaluateAll((elements) => {
    for (const el of elements.slice(0, 30)) {
      const node = el as HTMLElement;
      node.dataset.__vrcOldOutline = node.style.outline;
      node.dataset.__vrcOldBoxShadow = node.style.boxShadow;
      node.dataset.__vrcOldBackground = node.style.backgroundColor;
      node.style.outline = '3px solid #ff1f1f';
      node.style.boxShadow = '0 0 0 4px rgba(255, 31, 31, 0.28)';
      node.style.backgroundColor = 'rgba(255, 0, 0, 0.08)';
      node.scrollIntoView({ block: 'center', inline: 'center' });
    }
  });
  return count;
}

async function clearHighlights(page: Page, selector: string): Promise<void> {
  const loc = page.locator(selector);
  const count = await loc.count().catch(() => 0);
  if (count === 0) return;

  await loc.evaluateAll((elements) => {
    for (const el of elements) {
      const node = el as HTMLElement;
      node.style.outline = node.dataset.__vrcOldOutline ?? '';
      node.style.boxShadow = node.dataset.__vrcOldBoxShadow ?? '';
      node.style.backgroundColor = node.dataset.__vrcOldBackground ?? '';
      delete node.dataset.__vrcOldOutline;
      delete node.dataset.__vrcOldBoxShadow;
      delete node.dataset.__vrcOldBackground;
    }
  });
}

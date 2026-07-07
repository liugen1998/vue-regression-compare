import type { Page } from 'playwright';
import type { CollectedMetric, MetricConfig } from './types.js';
import { safeText } from './pageOps.js';

export async function collectMetrics(page: Page, metrics: MetricConfig[] = []): Promise<CollectedMetric[]> {
  const result: CollectedMetric[] = [];
  for (const metric of metrics) {
    try {
      result.push({
        name: metric.name,
        selector: metric.selector,
        attribute: metric.attribute,
        value: await safeText(page, metric.selector, metric.all ?? metric.type === 'table', metric.attribute)
      });
    } catch (err) {
      result.push({
        name: metric.name,
        selector: metric.selector,
        attribute: metric.attribute,
        value: `[ERROR] ${(err as Error).message}`
      });
    }
  }
  return result;
}

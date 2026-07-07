import type { ReadinessConfig } from './types.js';

export function defaultReadinessConfig(): ReadinessConfig {
  return {
    waitForRequestIdle: true,
    waitForDomStable: true,
    stableQuietMs: 800,
    waitForCommonLoading: true,
    waitForCanvasStable: true,
    canvasSettleMs: 1200,
    autoScrollBeforeScreenshot: true,
    disableAnimations: true
  };
}

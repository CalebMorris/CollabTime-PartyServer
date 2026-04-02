import { monitorEventLoopDelay } from 'perf_hooks';
import type { IntervalHistogram } from 'perf_hooks';

const NS_PER_MS = 1e6;

let histogram: IntervalHistogram | null = null;

function nanosToMs(nanos: number): number {
  return Number.isNaN(nanos) ? 0 : nanos / NS_PER_MS;
}

export function startEventLoopMonitor(): void {
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
}

export function stopEventLoopMonitor(): void {
  histogram?.disable();
  histogram = null;
}

export function getEventLoopStats() {
  if (!histogram) return null;
  return {
    meanMs: nanosToMs(histogram.mean),
    p50Ms: nanosToMs(histogram.percentile(50)),
    p95Ms: nanosToMs(histogram.percentile(95)),
    p99Ms: nanosToMs(histogram.percentile(99)),
    maxMs: nanosToMs(histogram.max),
  };
}

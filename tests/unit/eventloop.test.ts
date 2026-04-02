import { describe, it, expect, afterEach } from 'vitest';
import {
  startEventLoopMonitor,
  stopEventLoopMonitor,
  getEventLoopStats,
} from '../../src/metrics/eventloop.js';

afterEach(() => {
  stopEventLoopMonitor();
});

describe('getEventLoopStats', () => {
  it('returns null before the monitor is started', () => {
    expect(getEventLoopStats()).toBeNull();
  });

  it('returns an object with the expected shape after starting', () => {
    startEventLoopMonitor();
    const stats = getEventLoopStats();
    expect(stats).not.toBeNull();
    expect(stats).toMatchObject({
      meanMs: expect.any(Number),
      p50Ms: expect.any(Number),
      p95Ms: expect.any(Number),
      p99Ms: expect.any(Number),
      maxMs: expect.any(Number),
    });
  });

  it('returns non-negative values', () => {
    startEventLoopMonitor();
    const stats = getEventLoopStats()!;
    expect(stats.meanMs).toBeGreaterThanOrEqual(0);
    expect(stats.p50Ms).toBeGreaterThanOrEqual(0);
    expect(stats.p95Ms).toBeGreaterThanOrEqual(0);
    expect(stats.p99Ms).toBeGreaterThanOrEqual(0);
    expect(stats.maxMs).toBeGreaterThanOrEqual(0);
  });

  it('returns null after the monitor is stopped', () => {
    startEventLoopMonitor();
    stopEventLoopMonitor();
    expect(getEventLoopStats()).toBeNull();
  });
});

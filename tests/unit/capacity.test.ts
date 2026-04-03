import { describe, it, expect, vi, afterEach } from 'vitest';
import * as eventloop from '../../src/metrics/eventloop.js';

vi.mock('../../src/metrics/eventloop.js', () => ({
  getEventLoopStats: vi.fn(),
}));

import { isAcceptingRooms } from '../../src/metrics/capacity.js';

const mockStats = (p95Ms: number) =>
  vi.mocked(eventloop.getEventLoopStats).mockReturnValue({
    meanMs: 0, p50Ms: 0, p95Ms, p99Ms: 0, maxMs: 0,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isAcceptingRooms', () => {
  it('returns true when p95 lag is below threshold', () => {
    mockStats(50);
    expect(isAcceptingRooms(100)).toBe(true);
  });

  it('returns false when p95 lag equals threshold', () => {
    mockStats(100);
    expect(isAcceptingRooms(100)).toBe(false);
  });

  it('returns false when p95 lag exceeds threshold', () => {
    mockStats(200);
    expect(isAcceptingRooms(100)).toBe(false);
  });

  it('returns true when stats are null (monitor not running)', () => {
    vi.mocked(eventloop.getEventLoopStats).mockReturnValue(null);
    expect(isAcceptingRooms(100)).toBe(true);
  });
});

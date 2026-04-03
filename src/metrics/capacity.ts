import { getEventLoopStats } from './eventloop.js';

export function isAcceptingRooms(thresholdMs: number): boolean {
  const stats = getEventLoopStats();
  if (!stats) return true; // monitor not running — safe default, don't block
  return stats.p95Ms < thresholdMs;
}

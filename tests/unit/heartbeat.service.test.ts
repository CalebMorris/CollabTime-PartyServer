import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { startHeartbeat, stopHeartbeat } from '../../src/services/heartbeat.service.js';

// Minimal WebSocket mock using EventEmitter so .on/.removeListener work correctly
function makeSocket() {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    readyState: 1, // WebSocket.OPEN
    ping: vi.fn(),
  });
  return socket as unknown as import('ws').WebSocket;
}

function makeStore() {
  return {
    getRoom: vi.fn().mockReturnValue(null),
    setGracePeriodEntry: vi.fn(),
    deleteGracePeriodEntry: vi.fn(),
    getGracePeriodEntry: vi.fn().mockReturnValue(null),
  } as any;
}

const OPTIONS = { pingMs: 20_000, pongTimeoutMs: 10_000, gracePeriodMs: 30_000 };

describe('heartbeat.service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('does not accumulate pong listeners across heartbeat cycles', () => {
    const socket = makeSocket();
    const store = makeStore();
    const onGraceExpired = vi.fn();

    startHeartbeat(socket as any, store, OPTIONS, onGraceExpired);

    // Simulate several pong/heartbeat cycles
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(OPTIONS.pingMs);  // trigger ping
      socket.emit('pong');                     // respond with pong
    }

    const pongListenerCount = socket.listenerCount('pong');
    expect(pongListenerCount).toBe(1);
  });

  it('removes pong listener when stopHeartbeat is called', () => {
    const socket = makeSocket();
    const store = makeStore();

    startHeartbeat(socket as any, store, OPTIONS, vi.fn());
    expect(socket.listenerCount('pong')).toBe(1);

    stopHeartbeat(socket as any);
    expect(socket.listenerCount('pong')).toBe(0);
  });
});

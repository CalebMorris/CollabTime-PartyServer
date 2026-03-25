import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { startHeartbeat, stopHeartbeat } from '../../src/services/heartbeat.service.js';

vi.mock('../../src/ws/registry.js', () => ({
  registry: {
    getMeta: vi.fn(),
    cleanupSocket: vi.fn(),
  },
}));

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcastToRoom: vi.fn(),
}));

// Minimal WebSocket mock using EventEmitter so .on/.removeListener work correctly
function makeSocket() {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    readyState: 1, // WebSocket.OPEN
    ping: vi.fn(),
    terminate: vi.fn(),
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

  it('terminates socket when pong timeout fires', async () => {
    const { registry } = await import('../../src/ws/registry.js');
    const socket = makeSocket();
    const store = makeStore();
    const participant = { isConnected: true, lastHeartbeatMs: Date.now() };
    const room = { participants: new Map([['p-token', participant]]) };

    vi.mocked(registry.getMeta).mockReturnValue({
      participantToken: 'p-token',
      roomCode: 'a-b-c',
      sessionToken: 's-token',
    } as any);
    store.getRoom.mockReturnValue(room);

    startHeartbeat(socket as any, store, OPTIONS, vi.fn());
    vi.advanceTimersByTime(OPTIONS.pingMs);           // fire ping
    vi.advanceTimersByTime(OPTIONS.pongTimeoutMs);    // fire pong timeout (no pong sent)

    expect((socket as any).terminate).toHaveBeenCalledOnce();
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

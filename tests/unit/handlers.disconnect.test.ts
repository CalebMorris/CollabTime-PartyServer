import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createHandlers } from '../../src/ws/handlers.js';

vi.mock('../../src/ws/registry.js', () => ({
  registry: {
    getMeta: vi.fn(),
    cleanupSocket: vi.fn(),
    registerSocket: vi.fn(),
  },
}));

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcastToRoom: vi.fn(),
  sendTo: vi.fn(),
}));

vi.mock('../../src/services/heartbeat.service.js', () => ({
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
  cancelGracePeriod: vi.fn(),
}));

vi.mock('../../src/services/wordlist.service.js', () => ({
  generateNickname: vi.fn().mockReturnValue('happy-cat'),
}));

vi.mock('../../src/utils/crypto.js', () => ({
  generateToken: vi.fn().mockReturnValue('s'.repeat(32)),
  generateParticipantToken: vi.fn().mockReturnValue('p'.repeat(32)),
}));

vi.mock('../../src/services/room.service.js', () => ({
  canTransitionToActive: vi.fn().mockReturnValue(false),
  canTransitionToWaiting: vi.fn().mockReturnValue(false),
  transitionToActive: vi.fn(),
  transitionToWaiting: vi.fn(),
  checkLockIn: vi.fn().mockReturnValue(null),
  lockIn: vi.fn(),
}));

function makeSocket() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(),
  }) as unknown as import('ws').WebSocket;
}

function makeStore(overrides?: Partial<ReturnType<typeof makeStore>>) {
  return {
    getRoom: vi.fn(),
    setRoom: vi.fn(),
    setParticipantIndex: vi.fn(),
    deleteParticipantIndex: vi.fn(),
    getParticipantIndex: vi.fn(),
    getGracePeriodEntry: vi.fn().mockReturnValue(null),
    setGracePeriodEntry: vi.fn(),
    deleteGracePeriodEntry: vi.fn(),
    ...overrides,
  } as any;
}

const TEST_CONFIG = {
  PORT: 0,
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  CORS_ORIGIN: undefined,
  HEARTBEAT_PING_MS: 20_000,
  HEARTBEAT_PONG_TIMEOUT_MS: 10_000,
  HEARTBEAT_GRACE_PERIOD_MS: 30_000,
  ROOM_TTL_MS: 7_200_000,
  GC_INTERVAL_MS: 10_000,
  RATE_LIMIT_WINDOW_MS: 300_000,
  RATE_LIMIT_MAX_ATTEMPTS: 10,
  RATE_LIMIT_BACKOFF_AFTER: 3,
  MAX_PARTICIPANTS_PER_ROOM: 50,
};

describe('handleJoin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('does not call store.setRoom when joining a locked_in room', async () => {
    const { registry } = await import('../../src/ws/registry.js');
    vi.mocked(registry.getMeta).mockReturnValue(undefined);

    const socket = makeSocket();
    const store = makeStore();
    const lockedRoom = {
      code: 'a-b-c',
      state: 'locked_in' as const,
      participants: new Map(),
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    };
    store.getRoom.mockReturnValue(lockedRoom);

    const rateLimiter = { isRateLimited: vi.fn().mockReturnValue(false), recordFailure: vi.fn() } as any;
    const { handleMessage } = createHandlers(store, TEST_CONFIG, rateLimiter);
    handleMessage(socket, JSON.stringify({ type: 'join', roomCode: 'a-b-c', protocolVersion: '1.0' }), '127.0.0.1');

    expect(store.setRoom).not.toHaveBeenCalled();
  });
});

describe('handleDisconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('starts grace period when a connected participant socket closes', async () => {
    const { registry } = await import('../../src/ws/registry.js');
    const { broadcastToRoom } = await import('../../src/ws/broadcast.js');

    const socket = makeSocket();
    const store = makeStore();
    const participant = { isConnected: true, participantToken: 'p-token', sessionToken: 's-token' };
    const room = { participants: new Map([['p-token', participant]]) };

    vi.mocked(registry.getMeta).mockReturnValue({
      participantToken: 'p-token',
      sessionToken: 's-token',
      roomCode: 'a-b-c',
    } as any);
    store.getRoom.mockReturnValue(room);

    const { handleDisconnect } = createHandlers(store, TEST_CONFIG, { isRateLimited: vi.fn().mockReturnValue(false), recordFailure: vi.fn() } as any);
    handleDisconnect(socket);

    expect(participant.isConnected).toBe(false);
    expect(broadcastToRoom).toHaveBeenCalledWith('a-b-c', {
      type: 'participant_disconnected',
      participantToken: 'p-token',
    });
    expect(store.setGracePeriodEntry).toHaveBeenCalledWith('s-token', expect.objectContaining({
      roomCode: 'a-b-c',
      participantToken: 'p-token',
    }));
  });

  it('does nothing when socket has no registry entry', async () => {
    const { registry } = await import('../../src/ws/registry.js');
    const { broadcastToRoom } = await import('../../src/ws/broadcast.js');

    const socket = makeSocket();
    const store = makeStore();
    vi.mocked(registry.getMeta).mockReturnValue(undefined);

    const { handleDisconnect } = createHandlers(store, TEST_CONFIG, { isRateLimited: vi.fn().mockReturnValue(false), recordFailure: vi.fn() } as any);
    handleDisconnect(socket);

    expect(broadcastToRoom).not.toHaveBeenCalled();
    expect(store.setGracePeriodEntry).not.toHaveBeenCalled();
  });
});

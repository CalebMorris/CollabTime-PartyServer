import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { InMemoryStore } from '../../src/store/memory.js';
import { RateLimitService } from '../../src/services/ratelimit.service.js';
import { createHandlers } from '../../src/ws/handlers.js';
import { registry } from '../../src/ws/registry.js';
import { broadcastToRoom } from '../../src/ws/broadcast.js';
import { initWordlist } from '../../src/services/wordlist.service.js';
import type { ServerMessage } from '../../src/models/messages.js';

// Initialize wordlist once for all tests
initWordlist();

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

async function buildServer() {
  const store = new InMemoryStore({ gcIntervalMs: 999_999 });
  const rateLimiter = new RateLimitService({
    windowMs: TEST_CONFIG.RATE_LIMIT_WINDOW_MS,
    maxAttempts: TEST_CONFIG.RATE_LIMIT_MAX_ATTEMPTS,
    backoffAfter: TEST_CONFIG.RATE_LIMIT_BACKOFF_AFTER,
  });
  const handlers = createHandlers(store, TEST_CONFIG, rateLimiter);

  const fastify = Fastify({ logger: false });
  await fastify.register(websocket);
  fastify.get('/health', async () => ({ status: 'ok' }));
  fastify.register(async (f) => {
    f.get('/ws', { websocket: true }, (socket, req) => {
      const ip = req.ip;
      socket.on('message', (data) => {
        handlers.handleMessage(socket as unknown as WebSocket, data.toString(), ip);
      });
      socket.on('close', () => {
        handlers.handleDisconnect(socket as unknown as WebSocket);
      });
      socket.on('error', () => {
        handlers.handleDisconnect(socket as unknown as WebSocket);
      });
    });
  });

  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const address = fastify.server.address() as { port: number };
  return { fastify, store, url: `ws://127.0.0.1:${address.port}/ws` };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()) as ServerMessage);
    });
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

async function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${count} messages, got ${messages.length}`)), timeoutMs);
    function onMessage(data: WebSocket.RawData) {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(messages);
      }
    }
    ws.on('message', onMessage);
  });
}

describe('Phase 1 & 2 integration', () => {
  let fastify: Awaited<ReturnType<typeof buildServer>>['fastify'];
  let url: string;

  beforeEach(async () => {
    const result = await buildServer();
    fastify = result.fastify;
    url = result.url;
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('GET /health returns 200', async () => {
    const address = fastify.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('single client joins — receives joined with waiting state', async () => {
    const alice = await connect(url);
    const joinedPromise = nextMessage(alice);
    send(alice, { type: 'join', roomCode: 'red-fox-run' });
    const msg = await joinedPromise;

    expect(msg.type).toBe('joined');
    if (msg.type === 'joined') {
      expect(msg.room.state).toBe('waiting');
      expect(msg.nickname).toBeTruthy();
      expect(msg.sessionToken).toMatch(/^[0-9a-f]{32}$/);
      expect(msg.protocolVersion).toBe('1.0');
    }
    alice.close();
  });

  it('two clients join same room — room activates', async () => {
    const alice = await connect(url);
    const bob = await connect(url);

    send(alice, { type: 'join', roomCode: 'blue-owl-sky' });
    const aliceJoined = await nextMessage(alice);
    expect(aliceJoined.type).toBe('joined');

    // Bob joins — Alice gets room_activated, Bob gets joined with active state
    const aliceActivatedPromise = nextMessage(alice);
    send(bob, { type: 'join', roomCode: 'blue-owl-sky' });

    const [bobJoined, aliceActivated] = await Promise.all([
      nextMessage(bob),
      aliceActivatedPromise,
    ]);

    expect(aliceActivated.type).toBe('room_activated');
    expect(bobJoined.type).toBe('joined');
    if (bobJoined.type === 'joined') {
      expect(bobJoined.room.state).toBe('active');
    }

    alice.close();
    bob.close();
  });

  it('late joiner receives snapshot with existing proposals', async () => {
    const alice = await connect(url);
    const bob = await connect(url);

    send(alice, { type: 'join', roomCode: 'green-cat-hill' });
    await nextMessage(alice); // joined

    send(bob, { type: 'join', roomCode: 'green-cat-hill' });
    await nextMessage(alice); // room_activated
    await nextMessage(bob);   // joined

    // Alice proposes
    const aliceProposalBroadcastP = nextMessage(bob);
    send(alice, { type: 'propose', epochMs: 1_711_209_600_000 });
    await nextMessage(alice); // proposal_updated for alice
    await aliceProposalBroadcastP; // bob also gets proposal_updated

    // Carol joins late
    const carol = await connect(url);
    send(carol, { type: 'join', roomCode: 'green-cat-hill' });
    const carolJoined = await nextMessage(carol);

    expect(carolJoined.type).toBe('joined');
    if (carolJoined.type === 'joined') {
      const aliceInRoom = carolJoined.room.participants.find(
        p => p.proposalEpochMs === 1_711_209_600_000,
      );
      expect(aliceInRoom).toBeDefined();
    }

    alice.close();
    bob.close();
    carol.close();
  });

  it('two clients propose same minute — locked_in broadcast', async () => {
    const alice = await connect(url);
    const bob = await connect(url);

    send(alice, { type: 'join', roomCode: 'pink-wolf-lake' });
    await nextMessage(alice);

    send(bob, { type: 'join', roomCode: 'pink-wolf-lake' });
    await nextMessage(alice); // room_activated
    await nextMessage(bob);   // joined

    // Both propose — same minute, 30s apart
    const epoch1 = 1_711_209_600_000;
    const epoch2 = 1_711_209_630_000; // same minute

    send(alice, { type: 'propose', epochMs: epoch1 });
    await nextMessage(alice); // proposal_updated
    await nextMessage(bob);   // proposal_updated

    // Start collecting BEFORE sending so no messages are missed
    const aliceMsgsPromise = collectMessages(alice, 2);
    const bobMsgsPromise = collectMessages(bob, 2);

    // Bob proposes same minute → triggers lock-in
    send(bob, { type: 'propose', epochMs: epoch2 });

    const [aliceMsgs, bobMsgs] = await Promise.all([aliceMsgsPromise, bobMsgsPromise]);

    expect(aliceMsgs.some(m => m.type === 'locked_in')).toBe(true);
    expect(bobMsgs.some(m => m.type === 'locked_in')).toBe(true);

    const aliceLocked = aliceMsgs.find(m => m.type === 'locked_in');
    if (aliceLocked?.type === 'locked_in') {
      // epochMs should be the truncated minute
      expect(aliceLocked.epochMs % 60_000).toBe(0);
    }

    alice.close();
    bob.close();
  });

  it('proposals in different minutes do not trigger lock-in', async () => {
    const alice = await connect(url);
    const bob = await connect(url);

    send(alice, { type: 'join', roomCode: 'gray-deer-path' });
    await nextMessage(alice);

    send(bob, { type: 'join', roomCode: 'gray-deer-path' });
    await nextMessage(alice);
    await nextMessage(bob);

    const epoch1 = 1_711_209_600_000;
    const epoch2 = epoch1 + 60_000; // different minute

    send(alice, { type: 'propose', epochMs: epoch1 });
    await nextMessage(alice);
    await nextMessage(bob);

    send(bob, { type: 'propose', epochMs: epoch2 });
    const [aliceUpdate, bobUpdate] = await Promise.all([
      nextMessage(alice),
      nextMessage(bob),
    ]);

    expect(aliceUpdate.type).toBe('proposal_updated');
    expect(bobUpdate.type).toBe('proposal_updated');
    // No locked_in follows

    alice.close();
    bob.close();
  });

  it('late joiner with no proposal does not block lock-in', async () => {
    const alice = await connect(url);
    const bob = await connect(url);
    const carol = await connect(url);

    send(alice, { type: 'join', roomCode: 'tan-bear-cave' });
    await nextMessage(alice);

    send(bob, { type: 'join', roomCode: 'tan-bear-cave' });
    await nextMessage(alice); // room_activated
    await nextMessage(bob);

    send(carol, { type: 'join', roomCode: 'tan-bear-cave' });
    await nextMessage(alice); // participant_joined
    await nextMessage(bob);   // participant_joined
    await nextMessage(carol); // joined

    // Alice and Bob propose same minute; Carol has no proposal
    const epoch = 1_711_209_600_000;
    send(alice, { type: 'propose', epochMs: epoch });
    // 3 clients get proposal_updated
    await Promise.all([nextMessage(alice), nextMessage(bob), nextMessage(carol)]);

    send(bob, { type: 'propose', epochMs: epoch + 15_000 }); // same minute
    // All 3 get messages; at least one per client should be locked_in
    const msgs = await Promise.all([
      collectMessages(alice, 2),
      collectMessages(bob, 2),
      collectMessages(carol, 2),
    ]);

    expect(msgs[0].some(m => m.type === 'locked_in')).toBe(true);
    expect(msgs[1].some(m => m.type === 'locked_in')).toBe(true);
    expect(msgs[2].some(m => m.type === 'locked_in')).toBe(true);

    alice.close();
    bob.close();
    carol.close();
  });

  it('propose to locked_in room returns ROOM_NOT_FOUND error', async () => {
    const alice = await connect(url);
    const bob = await connect(url);

    send(alice, { type: 'join', roomCode: 'cold-mole-ridge' });
    await nextMessage(alice);
    send(bob, { type: 'join', roomCode: 'cold-mole-ridge' });
    await nextMessage(alice);
    await nextMessage(bob);

    // Lock in
    const epoch = 1_711_209_600_000;
    send(alice, { type: 'propose', epochMs: epoch });
    await nextMessage(alice);
    await nextMessage(bob);
    send(bob, { type: 'propose', epochMs: epoch });
    // Consume locked_in messages
    await collectMessages(alice, 2);
    await collectMessages(bob, 2);

    // Now try to propose again
    send(alice, { type: 'propose', epochMs: epoch + 120_000 });
    const errMsg = await nextMessage(alice);
    expect(errMsg.type).toBe('error');
    if (errMsg.type === 'error') {
      expect(errMsg.code).toBe('ROOM_NOT_FOUND');
    }

    alice.close();
    bob.close();
  });

  it('join to locked_in room returns ROOM_NOT_FOUND error', async () => {
    const alice = await connect(url);
    const bob = await connect(url);

    send(alice, { type: 'join', roomCode: 'warm-hawk-nest' });
    await nextMessage(alice);
    send(bob, { type: 'join', roomCode: 'warm-hawk-nest' });
    await nextMessage(alice);
    await nextMessage(bob);

    const epoch = 1_711_209_600_000;
    send(alice, { type: 'propose', epochMs: epoch });
    await nextMessage(alice);
    await nextMessage(bob);
    send(bob, { type: 'propose', epochMs: epoch });
    await collectMessages(alice, 2);
    await collectMessages(bob, 2);

    const carol = await connect(url);
    send(carol, { type: 'join', roomCode: 'warm-hawk-nest' });
    const errMsg = await nextMessage(carol);
    expect(errMsg.type).toBe('error');
    if (errMsg.type === 'error') {
      expect(errMsg.code).toBe('ROOM_NOT_FOUND');
    }

    alice.close();
    bob.close();
    carol.close();
  });
});

describe('Phase 3: resilience', () => {
  let fastify: Awaited<ReturnType<typeof buildServer>>['fastify'];
  let store: Awaited<ReturnType<typeof buildServer>>['store'];
  let url: string;

  beforeEach(async () => {
    const result = await buildServer();
    fastify = result.fastify;
    store = result.store;
    url = result.url;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fastify.close();
  });

  it('rejoin within grace period — same nickname and proposal intact', async () => {
    const alice = await connect(url);
    const bob = await connect(url);

    send(alice, { type: 'join', roomCode: 'swift-crane-bay' });
    const aliceJoined = await nextMessage(alice);
    expect(aliceJoined.type).toBe('joined');
    if (aliceJoined.type !== 'joined') return;

    const { sessionToken, participantToken, nickname } = aliceJoined;

    send(bob, { type: 'join', roomCode: 'swift-crane-bay' });
    await nextMessage(alice); // room_activated
    await nextMessage(bob);   // joined

    // Alice proposes
    send(alice, { type: 'propose', epochMs: 1_711_209_600_000 });
    await nextMessage(alice); // proposal_updated
    await nextMessage(bob);   // proposal_updated

    // Simulate heartbeat timeout: mark disconnected, add grace entry, remove from registry
    const room = store.getRoom('swift-crane-bay')!;
    const participant = room.participants.get(participantToken)!;
    participant.isConnected = false;
    store.setGracePeriodEntry(sessionToken, {
      roomCode: 'swift-crane-bay',
      participantToken,
      expiresAtMs: Date.now() + 30_000,
      timer: setTimeout(() => {}, 30_000),
    });
    registry.cleanupSocket(alice as unknown as WebSocket);
    alice.terminate();
    // Note: no participant_disconnected broadcast — we bypassed the heartbeat to inject
    // the grace entry directly; the heartbeat unit tests cover that flow.

    // Alice reconnects
    const aliceNew = await connect(url);
    const bobReconnectedP = nextMessage(bob);
    send(aliceNew, { type: 'rejoin', roomCode: 'swift-crane-bay', sessionToken });

    const [rejoined, bobReconnected] = await Promise.all([
      nextMessage(aliceNew),
      bobReconnectedP,
    ]);

    expect(rejoined.type).toBe('joined');
    if (rejoined.type === 'joined') {
      expect(rejoined.nickname).toBe(nickname);
      expect(rejoined.participantToken).toBe(participantToken);
      expect(rejoined.room.state).toBe('active');
      const aliceInSnapshot = rejoined.room.participants.find(p => p.participantToken === participantToken);
      expect(aliceInSnapshot?.proposalEpochMs).toBe(1_711_209_600_000);
    }
    expect(bobReconnected.type).toBe('participant_reconnected');

    aliceNew.close();
    bob.close();
  });

  it('rejoin after grace period expires — REJOIN_FAILED', async () => {
    const socket = await connect(url);
    // No grace entry exists for this session token
    send(socket, { type: 'rejoin', roomCode: 'dead-room-one', sessionToken: 'a'.repeat(32) });
    const msg = await nextMessage(socket);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.code).toBe('REJOIN_FAILED');
    }
    socket.close();
  });

  it('rejoin with wrong room code — REJOIN_FAILED', async () => {
    const alice = await connect(url);
    send(alice, { type: 'join', roomCode: 'real-room-abc' });
    const joined = await nextMessage(alice);
    expect(joined.type).toBe('joined');
    if (joined.type !== 'joined') return;

    const { sessionToken, participantToken } = joined;

    // Add grace entry for correct room
    store.setGracePeriodEntry(sessionToken, {
      roomCode: 'real-room-abc',
      participantToken,
      expiresAtMs: Date.now() + 30_000,
      timer: setTimeout(() => {}, 30_000),
    });
    alice.terminate();

    const socket = await connect(url);
    send(socket, { type: 'rejoin', roomCode: 'wrong-room-xyz', sessionToken });
    const msg = await nextMessage(socket);
    expect(msg.type).toBe('error');
    if (msg.type === 'error') {
      expect(msg.code).toBe('REJOIN_FAILED');
    }
    socket.close();
  });

  it('room expiry — GC fires room_expired broadcast and closes sockets', async () => {
    // Build a dedicated server AFTER activating fake timers so the store's
    // setInterval is captured by the fake timer system.
    vi.useFakeTimers();

    const expireStore = new InMemoryStore({
      gcIntervalMs: 1_000,
      roomTtlMs: 5_000,
      onRoomExpired: (roomCode, room) => {
        broadcastToRoom(roomCode, { type: 'room_expired' });
        const sockets = registry.cleanupRoom(roomCode);
        for (const s of sockets) s.close();
        for (const pt of room.participants.keys()) expireStore.deleteParticipantIndex(pt);
      },
    });
    const expireRateLimiter = new RateLimitService({
      windowMs: 300_000,
      maxAttempts: 10,
      backoffAfter: 3,
    });
    const expireHandlers = createHandlers(expireStore, TEST_CONFIG, expireRateLimiter);

    const expireFastify = Fastify({ logger: false });
    await expireFastify.register(websocket);
    expireFastify.register(async (f) => {
      f.get('/ws', { websocket: true }, (socket, req) => {
        const ip = req.ip;
        socket.on('message', (data) => {
          expireHandlers.handleMessage(socket as unknown as WebSocket, data.toString(), ip);
        });
        socket.on('close', () => {
          expireHandlers.handleDisconnect(socket as unknown as WebSocket);
        });
      });
    });
    await expireFastify.listen({ port: 0, host: '127.0.0.1' });
    const expireUrl = `ws://127.0.0.1:${(expireFastify.server.address() as { port: number }).port}/ws`;

    const alice = await connect(expireUrl);
    send(alice, { type: 'join', roomCode: 'aged-room-old' });
    const joined = await nextMessage(alice);
    expect(joined.type).toBe('joined');

    const expiredP = nextMessage(alice);

    // Set lastActivityMs far in the past so GC considers it expired
    const room = expireStore.getRoom('aged-room-old')!;
    room.lastActivityMs = Date.now() - 6_000; // 6s ago, TTL is 5s

    // Advance fake timers past the GC interval (1s)
    vi.advanceTimersByTime(1_001);

    const expired = await expiredP;
    expect(expired.type).toBe('room_expired');

    await expireFastify.close();
    expireStore.stop();
  });
});

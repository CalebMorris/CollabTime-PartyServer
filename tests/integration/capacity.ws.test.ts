import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { InMemoryStore } from '../../src/store/memory.js';
import { RateLimitService } from '../../src/services/ratelimit.service.js';
import { createHandlers } from '../../src/ws/handlers.js';
import { initWordlist } from '../../src/services/wordlist.service.js';
import type { ServerMessage } from '../../src/models/messages.js';

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
  EVENT_LOOP_LAG_THRESHOLD_MS: 100,
};

async function buildServer(capacityChecker: () => boolean) {
  const store = new InMemoryStore({ gcIntervalMs: 999_999 });
  const rateLimiter = new RateLimitService({
    windowMs: TEST_CONFIG.RATE_LIMIT_WINDOW_MS,
    maxAttempts: TEST_CONFIG.RATE_LIMIT_MAX_ATTEMPTS,
    backoffAfter: TEST_CONFIG.RATE_LIMIT_BACKOFF_AFTER,
  });
  const handlers = createHandlers(store, TEST_CONFIG, rateLimiter, undefined, capacityChecker);

  const fastify = Fastify({ logger: false });
  await fastify.register(websocket);
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
  return { fastify, store, rateLimiter, url: `ws://127.0.0.1:${address.port}/ws` };
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

describe('capacity gate in join handler', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  afterEach(async () => {
    await server.fastify.close();
  });

  describe('when server is at capacity', () => {
    beforeEach(async () => {
      server = await buildServer(() => false);
    });

    it('rejects new room creation with SERVER_AT_CAPACITY error', async () => {
      const ws = await connect(server.url);
      const message$ = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'join', roomCode: 'red-fox-run' }));
      const response = await message$;
      ws.close();

      expect(response).toMatchObject({ type: 'error', code: 'SERVER_AT_CAPACITY' });
    });

    it('does not increment rate limiter on SERVER_AT_CAPACITY', async () => {
      const ip = '127.0.0.1';
      // Exhaust close to limit but not over
      for (let i = 0; i < 2; i++) {
        const ws = await connect(server.url);
        const message$ = nextMessage(ws);
        ws.send(JSON.stringify({ type: 'join', roomCode: 'red-fox-run' }));
        await message$;
        ws.close();
      }
      // Rate limiter should not have accumulated failures from capacity rejections
      expect(server.rateLimiter.isRateLimited(ip)).toBe(false);
    });

    it('allows joining an existing room when at capacity', async () => {
      // Pre-create a room by inserting it directly into the store
      const room = {
        code: 'blue-cat-run',
        state: 'waiting' as const,
        participants: new Map(),
        createdAtMs: Date.now(),
        lastActivityMs: Date.now(),
      };
      server.store.setRoom('blue-cat-run', room);

      const ws = await connect(server.url);
      const message$ = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'join', roomCode: 'blue-cat-run' }));
      const response = await message$;
      ws.close();

      expect(response.type).toBe('joined');
    });
  });

  describe('when server has capacity', () => {
    beforeEach(async () => {
      server = await buildServer(() => true);
    });

    it('allows new room creation', async () => {
      const ws = await connect(server.url);
      const message$ = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'join', roomCode: 'red-fox-run' }));
      const response = await message$;
      ws.close();

      expect(response.type).toBe('joined');
    });
  });
});

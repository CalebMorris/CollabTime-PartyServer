import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { loadConfig } from './config/index.js';
import { initWordlist } from './services/wordlist.service.js';
import { InMemoryStore } from './store/memory.js';
import { RateLimitService } from './services/ratelimit.service.js';
import { createHandlers } from './ws/handlers.js';
import { broadcastToRoom } from './ws/broadcast.js';
import { registry } from './ws/registry.js';
import { startEventLoopMonitor, stopEventLoopMonitor, getEventLoopStats } from './metrics/eventloop.js';
import { isAcceptingRooms } from './metrics/capacity.js';
import WebSocket from 'ws';

const config = loadConfig();
initWordlist();
startEventLoopMonitor();

console.info(`[capacity] EVENT_LOOP_LAG_THRESHOLD_MS=${config.EVENT_LOOP_LAG_THRESHOLD_MS}ms`);

let isShuttingDown = false;

// Lightweight per-IP rate limiter for GET /capacity (10 requests per minute)
const CAPACITY_RATE_LIMIT_MAX = 10;
const CAPACITY_RATE_LIMIT_WINDOW_MS = 60_000;
const capacityRequestCounts = new Map<string, { count: number; windowStartMs: number }>();

const capacityRateLimiter = {
  isAllowed(ip: string): boolean {
    const now = Date.now();
    const entry = capacityRequestCounts.get(ip);
    if (!entry || now - entry.windowStartMs > CAPACITY_RATE_LIMIT_WINDOW_MS) {
      capacityRequestCounts.set(ip, { count: 1, windowStartMs: now });
      return true;
    }
    if (entry.count >= CAPACITY_RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
  },
};

const fastify = Fastify({ logger: { level: config.LOG_LEVEL } });

const store = new InMemoryStore({
  gcIntervalMs: config.GC_INTERVAL_MS,
  roomTtlMs: config.ROOM_TTL_MS,
  onRoomExpired: (roomCode, room) => {
    fastify.log.info({ roomCode }, 'room_expired');
    broadcastToRoom(roomCode, { type: 'room_expired' });
    const sockets = registry.cleanupRoom(roomCode);
    for (const socket of sockets) {
      socket.close();
    }
    void room; // participant index cleanup handled by gc()
  },
});

const rateLimiter = new RateLimitService({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  maxAttempts: config.RATE_LIMIT_MAX_ATTEMPTS,
  backoffAfter: config.RATE_LIMIT_BACKOFF_AFTER,
});

const handlers = createHandlers(store, config, rateLimiter, {
  info: (msg, data) => fastify.log.info(data ?? {}, msg),
  warn: (msg, data) => fastify.log.warn(data ?? {}, msg),
  error: (msg, data) => fastify.log.error(data ?? {}, msg),
}, () => isAcceptingRooms(config.EVENT_LOOP_LAG_THRESHOLD_MS));

// CORS
await fastify.register(cors, {
  origin: config.NODE_ENV === 'development'
    ? '*'
    : (config.CORS_ORIGIN ?? false),
  methods: ['GET'],
});

await fastify.register(websocket);

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.get('/capacity', async (req, reply) => {
  const ip = req.ip;
  if (!capacityRateLimiter.isAllowed(ip)) {
    return reply.code(429).send({ error: 'Too Many Requests' });
  }
  const accepting = isAcceptingRooms(config.EVENT_LOOP_LAG_THRESHOLD_MS);
  return { accepting_rooms: accepting, reason: accepting ? null : 'HIGH_LOAD' };
});

fastify.get('/metrics', async () => ({ eventLoopLag: getEventLoopStats() }));

fastify.get('/ready', async (_req, reply) => {
  if (isShuttingDown) {
    return reply.code(503).send({ status: 'shutting_down' });
  }
  return { status: 'ok' };
});

fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
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

// Graceful shutdown
async function shutdown(signal: string) {
  fastify.log.info(`${signal} received, shutting down`);
  isShuttingDown = true;
  stopEventLoopMonitor();
  store.stop();
  for (const [roomCode, room] of store.getAllRooms()) {
    fastify.log.info({ roomCode }, 'room_expired_on_shutdown');
    broadcastToRoom(roomCode, { type: 'room_expired' });
    const sockets = registry.cleanupRoom(roomCode);
    for (const socket of sockets) {
      socket.close();
    }
    for (const participantToken of room.participants.keys()) {
      store.deleteParticipantIndex(participantToken);
    }
  }
  await fastify.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

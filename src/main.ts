import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { loadConfig } from './config/index.js';
import { initWordlist } from './services/wordlist.service.js';
import { InMemoryStore } from './store/memory.js';
import { RateLimitService } from './services/ratelimit.service.js';
import { createHandlers } from './ws/handlers.js';
import { broadcastToRoom } from './ws/broadcast.js';
import { registry } from './ws/registry.js';
import WebSocket from 'ws';

const config = loadConfig();
initWordlist();

const store = new InMemoryStore({
  gcIntervalMs: config.GC_INTERVAL_MS,
  roomTtlMs: config.ROOM_TTL_MS,
  onRoomExpired: (roomCode, room) => {
    // Broadcast room_expired to all connected sockets and close them
    broadcastToRoom(roomCode, { type: 'room_expired' });
    const sockets = registry.cleanupRoom(roomCode);
    for (const socket of sockets) {
      socket.close();
    }
    // Clean up participant indexes
    for (const participantToken of room.participants.keys()) {
      store.deleteParticipantIndex(participantToken);
    }
  },
});

const rateLimiter = new RateLimitService({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  maxAttempts: config.RATE_LIMIT_MAX_ATTEMPTS,
  backoffAfter: config.RATE_LIMIT_BACKOFF_AFTER,
});

const handlers = createHandlers(store, config, rateLimiter);

const fastify = Fastify({
  logger: { level: config.LOG_LEVEL },
  maxParamLength: 100,
});

await fastify.register(websocket);

fastify.get('/health', async () => ({ status: 'ok' }));

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
process.on('SIGTERM', async () => {
  fastify.log.info('SIGTERM received, shutting down');
  store.stop();
  await fastify.close();
  process.exit(0);
});

try {
  await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

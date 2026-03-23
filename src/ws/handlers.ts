import WebSocket from 'ws';
import type { Store } from '../store/types.js';
import type { Config } from '../config/index.js';
import type { Room } from '../models/domain.js';
import { ProtocolError, ErrorCode } from '../errors/index.js';
import { generateToken, generateParticipantToken } from '../utils/crypto.js';
import { generateNickname } from '../services/wordlist.service.js';
import { registry } from './registry.js';
import { broadcastToRoom, sendTo } from './broadcast.js';
import { startHeartbeat, stopHeartbeat, cancelGracePeriod } from '../services/heartbeat.service.js';
import {
  canTransitionToActive,
  canTransitionToWaiting,
  transitionToActive,
  transitionToWaiting,
  checkLockIn,
  lockIn,
} from '../services/room.service.js';
import { parseClientMessage } from '../utils/validation.js';
import { RateLimitService } from '../services/ratelimit.service.js';
import type { RoomSnapshot, ParticipantSnapshot } from '../models/messages.js';
import { PROTOCOL_VERSION } from '../config/constants.js';

// Suppress unused import warning — ProtocolError is available for future use
void ProtocolError;

function buildRoomSnapshot(room: Room): RoomSnapshot {
  const participants: ParticipantSnapshot[] = [...room.participants.values()].map(p => ({
    participantToken: p.participantToken,
    nickname: p.nickname,
    isConnected: p.isConnected,
    proposalEpochMs: p.proposalEpochMs,
  }));
  return {
    code: room.code,
    state: room.state,
    participants,
    lockedInEpochMs: room.lockedInEpochMs,
  };
}

export function createHandlers(store: Store, config: Config, rateLimiter: RateLimitService) {
  const heartbeatOptions = {
    pingMs: config.HEARTBEAT_PING_MS,
    pongTimeoutMs: config.HEARTBEAT_PONG_TIMEOUT_MS,
    gracePeriodMs: config.HEARTBEAT_GRACE_PERIOD_MS,
  };

  function onGraceExpired(participantToken: string, roomCode: string): void {
    const room = store.getRoom(roomCode);
    if (!room) return;
    room.participants.delete(participantToken);
    store.deleteParticipantIndex(participantToken);
    broadcastToRoom(roomCode, { type: 'participant_left', participantToken });
    if (canTransitionToWaiting(room)) {
      transitionToWaiting(room);
      broadcastToRoom(roomCode, { type: 'room_deactivated' });
    }
    room.lastActivityMs = Date.now();
  }

  function handleJoin(socket: WebSocket, roomCode: string, ip: string): void {
    if (rateLimiter.isRateLimited(ip)) {
      sendTo(socket, { type: 'error', code: ErrorCode.RATE_LIMITED, message: 'Too many failed attempts' });
      return;
    }

    let room = store.getRoom(roomCode);
    if (!room) {
      room = {
        code: roomCode,
        state: 'waiting',
        participants: new Map(),
        createdAtMs: Date.now(),
        lastActivityMs: Date.now(),
      };
      store.setRoom(roomCode, room);
    }

    if (room.state === 'locked_in') {
      rateLimiter.recordFailure(ip);
      sendTo(socket, { type: 'error', code: ErrorCode.ROOM_NOT_FOUND, message: 'Room not found' });
      return;
    }

    if (room.participants.size >= config.MAX_PARTICIPANTS_PER_ROOM) {
      rateLimiter.recordFailure(ip);
      sendTo(socket, { type: 'error', code: ErrorCode.ROOM_FULL, message: 'Room is full' });
      return;
    }

    const participantToken = generateParticipantToken();
    const sessionToken = generateToken();
    const nickname = generateNickname();
    const now = Date.now();

    room.participants.set(participantToken, {
      participantToken,
      sessionToken,
      nickname,
      isConnected: true,
      joinedAtMs: now,
      lastHeartbeatMs: now,
    });
    room.lastActivityMs = now;
    store.setParticipantIndex(participantToken, roomCode);

    registry.registerSocket(socket, { participantToken, sessionToken, roomCode });

    if (canTransitionToActive(room)) {
      transitionToActive(room);
      broadcastToRoom(roomCode, {
        type: 'room_activated',
        participants: [...room.participants.values()].map(p => ({
          participantToken: p.participantToken,
          nickname: p.nickname,
        })),
      }, socket);
    } else {
      broadcastToRoom(roomCode, { type: 'participant_joined', participantToken, nickname }, socket);
    }

    sendTo(socket, {
      type: 'joined',
      sessionToken,
      participantToken,
      nickname,
      protocolVersion: PROTOCOL_VERSION,
      room: buildRoomSnapshot(room),
    });

    startHeartbeat(socket, store, heartbeatOptions, onGraceExpired);
  }

  function handleLeave(socket: WebSocket): void {
    const meta = registry.getMeta(socket);
    if (!meta) return;

    stopHeartbeat(socket);
    cancelGracePeriod(meta.sessionToken, store);
    registry.cleanupSocket(socket);

    const room = store.getRoom(meta.roomCode);
    if (!room) return;

    room.participants.delete(meta.participantToken);
    store.deleteParticipantIndex(meta.participantToken);
    broadcastToRoom(meta.roomCode, { type: 'participant_left', participantToken: meta.participantToken });

    if (canTransitionToWaiting(room)) {
      transitionToWaiting(room);
      broadcastToRoom(meta.roomCode, { type: 'room_deactivated' });
    }
    room.lastActivityMs = Date.now();

    socket.close();
  }

  function handleRejoin(socket: WebSocket, roomCode: string, sessionToken: string): void {
    const entry = store.getGracePeriodEntry(sessionToken);
    if (!entry || entry.roomCode !== roomCode) {
      sendTo(socket, { type: 'error', code: ErrorCode.REJOIN_FAILED, message: 'Rejoin failed' });
      return;
    }

    cancelGracePeriod(sessionToken, store);

    const room = store.getRoom(roomCode);
    if (!room) {
      sendTo(socket, { type: 'error', code: ErrorCode.REJOIN_FAILED, message: 'Rejoin failed' });
      return;
    }

    const participant = room.participants.get(entry.participantToken);
    if (!participant) {
      sendTo(socket, { type: 'error', code: ErrorCode.REJOIN_FAILED, message: 'Rejoin failed' });
      return;
    }

    participant.isConnected = true;
    participant.sessionToken = sessionToken;
    participant.lastHeartbeatMs = Date.now();
    room.lastActivityMs = Date.now();

    registry.registerSocket(socket, {
      participantToken: entry.participantToken,
      sessionToken,
      roomCode,
    });

    broadcastToRoom(roomCode, {
      type: 'participant_reconnected',
      participantToken: entry.participantToken,
    }, socket);

    if (canTransitionToActive(room)) {
      transitionToActive(room);
      broadcastToRoom(roomCode, {
        type: 'room_activated',
        participants: [...room.participants.values()].map(p => ({
          participantToken: p.participantToken,
          nickname: p.nickname,
        })),
      }, socket);
    }

    sendTo(socket, {
      type: 'joined',
      sessionToken,
      participantToken: entry.participantToken,
      nickname: participant.nickname,
      protocolVersion: PROTOCOL_VERSION,
      room: buildRoomSnapshot(room),
    });

    startHeartbeat(socket, store, heartbeatOptions, onGraceExpired);
  }

  function handlePropose(socket: WebSocket, epochMs: number): void {
    const meta = registry.getMeta(socket);
    if (!meta) return;

    const room = store.getRoom(meta.roomCode);
    if (!room) {
      sendTo(socket, { type: 'error', code: ErrorCode.ROOM_NOT_FOUND, message: 'Room not found' });
      return;
    }

    if (room.state === 'locked_in') {
      sendTo(socket, { type: 'error', code: ErrorCode.ROOM_NOT_FOUND, message: 'Room not found' });
      return;
    }

    if (room.state !== 'active') {
      sendTo(socket, { type: 'error', code: ErrorCode.ROOM_NOT_ACTIVE, message: 'Room is not active' });
      return;
    }

    const participant = room.participants.get(meta.participantToken);
    if (!participant) return;

    participant.proposalEpochMs = epochMs;
    room.lastActivityMs = Date.now();

    broadcastToRoom(meta.roomCode, {
      type: 'proposal_updated',
      participantToken: meta.participantToken,
      epochMs,
    });

    const lockedEpoch = checkLockIn(room);
    if (lockedEpoch !== null) {
      lockIn(room, lockedEpoch);
      broadcastToRoom(meta.roomCode, { type: 'locked_in', epochMs: lockedEpoch });
    }
  }

  function handleDisconnect(socket: WebSocket): void {
    // Called when socket closes without explicit leave
    const meta = registry.getMeta(socket);
    if (!meta) return;
    stopHeartbeat(socket);
    registry.cleanupSocket(socket);
  }

  function handleMessage(socket: WebSocket, raw: string, ip: string): void {
    let msg;
    try {
      msg = parseClientMessage(raw);
    } catch {
      sendTo(socket, { type: 'error', code: ErrorCode.INVALID_TOKEN, message: 'Invalid message format' });
      return;
    }

    switch (msg.type) {
      case 'join':
        handleJoin(socket, msg.roomCode, ip);
        break;
      case 'rejoin':
        handleRejoin(socket, msg.roomCode, msg.sessionToken);
        break;
      case 'propose':
        handlePropose(socket, msg.epochMs);
        break;
      case 'leave':
        handleLeave(socket);
        break;
    }
  }

  return { handleMessage, handleLeave, handleDisconnect };
}

import WebSocket from 'ws';
import type { Store } from '../store/types.js';
import { registry } from '../ws/registry.js';
import { broadcastToRoom } from '../ws/broadcast.js';

interface HeartbeatOptions {
  pingMs: number;
  pongTimeoutMs: number;
  gracePeriodMs: number;
}

interface HeartbeatState {
  pingTimer: NodeJS.Timeout | null;
  pongTimer: NodeJS.Timeout | null;
  pongHandler: (() => void) | null;
}

const heartbeatStates = new Map<WebSocket, HeartbeatState>();

export function startHeartbeat(
  socket: WebSocket,
  store: Store,
  options: HeartbeatOptions,
  onGraceExpired: (participantToken: string, roomCode: string) => void,
): void {
  stopHeartbeat(socket);

  const state: HeartbeatState = { pingTimer: null, pongTimer: null, pongHandler: null };
  heartbeatStates.set(socket, state);

  state.pingTimer = setTimeout(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.ping();

    state.pongTimer = setTimeout(() => {
      const meta = registry.getMeta(socket);
      if (!meta) return;

      const room = store.getRoom(meta.roomCode);
      if (!room) return;

      const participant = room.participants.get(meta.participantToken);
      if (!participant) return;

      participant.isConnected = false;
      broadcastToRoom(meta.roomCode, {
        type: 'participant_disconnected',
        participantToken: meta.participantToken,
      });

      // Start grace period
      const graceTimer = setTimeout(() => {
        onGraceExpired(meta.participantToken, meta.roomCode);
        store.deleteGracePeriodEntry(meta.sessionToken);
      }, options.gracePeriodMs);

      store.setGracePeriodEntry(meta.sessionToken, {
        roomCode: meta.roomCode,
        participantToken: meta.participantToken,
        expiresAtMs: Date.now() + options.gracePeriodMs,
        timer: graceTimer,
      });

      registry.cleanupSocket(socket);
    }, options.pongTimeoutMs);
  }, options.pingMs);

  const pongHandler = () => {
    const s = heartbeatStates.get(socket);
    if (s?.pongTimer) {
      clearTimeout(s.pongTimer);
      s.pongTimer = null;
    }
    const meta = registry.getMeta(socket);
    if (meta) {
      const room = store.getRoom(meta.roomCode);
      const participant = room?.participants.get(meta.participantToken);
      if (participant) participant.lastHeartbeatMs = Date.now();
    }
    // Restart heartbeat cycle
    startHeartbeat(socket, store, options, onGraceExpired);
  };
  state.pongHandler = pongHandler;
  socket.on('pong', pongHandler);
}

export function stopHeartbeat(socket: WebSocket): void {
  const state = heartbeatStates.get(socket);
  if (!state) return;
  if (state.pingTimer) clearTimeout(state.pingTimer);
  if (state.pongTimer) clearTimeout(state.pongTimer);
  if (state.pongHandler) socket.removeListener('pong', state.pongHandler);
  heartbeatStates.delete(socket);
}

export function cancelGracePeriod(sessionToken: string, store: Store): void {
  const entry = store.getGracePeriodEntry(sessionToken);
  if (!entry) return;
  clearTimeout(entry.timer);
  store.deleteGracePeriodEntry(sessionToken);
}

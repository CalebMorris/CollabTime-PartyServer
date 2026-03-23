import WebSocket from 'ws';
import { registry } from './registry.js';
import type { ServerMessage } from '../models/messages.js';

export function broadcastToRoom(roomCode: string, message: ServerMessage, exclude?: WebSocket): void {
  const sockets = registry.getSocketsForRoom(roomCode);
  const payload = JSON.stringify(message);

  for (const socket of sockets) {
    if (socket === exclude) continue;
    if (socket.readyState !== WebSocket.OPEN) {
      registry.cleanupSocket(socket);
      continue;
    }
    try {
      socket.send(payload);
    } catch {
      registry.cleanupSocket(socket);
    }
  }
}

export function sendTo(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    registry.cleanupSocket(socket);
  }
}

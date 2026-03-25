import type WebSocket from 'ws';

export interface ParticipantMeta {
  participantToken: string;
  sessionToken: string;
  roomCode: string;
}

class Registry {
  private socketToMeta = new Map<WebSocket, ParticipantMeta>();
  private roomToSockets = new Map<string, Set<WebSocket>>();

  registerSocket(socket: WebSocket, meta: ParticipantMeta): void {
    this.socketToMeta.set(socket, meta);
    if (!this.roomToSockets.has(meta.roomCode)) {
      this.roomToSockets.set(meta.roomCode, new Set());
    }
    this.roomToSockets.get(meta.roomCode)!.add(socket);
  }

  getMeta(socket: WebSocket): ParticipantMeta | undefined {
    return this.socketToMeta.get(socket);
  }

  getSocketsForRoom(roomCode: string): Set<WebSocket> {
    return this.roomToSockets.get(roomCode) ?? new Set();
  }

  cleanupSocket(socket: WebSocket): void {
    const meta = this.socketToMeta.get(socket);
    if (!meta) return;
    this.socketToMeta.delete(socket);
    const sockets = this.roomToSockets.get(meta.roomCode);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.roomToSockets.delete(meta.roomCode);
      }
    }
  }

  cleanupRoom(roomCode: string): Set<WebSocket> {
    const sockets = this.roomToSockets.get(roomCode) ?? new Set();
    for (const socket of sockets) {
      this.socketToMeta.delete(socket);
    }
    this.roomToSockets.delete(roomCode);
    return sockets;
  }
}

export const registry = new Registry();

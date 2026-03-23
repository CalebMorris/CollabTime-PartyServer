import type { Room } from '../models/domain.js';

export interface GracePeriodEntry {
  roomCode: string;
  participantToken: string;
  expiresAtMs: number;
  timer: NodeJS.Timeout;
}

export interface Store {
  getRoom(code: string): Room | undefined;
  setRoom(code: string, room: Room): void;
  deleteRoom(code: string): void;
  getRoomCodeByParticipantToken(participantToken: string): string | undefined;
  setParticipantIndex(participantToken: string, roomCode: string): void;
  deleteParticipantIndex(participantToken: string): void;
  getGracePeriodEntry(sessionToken: string): GracePeriodEntry | undefined;
  setGracePeriodEntry(sessionToken: string, entry: GracePeriodEntry): void;
  deleteGracePeriodEntry(sessionToken: string): void;
  stop(): void;
}

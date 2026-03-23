import type { Room } from '../../src/models/domain.js';
import type { GracePeriodEntry, Store } from '../../src/store/types.js';

export class MockStore implements Store {
  private rooms = new Map<string, Room>();
  private participantIndex = new Map<string, string>();
  private gracePeriodCache = new Map<string, GracePeriodEntry>();

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  setRoom(code: string, room: Room): void {
    this.rooms.set(code, room);
  }

  deleteRoom(code: string): void {
    this.rooms.delete(code);
  }

  getRoomCodeByParticipantToken(participantToken: string): string | undefined {
    return this.participantIndex.get(participantToken);
  }

  setParticipantIndex(participantToken: string, roomCode: string): void {
    this.participantIndex.set(participantToken, roomCode);
  }

  deleteParticipantIndex(participantToken: string): void {
    this.participantIndex.delete(participantToken);
  }

  getGracePeriodEntry(sessionToken: string): GracePeriodEntry | undefined {
    return this.gracePeriodCache.get(sessionToken);
  }

  setGracePeriodEntry(sessionToken: string, entry: GracePeriodEntry): void {
    this.gracePeriodCache.set(sessionToken, entry);
  }

  deleteGracePeriodEntry(sessionToken: string): void {
    this.gracePeriodCache.delete(sessionToken);
  }

  stop(): void {
    // No-op for mock
  }
}

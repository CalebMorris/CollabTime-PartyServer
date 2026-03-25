import type { Room } from '../models/domain.js';
import type { GracePeriodEntry, Store } from './types.js';

interface InMemoryStoreOptions {
  gcIntervalMs?: number;
  roomTtlMs?: number;
  onRoomExpired?: (roomCode: string, room: Room) => void;
  setIntervalFn?: typeof setInterval;
}

export class InMemoryStore implements Store {
  private rooms = new Map<string, Room>();
  private participantIndex = new Map<string, string>();
  private gracePeriodCache = new Map<string, GracePeriodEntry>();
  private gcTimer: NodeJS.Timeout;
  private roomTtlMs: number;

  constructor(options: InMemoryStoreOptions = {}) {
    this.roomTtlMs = options.roomTtlMs ?? 7_200_000;
    const gcIntervalMs = options.gcIntervalMs ?? 10_000;
    const setIntervalFn = options.setIntervalFn ?? setInterval;
    this.gcTimer = setIntervalFn(() => this.gc(options.onRoomExpired), gcIntervalMs);
    this.gcTimer.unref?.();
  }

  private gc(onExpired?: (roomCode: string, room: Room) => void): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivityMs > this.roomTtlMs) {
        onExpired?.(code, room);
        // Clean up participant index entries
        for (const participantToken of room.participants.keys()) {
          this.participantIndex.delete(participantToken);
        }
        // Clean up grace period entries for this room
        for (const [sessionToken, entry] of this.gracePeriodCache) {
          if (entry.roomCode === code) {
            clearTimeout(entry.timer);
            this.gracePeriodCache.delete(sessionToken);
          }
        }
        this.rooms.delete(code);
      }
    }
  }

  getRoom(code: string): Room | undefined { return this.rooms.get(code); }
  setRoom(code: string, room: Room): void { this.rooms.set(code, room); }
  deleteRoom(code: string): void { this.rooms.delete(code); }
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
  getAllRooms(): Map<string, Room> { return this.rooms; }
  stop(): void { clearInterval(this.gcTimer); }
}

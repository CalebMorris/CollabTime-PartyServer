export type RoomState = 'waiting' | 'active' | 'locked_in';

export interface Participant {
  participantToken: string;
  sessionToken: string;
  nickname: string;
  proposalEpochMs?: number;
  isConnected: boolean;
  joinedAtMs: number;
  lastHeartbeatMs: number;
}

export interface Room {
  code: string;
  state: RoomState;
  participants: Map<string, Participant>;  // key = participantToken
  createdAtMs: number;
  lastActivityMs: number;
  lockedInEpochMs?: number;
}

import type { RoomState } from './domain.js';
import type { ErrorCode } from '../errors/index.js';

// Snapshots
export interface ParticipantSnapshot {
  participantToken: string;
  nickname: string;
  isConnected: boolean;
  proposalEpochMs?: number;
}

export interface RoomSnapshot {
  code: string;
  state: RoomState;
  participants: ParticipantSnapshot[];
  lockedInEpochMs?: number;
}

// Client → Server messages
export interface JoinMessage {
  type: 'join';
  roomCode: string;
}

export interface RejoinMessage {
  type: 'rejoin';
  roomCode: string;
  sessionToken: string;
}

export interface ProposeMessage {
  type: 'propose';
  epochMs: number;
}

export interface LeaveMessage {
  type: 'leave';
}

export type ClientMessage =
  | JoinMessage
  | RejoinMessage
  | ProposeMessage
  | LeaveMessage;

// Server → Client messages
export interface JoinedMessage {
  type: 'joined';
  sessionToken: string;
  participantToken: string;
  nickname: string;
  protocolVersion: string;
  room: RoomSnapshot;
}

export interface ParticipantJoinedMessage {
  type: 'participant_joined';
  participantToken: string;
  nickname: string;
}

export interface ParticipantLeftMessage {
  type: 'participant_left';
  participantToken: string;
}

export interface ParticipantDisconnectedMessage {
  type: 'participant_disconnected';
  participantToken: string;
}

export interface ParticipantReconnectedMessage {
  type: 'participant_reconnected';
  participantToken: string;
}

export interface RoomActivatedMessage {
  type: 'room_activated';
  participants: Array<{ participantToken: string; nickname: string }>;
}

export interface RoomDeactivatedMessage {
  type: 'room_deactivated';
}

export interface ProposalUpdatedMessage {
  type: 'proposal_updated';
  participantToken: string;
  epochMs: number;
}

export interface LockedInMessage {
  type: 'locked_in';
  epochMs: number;
}

export interface RoomExpiredMessage {
  type: 'room_expired';
}

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | JoinedMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | ParticipantDisconnectedMessage
  | ParticipantReconnectedMessage
  | RoomActivatedMessage
  | RoomDeactivatedMessage
  | ProposalUpdatedMessage
  | LockedInMessage
  | RoomExpiredMessage
  | ErrorMessage;

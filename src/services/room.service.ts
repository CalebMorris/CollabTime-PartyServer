import type { Room } from '../models/domain.js';

export function canTransitionToActive(room: Room): boolean {
  if (room.state !== 'waiting') return false;
  const connectedCount = countConnected(room);
  return connectedCount >= 2;
}

export function canTransitionToWaiting(room: Room): boolean {
  if (room.state !== 'active') return false;
  const connectedCount = countConnected(room);
  return connectedCount < 2;
}

export function transitionToActive(room: Room): void {
  if (room.state === 'locked_in') return; // terminal
  room.state = 'active';
}

export function transitionToWaiting(room: Room): void {
  if (room.state === 'locked_in') return; // terminal
  room.state = 'waiting';
}

function countConnected(room: Room): number {
  let count = 0;
  for (const p of room.participants.values()) {
    if (p.isConnected) count++;
  }
  return count;
}

export function truncateToMinute(epochMs: number): number {
  return Math.floor(epochMs / 60_000) * 60_000;
}

export function checkLockIn(room: Room): number | null {
  if (room.state !== 'active') return null;

  // Only connected participants WITH a proposal participate in quorum
  const quorumParticipants = [...room.participants.values()].filter(
    p => p.isConnected && p.proposalEpochMs !== undefined,
  );

  if (quorumParticipants.length < 2) return null;

  const firstTruncated = truncateToMinute(quorumParticipants[0].proposalEpochMs!);
  const allAgree = quorumParticipants.every(
    p => truncateToMinute(p.proposalEpochMs!) === firstTruncated,
  );

  return allAgree ? firstTruncated : null;
}

export function lockIn(room: Room, epochMs: number): void {
  room.state = 'locked_in';
  room.lockedInEpochMs = epochMs;
}

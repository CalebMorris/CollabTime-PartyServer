import { describe, it, expect } from 'vitest';
import type { Room, Participant } from '../../src/models/domain.js';
import {
  canTransitionToActive,
  canTransitionToWaiting,
  transitionToActive,
  transitionToWaiting,
  truncateToMinute,
  checkLockIn,
  lockIn,
} from '../../src/services/room.service.js';

function makeParticipant(overrides: Partial<Participant> = {}): Participant {
  return {
    participantToken: 'abc123',
    sessionToken: 'sess123',
    nickname: 'Test User',
    isConnected: true,
    joinedAtMs: Date.now(),
    lastHeartbeatMs: Date.now(),
    ...overrides,
  };
}

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    code: 'foo-bar-baz',
    state: 'waiting',
    participants: new Map(),
    createdAtMs: Date.now(),
    lastActivityMs: Date.now(),
    ...overrides,
  };
}

describe('room state transitions', () => {
  it('transitions waiting → active when 2+ connected participants', () => {
    const room = makeRoom({ state: 'waiting' });
    room.participants.set('p1', makeParticipant({ participantToken: 'p1', isConnected: true }));
    room.participants.set('p2', makeParticipant({ participantToken: 'p2', isConnected: true }));

    expect(canTransitionToActive(room)).toBe(true);
    transitionToActive(room);
    expect(room.state).toBe('active');
  });

  it('does not transition to active with only 1 connected participant', () => {
    const room = makeRoom({ state: 'waiting' });
    room.participants.set('p1', makeParticipant({ participantToken: 'p1', isConnected: true }));
    room.participants.set('p2', makeParticipant({ participantToken: 'p2', isConnected: false }));

    expect(canTransitionToActive(room)).toBe(false);
  });

  it('transitions active → waiting when connected drops below 2', () => {
    const room = makeRoom({ state: 'active' });
    room.participants.set('p1', makeParticipant({ participantToken: 'p1', isConnected: true }));
    room.participants.set('p2', makeParticipant({ participantToken: 'p2', isConnected: false }));

    expect(canTransitionToWaiting(room)).toBe(true);
    transitionToWaiting(room);
    expect(room.state).toBe('waiting');
  });

  it('does not transition active → waiting if 2+ connected', () => {
    const room = makeRoom({ state: 'active' });
    room.participants.set('p1', makeParticipant({ participantToken: 'p1', isConnected: true }));
    room.participants.set('p2', makeParticipant({ participantToken: 'p2', isConnected: true }));

    expect(canTransitionToWaiting(room)).toBe(false);
  });

  it('locked_in is terminal — transitionToActive does not change state', () => {
    const room = makeRoom({ state: 'locked_in' });
    transitionToActive(room);
    expect(room.state).toBe('locked_in');
  });

  it('locked_in is terminal — transitionToWaiting does not change state', () => {
    const room = makeRoom({ state: 'locked_in' });
    transitionToWaiting(room);
    expect(room.state).toBe('locked_in');
  });
});

describe('truncateToMinute', () => {
  it('T+0 and T+59s are in the same minute', () => {
    const base = 1_700_000_000_000; // some epoch
    const t0 = Math.floor(base / 60_000) * 60_000;
    const t59 = t0 + 59_999;
    expect(truncateToMinute(t0)).toBe(truncateToMinute(t59));
  });

  it('T+60s is in a different minute from T+0', () => {
    const base = 1_700_000_000_000;
    const t0 = Math.floor(base / 60_000) * 60_000;
    const t60 = t0 + 60_000;
    expect(truncateToMinute(t0)).not.toBe(truncateToMinute(t60));
  });
});

describe('checkLockIn', () => {
  const MINUTE = 60_000;
  const baseEpoch = Math.floor(1_700_000_000_000 / MINUTE) * MINUTE + 30_000; // 30s into a minute

  it('returns locked epoch when 2 participants agree', () => {
    const room = makeRoom({ state: 'active' });
    room.participants.set('p1', makeParticipant({
      participantToken: 'p1',
      isConnected: true,
      proposalEpochMs: baseEpoch,
    }));
    room.participants.set('p2', makeParticipant({
      participantToken: 'p2',
      isConnected: true,
      proposalEpochMs: baseEpoch + 15_000, // same minute
    }));

    const result = checkLockIn(room);
    expect(result).not.toBeNull();
    expect(result).toBe(truncateToMinute(baseEpoch));
  });

  it('returns null when proposals are in different minutes', () => {
    const room = makeRoom({ state: 'active' });
    room.participants.set('p1', makeParticipant({
      participantToken: 'p1',
      isConnected: true,
      proposalEpochMs: baseEpoch,
    }));
    room.participants.set('p2', makeParticipant({
      participantToken: 'p2',
      isConnected: true,
      proposalEpochMs: baseEpoch + 60_000, // different minute
    }));

    expect(checkLockIn(room)).toBeNull();
  });

  it('excludes disconnected participants (ghost) from quorum', () => {
    const room = makeRoom({ state: 'active' });
    room.participants.set('p1', makeParticipant({
      participantToken: 'p1',
      isConnected: true,
      proposalEpochMs: baseEpoch,
    }));
    // Disconnected participant with a different epoch — should be ignored
    room.participants.set('ghost', makeParticipant({
      participantToken: 'ghost',
      isConnected: false,
      proposalEpochMs: baseEpoch + 60_000,
    }));
    room.participants.set('p2', makeParticipant({
      participantToken: 'p2',
      isConnected: true,
      proposalEpochMs: baseEpoch + 15_000,
    }));

    const result = checkLockIn(room);
    expect(result).not.toBeNull();
  });

  it('excludes participants with no proposal from quorum', () => {
    const room = makeRoom({ state: 'active' });
    room.participants.set('p1', makeParticipant({
      participantToken: 'p1',
      isConnected: true,
      proposalEpochMs: baseEpoch,
    }));
    // No proposal — excluded from quorum
    room.participants.set('noprop', makeParticipant({
      participantToken: 'noprop',
      isConnected: true,
      proposalEpochMs: undefined,
    }));
    room.participants.set('p2', makeParticipant({
      participantToken: 'p2',
      isConnected: true,
      proposalEpochMs: baseEpoch + 15_000,
    }));

    const result = checkLockIn(room);
    expect(result).not.toBeNull();
  });

  it('returns null with only 1 participant in quorum', () => {
    const room = makeRoom({ state: 'active' });
    room.participants.set('p1', makeParticipant({
      participantToken: 'p1',
      isConnected: true,
      proposalEpochMs: baseEpoch,
    }));

    expect(checkLockIn(room)).toBeNull();
  });

  it('returns null when room is not active', () => {
    const room = makeRoom({ state: 'waiting' });
    room.participants.set('p1', makeParticipant({
      participantToken: 'p1',
      isConnected: true,
      proposalEpochMs: baseEpoch,
    }));
    room.participants.set('p2', makeParticipant({
      participantToken: 'p2',
      isConnected: true,
      proposalEpochMs: baseEpoch,
    }));

    expect(checkLockIn(room)).toBeNull();
  });

  it('lockIn sets state to locked_in and stores epoch', () => {
    const room = makeRoom({ state: 'active' });
    lockIn(room, baseEpoch);
    expect(room.state).toBe('locked_in');
    expect(room.lockedInEpochMs).toBe(baseEpoch);
  });
});

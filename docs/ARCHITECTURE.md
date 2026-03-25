# CollabTime Party Server — Architecture

## Overview

A stateless-from-the-client's-perspective WebSocket relay. Clients exchange epoch
timestamps; the server is completely timezone-blind. No database, no accounts,
no persistent storage — all state is ephemeral in-memory and expires after 2 hours
of inactivity.

---

## Room State Machine

```
           join (2nd connected)
waiting ──────────────────────────► active
  ▲                                    │
  │    drops below 2 connected         │    checkLockIn() returns epoch
  └────────────────────────────────────┘ ──────────────────────────────► locked_in
                                                                           (terminal)
```

**States:**

| State | Connected participants | Proposals accepted | Notes |
|-------|----------------------|--------------------|-------|
| `waiting` | 1 | No | Created when first participant joins |
| `active` | 2+ | Yes | Transitions back to `waiting` if count drops |
| `locked_in` | any | No | Terminal — no transitions out, ever |

**Invariants:**
- `locked_in` is permanent. No code path may exit this state.
- A room in `waiting` rejects `propose` with `ROOM_NOT_ACTIVE`.
- A room in `locked_in` rejects `join` and `propose` with `ROOM_NOT_FOUND`.

---

## Quorum and Lock-In

Lock-in is evaluated after every `propose`. The rule:

> Lock-in fires when the set of **connected participants who have submitted a proposal**
> has size ≥ 2, and all their `proposalEpochMs` values truncate to the same minute.

```typescript
truncateToMinute(epochMs) = Math.floor(epochMs / 60_000) * 60_000
```

**Who is excluded from quorum:**
- Participants where `isConnected === false` (heartbeat timed out)
- Participants where `proposalEpochMs === undefined` (have not yet proposed)

This means a late joiner who hasn't proposed yet will not block two others from
locking in. It also means a disconnected participant's stale proposal doesn't count.

The `locked_in` broadcast sends the truncated epoch (not either participant's raw
proposal). Clients should display the full minute this represents.

---

## Participant Identity

Each participant has two tokens:

| Token | Stability | Purpose |
|-------|-----------|---------|
| `participantToken` | Stable across reconnects | Public identity; shared with other participants |
| `sessionToken` | Per-connection | Used only for `rejoin`; kept private |

On `rejoin`, the server looks up `sessionToken` in the grace period cache, restores
`isConnected = true`, and issues a new heartbeat cycle. The `participantToken` and
all state (nickname, proposal) are preserved.

---

## Heartbeat and Grace Period

```
T+0s    connect → heartbeat starts
T+20s   server sends socket.ping()
T+30s   no pong → isConnected=false; broadcast participant_disconnected; grace starts
T+60s   grace expires → participant removed; broadcast participant_left
```

Implementation: `src/services/heartbeat.service.ts`

- Each connected socket gets its own ping/pong timers.
- `stopHeartbeat()` clears all timers for a socket — no zombie timers.
- `cancelGracePeriod()` clears the grace timer on successful rejoin.
- The grace period cache (`gracePeriodCache: Map<sessionToken, GracePeriodEntry>`) lives
  on `InMemoryStore` so it survives socket lifecycle changes.

---

## Broadcast Failure Policy

`broadcastToRoom()` is best-effort. If `socket.send()` throws:

1. Call `registry.cleanupSocket(socket)` — removes from registry maps.
2. Continue to remaining sockets.

No retry. No rollback. Partial delivery is acceptable — participants converge via
their own heartbeats and subsequent state updates.

---

## In-Memory Store

`src/store/memory.ts` — `InMemoryStore` holds:

- `rooms: Map<roomCode, Room>` — primary room state
- `participantIndex: Map<participantToken, roomCode>` — O(1) reverse lookup
- `gracePeriodCache: Map<sessionToken, GracePeriodEntry>` — active grace periods
- GC timer (default every 10s) — expires rooms idle for 2h; fires `onRoomExpired`
  callback; cleans up participant index and grace entries for the expired room

The store is injected into handlers and the heartbeat service via the `Store` interface
(`src/store/types.ts`), enabling mock-based unit testing without real I/O.

---

## WebSocket Registry

`src/ws/registry.ts` — two maps maintained in a singleton:

- `socketToMeta: Map<WebSocket, ParticipantMeta>` — look up identity from socket
- `roomToSockets: Map<roomCode, Set<WebSocket>>` — fan-out for broadcasts

`cleanupSocket()` removes a socket from both maps.
`cleanupRoom()` removes all sockets for a room and returns them (for close-and-cleanup).

---

## Rate Limiter

`src/services/ratelimit.service.ts` — per-IP sliding window.

**Only `ROOM_NOT_FOUND` and `ROOM_FULL` increment the failure counter.**
`REJOIN_FAILED` and `INVALID_TOKEN` do not — they are reconnection/protocol errors
and penalizing them would block legitimate recovery.

After `RATE_LIMIT_BACKOFF_AFTER` failures (default 3), exponential backoff kicks in:
`2^(attempts - backoffAfter) * 1000ms`, capped at 5 minutes.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| No database | Ephemeral scheduling; no value in persistence. Restart loses all rooms (acceptable). |
| No Socket.IO | Native WebSocket ping/pong is sufficient; no polling overhead. |
| Server never generates room codes | Clients share codes out-of-band (text, link). Two parties entering the same code share a room — intentional. |
| 50 participant cap | Prevents broadcast storms. More than sufficient for scheduling. |
| Wordlist as flat files | Simple, no hot-reload (race condition risk). Changes require redeploy. |
| `moduleResolution: node16` | Required for correct ESM/CJS interop with Fastify and `ws` on Node 20. The default `"node"` breaks import resolution. |
| Epoch timestamps only | Server is timezone-blind. No offsets, no locale data, no nicknames in `locked_in` broadcast. Privacy by design. |

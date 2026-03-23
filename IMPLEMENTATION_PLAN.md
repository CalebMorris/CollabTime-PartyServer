# CollabTime Party Server — Implementation Plan

> Synthesized from: PM, Senior Architect, WebSocket Expert, Test Designer, Documentation Specialist
> Adversarially reviewed and updated with all Critical/High findings addressed.

---

## Context

CollabTime Party Server is a greenfield Node.js/TypeScript WebSocket relay that enables groups of people in different timezones to reach a meeting-time consensus without accounts or friction. The server is timezone-blind (only exchanges epoch timestamps), uses ephemeral in-memory state, and auto-expires sessions after 2 hours of inactivity.

**Current state:** Spec-only. No code, no package.json. Two files exist:
- `README.md` — complete product specification
- `CLAUDE.md` — working preferences (staged, not yet committed)

**Goal:** Produce a shippable MVP server, Phase 1 first, through Phase 4.

---

## Open Questions — Resolved Defaults

These unblock implementation. Adjust before shipping if the product owner overrides.

| # | Question | Default Decision |
|---|----------|-----------------|
| 1 | CORS policy | Locked to frontend domain; configured via `CORS_ORIGIN` env var |
| 2 | Max participants per room | **50** (prevents broadcast storm; more than enough for scheduling) |
| 3 | Multi-tab behavior | Separate session token per tab — **intentional, correct by design** |
| 4 | Log retention | **7 days**, structured JSON logs to stdout; ops-only access |
| 5 | Wordlist updates | **Redeploy only** — no hot-reload (race condition risk, rare need) |
| 6 | Export screen privacy | Epoch timestamp only in `locked_in` broadcast — no offsets, no nicknames |

---

## Resolved Spec Ambiguities

These clarifications must be reflected in `docs/PROTOCOL.md` before the frontend team codes against it.

| Ambiguity | Resolution |
|-----------|------------|
| **Room code ownership** | Clients supply room codes; server validates format only. Server never generates codes. Two parties with the same code share a room — this is the intended discovery mechanism. |
| **New join to locked-in room** | Reject with `ROOM_LOCKED` ⚠️ (plan addition; not in spec's 7-code enum — needs product owner confirmation before shipping) |
| **New proposal in locked-in room** | Reject with `ROOM_LOCKED` (same caveat) |
| **Rejoin to locked-in room** | Allow rejoin; send snapshot with `lockedInEpochMs`; reject any new proposals |
| **Late joiner quorum** | A connected participant with NO proposal is excluded from quorum. Lock-in requires all connected participants who HAVE a proposal to agree, AND at least 2 such participants. A late joiner without a proposal does not block lock-in. |
| **`participant_disconnected` vs `participant_left`** | `participant_disconnected` fires immediately when heartbeat times out (grace period starts). `participant_left` fires when grace period expires and participant is removed. These are two distinct broadcast events. |
| **Protocol versioning direction** | Server-to-client only. `joined` response includes `protocolVersion: "1.0"`. Server validates client version only if client sends one; no breaking behavior for clients that omit it (assume compatible). |
| **`room_activated` payload** | `{ participants: Array<{ participantToken, nickname }> }` — tokens and nicknames only; no proposals (snapshot already delivered via `joined`) |

### ⚠️ Pre-Implementation Sign-Off Required

Before writing any code, confirm with the product owner:
1. Is `ROOM_LOCKED` added to the error code enum, or does a locked-in room use `ROOM_NOT_FOUND`?
2. Is the heartbeat timeline correct: **ping at T+20s, pong deadline T+30s, `participant_disconnected` at T+30s, `participant_left` at T+60s**?

---

## Technology Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| HTTP/WS framework | **Fastify** | TypeScript-first, fast, Pino built-in, cleaner than Express |
| WebSocket library | **`ws` + `@fastify/websocket`** | Lightweight, spec-compliant, no polling overhead (no Socket.IO) |
| Schema validation | **Zod** | Type-safe env config + runtime message validation |
| Test runner | **Vitest** | Fast startup, native TypeScript, excellent fake-timer support |
| Package manager | **npm** | Standard tooling; no additional setup required |
| Dev server | **tsx watch** | JIT TypeScript execution; no build step in development |
| Production build | **tsc → esbuild** | Small bundle, tree-shaken, ~5MB output |
| Node version | **Node 20 LTS** | Built-in crypto, stable async ergonomics |

**Dependencies:**
```
npm install fastify @fastify/websocket ws zod
```
**Dev dependencies:**
```
npm install -D typescript tsx esbuild vitest @types/node @types/ws eslint @typescript-eslint/eslint-plugin prettier
```

**`tsconfig.json` — critical settings:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node16",
    "strict": true,
    "outDir": "./dist"
  }
}
```
> `"moduleResolution": "node16"` is required for correct ESM/CJS interop with Fastify and ws on Node 20. The default `"node"` will cause import failures.

---

## Project Layout

```
src/
├── main.ts                          Entry point; wires everything together
├── config/
│   ├── index.ts                     Zod env schema; loadConfig(); fail-fast on startup
│   └── constants.ts                 ROOM_CODE_PATTERN /^[a-z]+-[a-z]+-[a-z]+$/,
│                                    MAX_PARTICIPANTS=50, SESSION_TOKEN_HEX_PATTERN, etc.
├── models/
│   ├── domain.ts                    Room, Participant, RoomState types (exported to frontend)
│   └── messages.ts                  ClientMessage / ServerMessage discriminated unions (exported)
├── store/
│   ├── types.ts                     Store interface (enables DI + mocking in tests)
│   └── memory.ts                    InMemoryStore + TTL GC + grace period cache
├── services/
│   ├── room.service.ts              State machine transitions (no I/O; pure functions)
│   ├── heartbeat.service.ts         Native WS ping, pong timeout, grace period timers
│   ├── ratelimit.service.ts         Per-IP sliding window, exponential backoff
│   └── wordlist.service.ts          Nickname generation from adjective/noun files
├── ws/
│   ├── registry.ts                  socketToMeta: Map<WS, ParticipantMeta>
│   │                                roomToSockets: Map<roomCode, Set<WS>>
│   │                                (stateful; shared by handlers, broadcast, heartbeat)
│   ├── handlers.ts                  Message dispatch (join/rejoin/propose/leave);
│   │                                delegates business logic to services
│   └── broadcast.ts                 broadcastToRoom(): check OPEN, send, cleanup on error
├── errors/
│   └── index.ts                     ProtocolError class + ErrorCode enum (all 7 spec codes
│                                    + optional ROOM_LOCKED pending owner sign-off)
├── utils/
│   ├── crypto.ts                    generateToken(): crypto.randomBytes(16).toString('hex')
│   └── validation.ts                parseClientMessage(); regex + bounds checks
└── wordlists/
    ├── adjectives.txt               One word per line, lowercase. Target: 300+ words.
    └── nouns.txt                    One word per line, lowercase. Target: 300+ words.
                                     (300×300 = 90,000 nickname combos; sufficient for MVP)

tests/
├── unit/
│   ├── room.service.test.ts
│   ├── heartbeat.service.test.ts
│   ├── ratelimit.service.test.ts
│   ├── wordlist.service.test.ts
│   └── validation.test.ts
├── integration/
│   └── ws.integration.test.ts      Real WebSocket connections to test server on random port
└── fixtures/
    ├── mock-store.ts                MockStore implements Store interface
    └── factories.ts                 createMockRoom(), createMockParticipant()

docs/
├── PROTOCOL.md                      WebSocket message reference (frontend's API contract)
├── ARCHITECTURE.md                  Room state machine, lifecycle, design decisions
├── DEVELOPMENT.md                   5-min local setup, project structure, debugging
└── DEPLOYMENT.md                    Env vars, health checks, runbook, incident response
```

> **`participant.service.ts` removed** from the layout. Join/leave/proposal logic lives in `ws/handlers.ts` (orchestration) + `services/room.service.ts` (business logic). A thin `participant.service.ts` with unclear boundaries adds abstraction without benefit.

---

## Core Data Models

```typescript
// src/models/domain.ts
export type RoomState = 'waiting' | 'active' | 'locked_in';

export interface Participant {
  participantToken: string;   // stable identity across reconnects (never changes)
  sessionToken: string;       // per-connection recovery key; moved to grace cache on disconnect
  nickname: string;           // assigned at join; immutable
  proposalEpochMs?: number;   // undefined = no proposal yet; excluded from quorum
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

// src/store/memory.ts — grace period cache (lives on InMemoryStore)
interface GracePeriodEntry {
  roomCode: string;
  participantToken: string;
  expiresAtMs: number;   // Date.now() + 30s at time of disconnect
  timer: NodeJS.Timeout; // cancelled on successful rejoin or room expiry
}
// gracePeriodCache: Map<sessionToken, GracePeriodEntry>
// GC sweeps also delete all entries for expired rooms.
```

---

## Heartbeat Timeline

The spec says "grace period triggers at ~25s of silence" which is loose wording. The canonical timeline is:

```
T+0s    Client connects; heartbeat starts
T+20s   Server sends native ping (socket.ping())
T+30s   Pong deadline: no pong received → isConnected=false
        → broadcast participant_disconnected
        → grace period timer starts (30s)
T+60s   Grace period expires: participant removed from room
        → broadcast participant_left
        → session token deleted from grace cache
```

**Full silence window before removal: 60s.** Reconnection window: T+30s to T+60s (30s).

---

## Broadcast Failure Policy

`broadcastToRoom()` is best-effort. If a send fails mid-broadcast:
- Call `cleanupSocket(socket)` immediately (marks participant disconnected, starts grace period)
- Continue broadcasting to remaining sockets
- **Do not retry, roll back, or re-broadcast** — partial delivery is acceptable; all participants will eventually converge via their own heartbeats and state updates

---

## Error Code Enum

From the spec (closed enum — do not add codes without product owner approval):

```typescript
export const ErrorCode = {
  ROOM_NOT_FOUND:    'ROOM_NOT_FOUND',
  ROOM_NOT_ACTIVE:   'ROOM_NOT_ACTIVE',
  ROOM_FULL:         'ROOM_FULL',
  RATE_LIMITED:      'RATE_LIMITED',
  INVALID_PROPOSAL:  'INVALID_PROPOSAL',
  REJOIN_FAILED:     'REJOIN_FAILED',
  INVALID_TOKEN:     'INVALID_TOKEN',
  // ROOM_LOCKED: pending product owner confirmation (plan addition)
} as const;
```

**Rate limiter scope:** Only `ROOM_NOT_FOUND` and `ROOM_FULL` responses increment the failed-join counter. `REJOIN_FAILED` and `INVALID_TOKEN` are reconnect errors and must NOT contribute to the rate limit (would penalize users for legitimate reconnection behavior).

---

## Phase Breakdown

### Phase 1 — Core (MVP Blocker)

**Build in this order (dependencies flow top to bottom):**

1. **Project scaffold** — `npm init`, `tsconfig.json` (strict, `moduleResolution: node16`), `.env.example`, ESLint/Prettier config, directory structure
2. **Error class** — `ProtocolError` + `ErrorCode` enum in `src/errors/index.ts` *(moved early; everything else depends on it)*
3. **Models** — `domain.ts` types + `messages.ts` discriminated unions; no logic, no side effects; commit and share with frontend immediately
4. **Wordlist module** — load adjectives.txt + nouns.txt at startup; validate non-empty; fail fast with clear message; `generateNickname()` → `"Teal Fox"`
5. **Crypto utils** — `generateToken()`; `generateParticipantToken()`
6. **In-memory store** — `InMemoryStore`: room Map + secondary index `participantToken→roomCode` + `gracePeriodCache` + GC timer (10s interval, expires rooms at 2hr inactivity); close all sockets and delete grace entries on room expiry
7. **Config validation** — Zod env schema; `loadConfig()`; server exits on invalid/missing config; `NODE_ENV=test` makes `CORS_ORIGIN` optional
8. **Room state machine** — `canTransitionToActive()`, `transitionToActive()`, `transitionToWaiting()` in `room.service.ts`; guards prevent invalid transitions; `locked_in` is terminal
9. **Fastify server** — `@fastify/websocket`; `GET /health`; `maxPayload: 64KB`; socket registry wired up
10. **Message validation** — `parseClientMessage()`: discriminated union narrowing, room code regex, epoch bounds, session token format
11. **WS registry** — `registry.ts`: `socketToMeta` + `roomToSockets` maps with `registerSocket()` / `cleanupSocket()`
12. **Join/leave handlers** — create/retrieve room; nickname assignment; `participant_joined`/`participant_left` broadcasts; `room_activated`/`room_deactivated` on threshold transitions; `participant_disconnected` on heartbeat timeout
13. **Heartbeat subsystem** — native `socket.ping()` every 20s; clear pong timeout on `pong` event; `isConnected=false` + `participant_disconnected` broadcast at T+30s; 30s grace period timer; `cancelGracePeriod()` for rejoin
14. **Rate limiter** — per-IP sliding window; counts only `ROOM_NOT_FOUND` + `ROOM_FULL` failures; 5-min window; exponential backoff after 3rd failure

**Phase 1 Definition of Done:**
- [ ] Two real WS clients can join the same room and receive each other's `participant_joined` broadcasts
- [ ] Heartbeat timers clean up correctly on disconnect (no zombie timers verified via test)
- [ ] `participant_disconnected` fires at T+30s; `participant_left` fires at T+60s
- [ ] Rate limiter blocks IP after threshold; only counts `ROOM_NOT_FOUND`/`ROOM_FULL`
- [ ] `GET /health` returns 200
- [ ] All unit tests pass; linter clean
- [ ] Server starts from `.env`; wordlist validated at startup; Zod rejects bad config

---

### Phase 2 — Proposal Protocol

**Depends on Phase 1 fully complete.**

1. **Proposal handler** — validate epoch bounds; reject if `room.state !== 'active'`; update `participant.proposalEpochMs`; broadcast `proposal_updated`; run lock-in check after every proposal
2. **Lock-in detection** — `truncateToMinute(epoch)`: floor to 60,000ms. Quorum rule: count only connected participants where `proposalEpochMs !== undefined`. If quorum ≥ 2 AND all truncated values are equal → lock-in. Connected participant with no proposal: not counted (does not block lock-in, does not contribute)
3. **Lock-in broadcast** — `locked_in: { epochMs }` to all connected sockets; room state → `locked_in` (terminal)
4. **Reject post-lock-in proposals** — `propose` to a `locked_in` room → error (code TBD per sign-off)
5. **Room state snapshot on join** — `joined` response includes full snapshot: state, `participants[]` (token, nickname, isConnected, proposalEpochMs), `lockedInEpochMs?`

**Phase 2 Definition of Done:**
- [ ] Two clients proposing the same epoch (±59s same minute) triggers `locked_in`
- [ ] Late-joining client (no proposal yet) does not block lock-in between the others
- [ ] Late-joining client receives full snapshot including existing proposals on `joined`
- [ ] Ghost participant excluded from quorum; 2 active agree → `locked_in`
- [ ] Proposals to `locked_in` room rejected correctly

---

### Phase 3 — Resilience

**Depends on Phase 2 complete.**

1. **Rejoin handler** — look up `gracePeriodCache[sessionToken]`; reject if expired or room code mismatch → `REJOIN_FAILED`; `cancelGracePeriod()`; restore `isConnected=true`; restart heartbeat; send full snapshot; broadcast `participant_reconnected`; re-evaluate room activation
2. **Dead-room UX** — differentiated errors: invalid code format → `INVALID_TOKEN`; room not found/expired → `ROOM_NOT_FOUND`; `locked_in` room join → `ROOM_LOCKED` (or `ROOM_NOT_FOUND` per sign-off)
3. **Room expiry broadcast** — GC timer sends `room_expired` to all connected sockets before deleting; `cleanupSocket()` all; purge grace cache entries for that room
4. **Graceful shutdown** — `SIGTERM`: stop accepting connections; broadcast `room_expired` to all rooms; close sockets; `store.stop()`; exit 0

**Phase 3 Definition of Done:**
- [ ] Disconnect for 20s → rejoin → same nickname, same proposal intact, full snapshot
- [ ] Disconnect for 35s → rejoin → `REJOIN_FAILED`
- [ ] Room inactive 2hr → `room_expired` broadcast + all connections closed cleanly
- [ ] Grace cache entries purged on room expiry (no memory leak)

---

### Phase 4 — Operations

**Can begin in parallel with Phase 3 testing.**

1. **CORS** — `CORS_ORIGIN` env var; reject all origins if unset in production; allow `*` only if `NODE_ENV=development`
2. **Structured logging** — Fastify's built-in Pino; `LOG_LEVEL` env var; log lifecycle events only (join, leave, lock-in, expire, error); never log session tokens, nicknames, or epoch timestamps
3. **Protocol versioning** — `protocolVersion: "1.0"` in `joined` response; server validates client version if provided (same major = compatible); clients that omit it are assumed compatible
4. **Docker** — minimal Dockerfile:
   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY package.json package-lock.json ./
   RUN npm ci --omit=dev
   COPY dist/ ./dist/
   EXPOSE 3000
   CMD ["node", "dist/main.js"]
   ```
5. **`GET /ready`** — returns 503 during graceful shutdown

---

## Testing Strategy

**Test pyramid:** 70% unit / 25% integration / 5% load

### Unit Test Targets

| Module | Key Test Cases |
|--------|---------------|
| `room.service` | waiting→active at 2 connected; active→waiting at 1; locked_in is terminal (both directions blocked) |
| Lock-in detection | All agree → lock-in; one mismatch → no lock-in; ghost excluded; **connected-but-no-proposal excluded**; single participant → no lock-in |
| `truncateToMinute()` | T+0s and T+59s → same value; T+60s → different value; negative epoch handled |
| `ratelimit.service` | ROOM_NOT_FOUND increments counter; REJOIN_FAILED does NOT; 3rd failure triggers backoff; 11th rejected; window resets at 5min |
| `validation` | Valid codes pass; invalid format rejects; epoch min/max bounds; session token 32-char hex; unknown message type handled |
| `wordlist.service` | Generates two-word Title Case nickname; empty wordlist throws at startup; wordlist with 1 word generates correctly |
| `crypto.ts` | Token is 32-char hex; 10,000 generated tokens are unique |
| `heartbeat.service` | No zombie timers after `stopHeartbeat()`; `cancelGracePeriod()` cancels before it fires; re-calling `startHeartbeat()` clears old timers first |

### Fake Timers (Required for Timing Tests)

```typescript
it('broadcasts participant_disconnected at pong deadline', () => {
  vi.useFakeTimers();
  const broadcastSpy = vi.fn();
  // advance to ping, then past pong deadline
  vi.advanceTimersByTime(20_000 + 10_000 + 1);
  expect(participant.isConnected).toBe(false);
  expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
    type: 'participant_disconnected',
  }));
  vi.useRealTimers();
});

it('removes participant after grace period', () => {
  vi.useFakeTimers();
  // disconnect, then expire grace
  vi.advanceTimersByTime(30_000 + 1);
  expect(room.participants.has(participantToken)).toBe(false);
  vi.useRealTimers();
});
```

### Lock-In Scenario Matrix

| Scenario | Expected |
|----------|---------|
| 2 participants, identical minute | `locked_in` |
| 2 participants, differ by 59s (same minute) | `locked_in` |
| 2 participants, differ by 60s (different minute) | No lock-in |
| 3 participants, all agree | `locked_in` |
| 3 participants, 2 agree, 1 ghost (disconnected) | `locked_in` (ghost excluded) |
| 3 participants, 2 agree, 1 connected but NO proposal | `locked_in` (no-proposal excluded from quorum) |
| 1 participant (waiting state) | No lock-in (proposals rejected — wrong state) |
| 2 participants, 1 has no proposal | No lock-in (only 1 in quorum; need ≥ 2) |

### Integration Test Flows

All use real Fastify server on random port with real `ws` connections:

1. **Happy path** — Alice joins (waiting), Bob joins (`room_activated`), Alice proposes, Bob proposes same time → `locked_in` received by both
2. **Late joiner quorum** — Alice + Bob agree; Carol joins but doesn't propose yet → `locked_in` already triggered (Carol excluded from quorum)
3. **Late joiner snapshot** — Room has proposals; Carol joins; Carol's `joined` includes existing proposals
4. **Reconnect within grace** — Client disconnects, reconnects within 30s → full snapshot, same nickname, same proposal
5. **Reconnect past grace** — Client disconnects, reconnects at 31s → `REJOIN_FAILED`
6. **Ghost exclusion** — 3 participants, one times out; remaining 2 agree → `locked_in`
7. **participant_disconnected timing** — Advance fake clock 30s → `participant_disconnected` fires; advance 30s more → `participant_left` fires
8. **Rate limiting** — 3 failed joins trigger backoff; 11th attempt → `RATE_LIMITED`
9. **Room expiry** — Advance clock 2hr → `room_expired` broadcast; all sockets closed

### CI Integration

```
lint + type-check       (<10s, fast gate)
unit tests (vitest)     (<5s, fake timers for all timing logic)
integration tests       (~15s, real server, random port)
build (tsc + esbuild)   (~5s)
```

Integration tests require `NODE_ENV=test` and have `CORS_ORIGIN` optional in Zod schema when `NODE_ENV=test`. Add a `vitest.setup.ts` that sets `process.env.NODE_ENV = 'test'` before imports.

Load tests (autocannon or k6) run on demand only, not in CI.

---

## Documentation Plan

Create alongside implementation, not after:

- `docs/PROTOCOL.md` — full message reference; finalized error code enum; timing table (T+20/30/60 heartbeat timeline); annotated examples (happy path, reconnect, locked-in room behavior)
- `docs/ARCHITECTURE.md` — state machine diagram; quorum rules; design decisions (no Redis, 50-cap, redeploy-only wordlist)
- `docs/DEVELOPMENT.md` — 5-min setup; `wscat` test commands; debugging; how to add a message type
- `docs/DEPLOYMENT.md` — env vars table; Docker build; health/readiness; Pino log fields; incident runbook
- `src/models/domain.ts` + `src/models/messages.ts` — TypeScript API contract; share with frontend from first commit
- `CHANGELOG.md` — Protocol v1.0.0 initial entry; use Keep a Changelog format

---

## Environment Variables

```bash
# Required in production
CORS_ORIGIN=https://your-frontend.example.com

# Optional (defaults listed)
PORT=3000
NODE_ENV=development          # 'test' makes CORS_ORIGIN optional
LOG_LEVEL=info

HEARTBEAT_PING_MS=20000
HEARTBEAT_PONG_TIMEOUT_MS=10000
HEARTBEAT_GRACE_PERIOD_MS=30000

ROOM_TTL_MS=7200000           # 2 hours
GC_INTERVAL_MS=10000          # GC check every 10s

RATE_LIMIT_WINDOW_MS=300000   # 5 minutes
RATE_LIMIT_MAX_ATTEMPTS=10
RATE_LIMIT_BACKOFF_AFTER=3
MAX_PARTICIPANTS_PER_ROOM=50
```

All validated with Zod at startup; server exits with a clear field-level error if invalid.

---

## Implementation Sequence

```
1.  Scaffold (tsconfig, pnpm, ESLint, dirs, .env.example)
2.  ProtocolError + ErrorCode enum  ← moved early; all other code depends on it
3.  Models (domain.ts, messages.ts) ← share with frontend immediately
4.  Wordlists + nickname generation
5.  Crypto utils
6.  In-memory store + grace period cache + GC
7.  Config validation (Zod)
8.  Room state machine (unit-tested)
9.  Fastify + /health + WS scaffold + registry.ts
10. Message validation (parseClientMessage)
11. Join/leave handlers + broadcast
12. Heartbeat subsystem (unit-tested with fake timers)
13. Rate limiter
    ── Phase 1 done ──
14. Proposal handler + lock-in detection
15. Room snapshot serializer
    ── Phase 2 done ──
16. Rejoin handler + grace period cancellation
17. Dead-room UX + room expiry broadcast
18. Graceful shutdown
    ── Phase 3 done ──
19. CORS middleware
20. Structured logging (Pino config)
21. Protocol versioning in joined response
22. Docker + /ready endpoint
    ── Phase 4 done ──
```

---

## Verification

**Phase 1 end-to-end:**
```bash
# Terminal 1
npm run dev

# Terminal 2
wscat -c ws://localhost:3000
> {"type":"join","roomCode":"purple-falcon-bridge"}
# Expect: {"type":"joined","sessionToken":"...","nickname":"Teal Fox","room":{...}}

# Terminal 3
wscat -c ws://localhost:3000
> {"type":"join","roomCode":"purple-falcon-bridge"}
# T2 receives: {"type":"participant_joined","participantToken":"...","nickname":"Azure Sloth"}
# T3 receives: {"type":"joined",...,"room":{"state":"active",...}}
```

**Phase 2 end-to-end:**
```bash
# In T2:
> {"type":"propose","epochMs":1711209600000}
# T2 + T3 receive: {"type":"proposal_updated",...}

# In T3 (same minute):
> {"type":"propose","epochMs":1711209630000}
# T2 + T3 receive: {"type":"locked_in","epochMs":1711209600000}
```

---

## Critical Files to Create

| File | Purpose |
|------|---------|
| `src/main.ts` | Entry point |
| `src/errors/index.ts` | ProtocolError + ErrorCode (create first) |
| `src/config/index.ts` | Zod env validation |
| `src/models/domain.ts` | Core domain types (exported to frontend) |
| `src/models/messages.ts` | WS message types (exported to frontend) |
| `src/store/memory.ts` | InMemoryStore + grace period cache + GC |
| `src/services/room.service.ts` | State machine |
| `src/services/heartbeat.service.ts` | Ping/pong/grace period |
| `src/services/ratelimit.service.ts` | Sliding window rate limit |
| `src/services/wordlist.service.ts` | Nickname generation |
| `src/ws/registry.ts` | socketToMeta + roomToSockets registries |
| `src/ws/handlers.ts` | WS message dispatch |
| `src/ws/broadcast.ts` | Safe fan-out with failure cleanup |
| `src/utils/validation.ts` | parseClientMessage() |
| `tests/integration/ws.integration.test.ts` | Multi-client flows |
| `docs/PROTOCOL.md` | Frontend API contract |

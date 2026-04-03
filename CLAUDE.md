# CLAUDE.md

## Project Scope
This repo is the server only. The frontend lives in a separate repository.
Do not add frontend code, components, or client-side logic here.

## Working Preferences
- When the user is unsure about a design or architecture decision, spawn a relevant
  expert subagent (UX designer, WebSocket specialist, backend engineer, etc.) to
  provide an opinion before asking the user to decide.
- When walking through a list of open questions, do so interview-style — one question
  at a time — rather than presenting all questions at once.
- Default to MVP simplicity. Do not add capabilities "for later" unless explicitly asked.

## Coding Style
- Use descriptive variable names — avoid abbreviations or opaque suffixes.
- Name `Promise<_>` variables with a `$` suffix: `aliceJoined$`, not `aliceJoinedP` or `aliceJoinedPromise`.

## Tooling
- **Package manager:** npm.
- **Dev server:** `npm run dev` runs `tsx watch` (JIT TypeScript; no build step needed).
- **Build:** `npm run build` runs `tsc` → `esbuild`. Note: esbuild's default CJS output is **incompatible with top-level await** in this codebase. The Docker build uses `npx tsc` directly (not `npm run build`) to avoid this.
- **Tests:** Vitest. Use `vi.useFakeTimers()` for all timing-sensitive tests (heartbeat, grace period, room expiry). Do not write slow tests that sleep or wait on real timers.
- **E2E tests:** `npm run test:e2e` — excluded from `npm test`. Uses `E2E_HOST` env var (do **not** use `BASE_URL`; it is commonly pre-set to `/` by shell environments and the `??` operator won't override it). Default target is `localhost:3000`. Run against deployed service with `E2E_HOST=<host> npm run test:e2e`.
- **tsconfig:** `"moduleResolution": "node16"` is required. The default `"node"` breaks ESM/CJS interop with Fastify and ws on Node 20.

## Architecture Invariants

### State machine
- Room states: `waiting` (1 participant) → `active` (2+) → `locked_in`.
- `locked_in` is **terminal** — no transitions out, ever. Do not add code that exits this state.

### Lock-in quorum rule
A connected participant **with no proposal is excluded from quorum** — they neither block nor contribute to lock-in. Lock-in requires: at least 2 participants with proposals, and all their minute-truncated epochs match. This is intentional so late joiners don't stall an agreement already in progress.

### Rate limiter scope
Only `ROOM_NOT_FOUND` and `ROOM_FULL` errors increment the failed-join counter. `REJOIN_FAILED`, `INVALID_TOKEN`, and `SERVER_AT_CAPACITY` must **not** count. `REJOIN_FAILED` and `INVALID_TOKEN` are reconnection errors; penalizing them would block legitimate recovery. `SERVER_AT_CAPACITY` is a transient server condition — the client did nothing wrong.

### Heartbeat & grace period timeline
```
T+0s   Connect
T+20s  Server sends native ping
T+30s  No pong → isConnected=false; broadcast participant_disconnected; 30s grace starts
T+60s  Grace expires → participant removed; broadcast participant_left
```
Full silence before removal: 60s. Reconnect window: T+30s–T+60s (30s).

### Broadcast failure policy
`broadcastToRoom()` is best-effort. On send failure, call `cleanupSocket()` and continue to remaining sockets. No retries, no rollback. Partial delivery is acceptable.

### Build order
`src/errors/index.ts` (ProtocolError + ErrorCode enum) must be written **first** — everything else imports from it. `src/models/domain.ts` and `src/models/messages.ts` should be committed early; they are the shared TypeScript API contract for the frontend team.

### Capacity & load management
The server gates **new room creation** (not joins to existing rooms) when event loop p95 lag exceeds `EVENT_LOOP_LAG_THRESHOLD_MS` (default: 100ms). Clients receive `SERVER_AT_CAPACITY` and should retry after checking `GET /capacity`. `src/metrics/capacity.ts` owns `isAcceptingRooms(thresholdMs)`. When stats are unavailable (monitor not running), the function returns `true` — safe default, never block on missing data.

`GET /capacity` is rate-limited per IP (10 req/min, inline in `src/main.ts`). It always returns HTTP 200; capacity is a soft signal, not an infrastructure failure.

## Architecture Notes

### Room code format
Room codes must match `/^[a-z]+-[a-z]+-[a-z]+$/` — three purely lowercase alphabetic words, no digits. Validated by Zod in `src/utils/validation.ts`. When generating test room codes, use random alpha-only strings; do not use alphanumeric IDs.

### Docker / deployment
- The `Dockerfile` is multi-stage. After `npx tsc`, wordlist `.txt` files must be explicitly copied: `COPY src/wordlists ./dist/wordlists`. The TypeScript compiler does not copy non-`.ts` assets.
- The `.dockerignore` must **not** exclude `src/` or `tsconfig.json` — the build stage needs them.
- Deployed on Northflank free Developer Sandbox. See `docs/DEPLOY_NORTHFLANK.md` for the step-by-step guide.

### E2E test message ordering
Over a real network, always register all WebSocket message listeners **before** sending. Sequential `await nextMessage(alice); await nextMessage(bob)` works locally (synchronous event loop) but drops messages in production — the second message can arrive before the second listener is registered. Use the parallel pattern instead:
```typescript
const aliceMsg$ = nextMessage(alice);
const bobMsg$ = nextMessage(bob);
send(alice, { type: 'propose', epochMs: epoch });
await Promise.all([aliceMsg$, bobMsg$]);
```

## Pending Product Owner Sign-Offs
These two decisions are deliberately unresolved. Do not implement them unilaterally:
1. **`ROOM_LOCKED` error code** — Is it added to the closed enum, or do locked-in rooms reuse `ROOM_NOT_FOUND`?
2. **Heartbeat timeline** — Confirm the T+20/30/60 breakdown above before writing heartbeat or grace period code.

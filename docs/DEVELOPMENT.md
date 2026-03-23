# CollabTime Party Server — Development Guide

## 5-Minute Setup

```bash
# Clone and install
git clone <repo-url>
cd collabtime-party-server
npm install

# Copy env and start
cp .env.example .env
npm run dev
# → Server listening on http://0.0.0.0:3000
```

`npm run dev` uses `tsx watch` — no build step needed. TypeScript is executed directly
and the server restarts on file changes.

---

## Environment

Copy `.env.example` to `.env`. For local development, only one variable is usually needed:

```bash
NODE_ENV=development   # enables CORS * and makes CORS_ORIGIN optional
```

See `docs/DEPLOYMENT.md` for the full env var reference.

---

## Running Tests

```bash
npm test              # run all tests once
npm run test:watch    # watch mode
npm run typecheck     # type-check without emitting
npm run lint          # ESLint
```

All timing-sensitive tests (heartbeat, grace period, room expiry) use `vi.useFakeTimers()`
— they run in milliseconds without sleeping.

---

## Manual Testing with wscat

Install: `npm install -g wscat`

### Happy path — two clients, lock-in

```bash
# Terminal 1 — Alice
wscat -c ws://localhost:3000/ws
> {"type":"join","roomCode":"purple-falcon-bridge"}
# ← {"type":"joined","sessionToken":"...","nickname":"Teal Fox","room":{"state":"waiting",...}}

# Terminal 2 — Bob
wscat -c ws://localhost:3000/ws
> {"type":"join","roomCode":"purple-falcon-bridge"}
# Terminal 1 ← {"type":"room_activated","participants":[...]}
# Terminal 2 ← {"type":"joined","nickname":"Azure Sloth","room":{"state":"active",...}}

# Terminal 1 — propose
> {"type":"propose","epochMs":1711209600000}
# Both terminals ← {"type":"proposal_updated",...}

# Terminal 2 — propose same minute
> {"type":"propose","epochMs":1711209630000}
# Both terminals ← {"type":"proposal_updated",...}
# Both terminals ← {"type":"locked_in","epochMs":1711209600000}
```

### Health checks

```bash
curl http://localhost:3000/health
# → {"status":"ok"}

curl http://localhost:3000/ready
# → {"status":"ok"}
```

---

## Project Structure

```
src/
├── main.ts                   Entry point: Fastify server, CORS, /health, /ready, SIGTERM
├── config/
│   ├── index.ts              Zod env schema; loadConfig(); exits on invalid config
│   └── constants.ts          ROOM_CODE_PATTERN, PROTOCOL_VERSION, isCompatibleVersion()
├── models/
│   ├── domain.ts             Room, Participant, RoomState — shared TypeScript contract
│   └── messages.ts           ClientMessage / ServerMessage discriminated unions
├── store/
│   ├── types.ts              Store interface (enables DI in tests)
│   └── memory.ts             InMemoryStore + GC timer + grace period cache
├── services/
│   ├── room.service.ts       Pure state machine: transitions, checkLockIn, truncateToMinute
│   ├── heartbeat.service.ts  Ping/pong timers, grace period start/cancel
│   ├── ratelimit.service.ts  Per-IP sliding window with exponential backoff
│   └── wordlist.service.ts   Nickname generation from adjectives.txt + nouns.txt
├── ws/
│   ├── registry.ts           socketToMeta + roomToSockets maps
│   ├── broadcast.ts          broadcastToRoom() + sendTo() with failure cleanup
│   └── handlers.ts           Message dispatch: join, rejoin, propose, leave
├── errors/
│   └── index.ts              ProtocolError class + ErrorCode enum
└── utils/
    ├── crypto.ts             generateToken() / generateParticipantToken()
    └── validation.ts         parseClientMessage() — Zod schema validation
```

---

## Adding a New Message Type

1. **Add to `src/models/messages.ts`** — extend `ClientMessage` or `ServerMessage` union.
2. **Add Zod schema in `src/utils/validation.ts`** — add to `clientMessageSchema` discriminated union if client-sent.
3. **Handle in `src/ws/handlers.ts`** — add a `case` in the `switch (msg.type)` block in `handleMessage`.
4. **Add unit tests** — in `tests/unit/` for business logic, `tests/integration/ws.integration.test.ts` for the full flow.

---

## Debugging Tips

**See all Pino log output in pretty format:**
```bash
LOG_LEVEL=debug npm run dev | npx pino-pretty
```

**Check what's in the store at runtime:**
The store is not exposed over HTTP. Add a temporary `console.log` in `main.ts`
referencing `store.getAllRooms()`, or use the Node.js inspector:
```bash
node --inspect-brk $(which tsx) src/main.ts
```

**Heartbeat fires too slowly in dev?**
Set short values in `.env`:
```bash
HEARTBEAT_PING_MS=5000
HEARTBEAT_PONG_TIMEOUT_MS=3000
HEARTBEAT_GRACE_PERIOD_MS=10000
```

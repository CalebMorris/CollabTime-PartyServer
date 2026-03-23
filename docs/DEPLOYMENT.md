# CollabTime Party Server — Deployment

## Environment Variables

All variables are validated by Zod at startup. The server exits with a field-level
error message if any required variable is missing or invalid.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORS_ORIGIN` | Production only | — | Allowed frontend origin, e.g. `https://app.example.com`. Omitting in production causes startup failure. |
| `PORT` | No | `3000` | TCP port to listen on |
| `NODE_ENV` | No | `development` | `development` \| `production` \| `test`. In `development`, CORS allows `*`. |
| `LOG_LEVEL` | No | `info` | Pino log level: `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `HEARTBEAT_PING_MS` | No | `20000` | Milliseconds after connect before server sends ping |
| `HEARTBEAT_PONG_TIMEOUT_MS` | No | `10000` | Milliseconds after ping before declaring disconnect |
| `HEARTBEAT_GRACE_PERIOD_MS` | No | `30000` | Milliseconds after disconnect before participant is removed |
| `ROOM_TTL_MS` | No | `7200000` | Room inactivity TTL (2 hours) |
| `GC_INTERVAL_MS` | No | `10000` | How often GC checks for expired rooms |
| `RATE_LIMIT_WINDOW_MS` | No | `300000` | Sliding window for rate limit (5 minutes) |
| `RATE_LIMIT_MAX_ATTEMPTS` | No | `10` | Max failed join attempts before blocking |
| `RATE_LIMIT_BACKOFF_AFTER` | No | `3` | Failed attempts before exponential backoff begins |
| `MAX_PARTICIPANTS_PER_ROOM` | No | `50` | Hard cap per room |

---

## Docker Build and Run

```bash
# Build production bundle
npm run build

# Build image
docker build -t collabtime-party-server .

# Run
docker run -d \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e CORS_ORIGIN=https://your-frontend.example.com \
  --name collabtime \
  collabtime-party-server
```

The `Dockerfile` expects a pre-built `dist/` directory. Always run `npm run build`
before `docker build`.

---

## Health and Readiness

| Endpoint | Method | Success | Failure |
|----------|--------|---------|---------|
| `/health` | GET | `200 {"status":"ok"}` | — (always 200 if process is alive) |
| `/ready` | GET | `200 {"status":"ok"}` | `503 {"status":"shutting_down"}` during SIGTERM |

Use `/health` for liveness probes. Use `/ready` for readiness probes and load balancer
drain — it returns 503 during graceful shutdown so traffic stops routing before sockets close.

---

## Graceful Shutdown

On `SIGTERM`:
1. `/ready` starts returning 503.
2. GC timer stops (no new expirations).
3. `room_expired` is broadcast to all connected sockets.
4. All sockets are closed.
5. Fastify closes (stops accepting new connections).
6. Process exits 0.

Allow at least 5 seconds for drain between SIGTERM and SIGKILL in your orchestrator.

---

## Structured Logs (Pino)

All logs are JSON to stdout. Fields logged per event:

| Event | Log level | Fields |
|-------|-----------|--------|
| Server start | `info` | `port` |
| `participant_joined` | `info` | `roomCode`, `participantToken`, `roomState` |
| `participant_left` | `info` | `roomCode`, `participantToken` |
| `participant_rejoined` | `info` | `roomCode`, `participantToken` |
| `room_locked_in` | `info` | `roomCode` |
| `room_expired` | `info` | `roomCode` |
| Config/startup errors | `error` | field name + message |

**Never logged:** session tokens, nicknames, epoch timestamps. These are user data
and excluded by design.

---

## Kubernetes Example

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 2
  periodSeconds: 5

lifecycle:
  preStop:
    exec:
      command: ["sleep", "5"]   # allow load balancer drain before SIGTERM
```

---

## Incident Runbook

### Room stuck in `active` but no one is connected

The GC will clean up rooms idle for 2 hours. For faster recovery, restart the process
(all state is ephemeral).

### Participants not receiving messages after reconnect

Verify the client reconnected with `rejoin` (not `join`) within the 30-second grace
window. A `join` after disconnect creates a new participant identity.

### High memory usage

Each room holds participant state and socket references. Default cap is 50 participants
per room. If the number of active rooms is unexpectedly high, check for room code
collisions (clients sharing the same code unintentionally) or reduce `ROOM_TTL_MS`.

### Rate limiting blocking legitimate users

The rate limiter counts only `ROOM_NOT_FOUND` and `ROOM_FULL` failures, not
reconnection errors. If a user is blocked, the 5-minute window (`RATE_LIMIT_WINDOW_MS`)
resets automatically. The backoff is per-IP — a NAT/proxy may cause false positives;
increase `RATE_LIMIT_BACKOFF_AFTER` if needed.

### Server won't start — config error

The startup log will print each failing field:
```
Invalid configuration:
  CORS_ORIGIN: Required in production
```
Fix the environment variable and restart.

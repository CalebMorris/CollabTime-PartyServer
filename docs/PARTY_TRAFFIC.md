# Party Session WebSocket Traffic Analysis

Estimates for a complete party session lifecycle: join → propose time → lock in → disconnect.
Based on actual message types and payload sizes from `src/room/roomProtocol.ts`.

## Message Inventory

### Client → Server

| Message | Payload | Size | When sent |
|---|---|---|---|
| `join` | `{type, roomCode, protocolVersion}` | ~65 B | On first connection to a room (no session token in sessionStorage) |
| `rejoin` | `{type, roomCode, sessionToken, protocolVersion}` | ~120 B | On reconnection when a session token exists in sessionStorage; replaces `join` |
| `propose` | `{type, epochMs}` | ~40 B | Each time the user submits or changes their proposed time |
| `leave` | `{type}` | ~14 B | When the user voluntarily leaves the room |

**Per user total (1 proposal, no reconnect): ~119 B**

### Server → Client

| Message | Payload | Size | When sent |
|---|---|---|---|
| `joined` | `{type, sessionToken, participantToken, nickname, protocolVersion, room{...participants}}` | 380 B (2p) / 650 B (5p) / 1,150 B (10p) | Sent to the connecting client after a successful `join` or `rejoin` |
| `participant_joined` | `{type, participantToken, nickname}` | ~75 B | Broadcast when a new participant joins the room |
| `room_activated` | `{type, participants[...]}` | 120 B (2p) / 280 B (5p) / 520 B (10p) | Broadcast when room reaches 2+ active participants |
| `room_deactivated` | `{type}` | ~23 B | Broadcast when room drops below 2 active participants |
| `participant_disconnected` | `{type, participantToken}` | ~65 B | Broadcast when a participant loses their connection but remains in the room |
| `participant_reconnected` | `{type, participantToken}` | ~65 B | Broadcast when a previously disconnected participant reconnects |
| `proposal_updated` | `{type, participantToken, epochMs}` | ~80 B | Broadcast when any participant submits or changes their proposal |
| `locked_in` | `{type, epochMs}` | ~45 B | Broadcast when the room reaches consensus and locks in a time |
| `participant_left` | `{type, participantToken}` | ~65 B | Broadcast when a participant explicitly leaves the room |
| `room_expired` | `{type}` | ~23 B | Sent when the room expires server-side (terminal) |
| `error` | `{type, code, message?}` | ~65 B | Sent on error conditions — see error codes below |

Server broadcasts `proposal_updated`, `room_activated`, and `participant_joined` to **all connected clients** — these dominate server→client volume.

## Per-Party Totals

| Party Size | Client → Server | Server → Client | Overhead¹ | **Total** | Per User |
|---|---|---|---|---|---|
| 2 people | 238 B | 1,325 B | 410 B | **~2 KB** | ~1 KB |
| 5 people | 595 B | 6,775 B | 530 B | **~7.9 KB** | ~1.6 KB |
| 10 people | 1,190 B | 25,025 B | 740 B | **~27 KB** | ~2.7 KB |

¹ Overhead includes WebSocket framing (~6 B/message) and TLS handshake (~320 B one-time per connection).

## Heartbeat (Ping/Pong)

The server uses **WebSocket protocol-level ping/pong control frames** — not JSON messages. The browser automatically responds to pings with no client JS required.

Default timings (from `server/src/config/index.ts`):

| Config | Default | Description |
|---|---|---|
| `HEARTBEAT_PING_MS` | 20,000 ms | Server sends a ping every 20s per connected socket |
| `HEARTBEAT_PONG_TIMEOUT_MS` | 10,000 ms | If no pong within 10s, participant is marked disconnected |
| `HEARTBEAT_GRACE_PERIOD_MS` | 30,000 ms | Window for client to `rejoin` before being permanently removed |

Each ping/pong cycle is **~2 B each = 4 B per cycle** (WebSocket control frame, empty payload).

| Session duration | Cycles (at 20s interval) | Per-user heartbeat traffic |
|---|---|---|
| 5 min | ~15 | ~60 B |
| 10 min | ~30 | ~120 B |
| 30 min | ~90 | ~360 B |

Heartbeat traffic is symmetric (server→client ping, client→server pong) and adds negligible bytes relative to JSON message volume.

## Reconnection Overhead

A single reconnect event produces three messages: the reconnecting client sends `rejoin`; the server broadcasts `participant_disconnected` to all other participants (once, when the drop is detected) and `participant_reconnected` to all participants (once, when the rejoin succeeds).

| Party Size | `rejoin` (C→S) | `participant_disconnected` broadcast (S→C) | `participant_reconnected` broadcast (S→C) | **Total** |
|---|---|---|---|---|
| 2 people | 120 B | 65 B × 1 other = 65 B | 65 B × 2 all = 130 B | **~315 B** |
| 5 people | 120 B | 65 B × 4 others = 260 B | 65 B × 5 all = 325 B | **~705 B** |
| 10 people | 120 B | 65 B × 9 others = 585 B | 65 B × 10 all = 650 B | **~1,355 B** |

These figures assume a clean rejoin (one disconnect + one reconnect). Multiple flaps multiply linearly.

## Error & Expiry Messages

These messages are terminal — the session ends after they are received and no further traffic is expected on that connection.

| Message | Code(s) | Effect |
|---|---|---|
| `error` | `ROOM_NOT_FOUND` | Room is locked or expired; join rejected. Session cleared. |
| `error` | `ROOM_FULL` | Room has reached its participant limit. Session cleared. |
| `error` | `REJOIN_FAILED` | Session token is no longer valid (e.g. token expired). Session cleared. |
| `error` | `INVALID_TOKEN` | Participant token unrecognised. Session cleared. |
| `error` | `ROOM_NOT_ACTIVE`, `RATE_LIMITED`, `INVALID_PROPOSAL` | Non-terminal — connection stays open, `errorCode` is surfaced to the UI. |
| `room_expired` | — | Room has expired server-side. Session cleared, connection closed. |

Because terminal errors end the connection immediately, they add only a single ~65 B message to the session total and contribute negligible ongoing traffic cost.

## Scaling Estimates

| Sessions/month | Party size | Total egress | Northflank ($0.15/GB) |
|---|---|---|---|
| 1,000 | 5 people | ~7.9 MB | ~$0.001 |
| 10,000 | 5 people | ~79 MB | ~$0.012 |
| 100,000 | 5 people | ~790 MB | ~$0.12 |
| 1,000,000 | 10 people | ~27 GB | ~$4.05 |

## Notes

- **Heartbeat is ping/pong at the WebSocket protocol level** — not JSON. The server pings every 20s; the browser auto-responds. A missed pong triggers `participant_disconnected` broadcast and a 30s grace period for rejoin.
- **`rejoin` replaces `join` on reconnection** — when a session token is present in sessionStorage, the client sends `rejoin` (carrying the token) instead of a fresh `join`. The server responds with a `joined` message restoring the prior session state.
- **Server→client is the dominant direction** due to broadcast fan-out (`proposal_updated` alone = 80 B × N clients per proposal change).
- **Multiple proposals per user** (user adjusts their time): each re-proposal adds 80 × N bytes server→client.
- **Egress cost is negligible** at realistic usage volumes for this app — the $0.15/GB Northflank rate only becomes meaningful at millions of sessions/month.

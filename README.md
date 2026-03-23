# CollabTime — Party System Server

A lightweight, ephemeral WebSocket relay server for multiplayer timezone negotiation. Groups create or join a session, propose meeting times (each person sees times in their own timezone), and converge by proposing the same time. No accounts. No voting. When everyone agrees — they're **Locked In**.

---

## Core Goals

- **No accounts, no friction** — anyone with a room code can join instantly
- **Privacy by design** — timezones hidden from other participants; auto-generated anonymous nicknames; no persistent data after session ends
- **Ephemeral sessions** — in-memory only; auto-expires after ~2 hours of inactivity
- **Agreement through convergence** — no voting buttons; "agreement" means everyone proposes the same time

---

## Key Features

### Room Identity
- Room codes are 3-word passphrases (`adjective-noun-noun`, e.g., `purple-falcon-bridge`)
- ~64 billion combinations — orders of magnitude stronger than JackBox-style 4-letter codes
- Code IS the room — no separate room name
- Shareable link format: `?code=purple-falcon-bridge`

### Room States
- **Waiting** — creator is alone; proposals rejected with `ROOM_NOT_ACTIVE`; lock-in not possible
- **Active** — 2+ participants present; proposals accepted; lock-in possible
- **Locked In** — terminal state; triggered when all active participants match at minute precision; permanent and cannot be broken by subsequent disconnects
- If an active room drops below 2 participants, it reverts to waiting (proposals preserved; room stays alive subject to 2hr expiry)

### Core Mechanic
- Server is timezone-blind — clients send and receive epoch timestamps (ms) only; all timezone conversion is client-side
- Each participant has one active proposal at a time; new proposal silently replaces old
- Proposals compared at **minute precision** — sub-minute differences are considered equal
- **Win condition:** all active participants have identical proposals (minute-truncated) → "Locked In"
- Late joiners see all current proposals immediately; counted in quorum only after submitting their first proposal
- Post lock-in: confirmed epoch timestamp encoded in URL (`?locked-in=<code>&time=<epoch>`); new session required to re-negotiate

### Privacy & Security
- **Timezones hidden** — server never receives, stores, or broadcasts timezone data; conversion is entirely client-side
- **Auto-generated nicknames** — format: `Adjective Noun` (e.g., "Teal Fox"); assigned on join, immutable for the session; server-side curated wordlist (~1M combinations)
- **Session tokens** — 128-bit cryptographically random; server-issued on join; never broadcast or included in URLs
- **Participant tokens** — 128-bit cryptographically random; stable identity key used in broadcasts; distinct from session token
- **Rate limiting** — max 10 failed join attempts per IP per 5 minutes; exponential backoff after 3
- **Minimal logging** — errors and anonymized connection events only; no names, times, or timezones in persistent logs
- **Transport** — HTTPS + WSS required; no plaintext connections
- **Input validation** — `propose` payloads are bounds-validated server-side; room codes max 30 chars, three lowercase words separated by hyphens

### Session Lifecycle
- Ephemeral — in-memory only; lost on server restart
- Auto-expires after ~2 hours of inactivity
- **Heartbeat** — server-initiated ping every 20s; client must pong within 10s; grace period triggers at ~25s of silence
- **Reconnection grace period** — 30 seconds; session token reclaims slot; on success returns full room state snapshot; on failure returns `REJOIN_FAILED` error (client should prompt fresh join)
- Disconnected participants shown as ghosts — proposal retained, excluded from quorum; cleared on reconnect (`participant_reconnected` broadcast) or removed on grace expiry (`participant_left` broadcast)

### Client Contract
The server is UI-agnostic. The frontend lives in a separate repository. Server responsibilities:
- Broadcast proposals to all participants; clients handle all timezone rendering
- Never broadcast a participant's timezone — server never receives it
- Issue and validate session tokens; never expose session tokens in broadcast messages
- Assign nickname from server-side wordlist on join; nickname is immutable for the session
- Evaluate quorum and fire `locked_in` event when all active participants' proposals match at minute precision
- Reject `propose` messages in waiting state with `ROOM_NOT_ACTIVE`

### WebSocket Message Protocol

**Client → Server**
| Message | Payload |
|---|---|
| `join` | room code |
| `rejoin` | room code, session token |
| `propose` | epoch timestamp (ms) |
| `leave` | _(none)_ |

**Server → Client (unicast)**
| Message | Payload |
|---|---|
| `joined` | session token, nickname, full room state snapshot (participant list + proposals + room status) |
| `error` | code (closed enum), message |

**Server → All Clients (broadcast)**
| Message | Payload |
|---|---|
| `participant_joined` | participant token, nickname |
| `participant_reconnected` | participant token |
| `participant_disconnected` | participant token |
| `participant_left` | participant token |
| `proposal_updated` | participant token, epoch timestamp (ms) |
| `room_activated` | participant list |
| `room_deactivated` | _(none — room reverted to waiting)_ |
| `room_expired` | _(none — 2hr inactivity expiry)_ |
| `locked_in` | confirmed epoch timestamp (ms) |

**Error codes (closed enum)**
`ROOM_NOT_FOUND` · `ROOM_NOT_ACTIVE` · `ROOM_FULL` · `RATE_LIMITED` · `INVALID_PROPOSAL` · `REJOIN_FAILED` · `INVALID_TOKEN`

---

## Dead-Room UX

When a user opens a link to an inactive or invalid session:

| Scenario | Behavior |
|---|---|
| **Expired** | "This session has expired" — offer Create New or enter different code |
| **Never existed / typo** | "We couldn't find that session" — offer enter different code or Create New |
| **Locked In** | "This session has concluded" — preserve confirmed time from URL, offer Copy Confirmed Time |
| **Invalid format** | "That's not a valid room code" — offer enter different code |
| **Network error** | "Connection lost" — offer Retry |

The locked-in case is special: the confirmed time is encoded in the URL so late arrivals can still retrieve it.

---

## Implementation Phases

| Phase | Description |
|---|---|
| **Phase 1** | Core Node.js WebSocket server — room creation, participant management, in-memory store, rate limiting, heartbeat, expiry |
| **Phase 2** | Time proposal protocol — shared TypeScript types, WebSocket message schema, lock-in detection, URL generation |
| **Phase 3** | Resilience — reconnection grace period, dead-room handling, full error response schema |
| **Phase 4** | Deployment — WSS/HTTPS termination, CORS, structured logging pipeline |

---

## Open Questions

### Blocks Shipping

1. **CORS policy** — locked to the frontend domain, or open to any origin?
2. **Session size limits** — max participants per room?
3. **Multi-tab behavior** — two tabs with the same session get separate tokens; intended behavior?
4. **Log retention** — exact retention window and access controls for operational logs?
5. **Wordlist updates** — hot-reloadable or requires redeploy? What happens to active nicknames if wordlist changes?
6. **Export screen privacy** — are timezone offsets shown on the post-lock-in export screen? (Privacy decisions cover the room view but not the export)

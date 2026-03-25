# CollabTime Party Server — WebSocket Protocol v1.0

This document is the authoritative API contract for the frontend team.
All messages are JSON, sent over a single WebSocket connection to `ws://<host>/ws`.

---

## Connection

```
ws://<host>/ws
```

After connecting, the client must send either a `join` or `rejoin` message. The server
does not send anything until a message is received.

---

## Protocol Versioning

- The server sends `protocolVersion: "1.0"` in every `joined` response.
- Clients MAY include `protocolVersion` in `join`/`rejoin` messages.
- Compatibility is checked by major version. A client on `"1.x"` is compatible with a
  server on `"1.y"`. If incompatible, the server responds with an `error` (`INVALID_TOKEN`)
  and closes the connection.
- Clients that omit `protocolVersion` are assumed compatible.

---

## Client → Server Messages

### `join`

Join or create a room. If the room code does not exist, the server creates it.

```json
{
  "type": "join",
  "roomCode": "purple-falcon-bridge",
  "protocolVersion": "1.0"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roomCode` | string | yes | Three lowercase words separated by hyphens: `/^[a-z]+-[a-z]+-[a-z]+$/` |
| `protocolVersion` | string | no | Client protocol version. Checked for major compatibility. |

---

### `rejoin`

Reconnect within the grace period after a heartbeat timeout.

```json
{
  "type": "rejoin",
  "roomCode": "purple-falcon-bridge",
  "sessionToken": "a3f8...",
  "protocolVersion": "1.0"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roomCode` | string | yes | Must match the room from the original `join` |
| `sessionToken` | string | yes | 32-character hex token received in the original `joined` response |
| `protocolVersion` | string | no | Client protocol version |

---

### `propose`

Submit or update a meeting time proposal. Room must be in `active` state.

```json
{
  "type": "propose",
  "epochMs": 1711209600000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `epochMs` | integer | yes | Unix timestamp in milliseconds. Range: `0`–`9999999999999`. |

A participant may update their proposal by sending `propose` again.

---

### `leave`

Voluntarily leave the room. The server removes the participant immediately (no grace period).

```json
{ "type": "leave" }
```

---

## Server → Client Messages

### `joined`

Sent to the joining client after a successful `join` or `rejoin`.

```json
{
  "type": "joined",
  "sessionToken": "a3f8c2d1...",
  "participantToken": "9b4e7f2a...",
  "nickname": "Teal Fox",
  "protocolVersion": "1.0",
  "room": {
    "code": "purple-falcon-bridge",
    "state": "waiting",
    "participants": [
      {
        "participantToken": "9b4e7f2a...",
        "nickname": "Teal Fox",
        "isConnected": true,
        "proposalEpochMs": null
      }
    ],
    "lockedInEpochMs": null
  }
}
```

**Store `sessionToken` and `participantToken`.** The `sessionToken` is needed for `rejoin`.
The `participantToken` is your stable identity in the room.

---

### `participant_joined`

Broadcast to all existing participants when a new participant joins a `waiting` room.

```json
{
  "type": "participant_joined",
  "participantToken": "7c3a9d...",
  "nickname": "Azure Sloth"
}
```

---

### `room_activated`

Broadcast to all existing participants (not the new joiner) when the room transitions
from `waiting` to `active` (i.e., when the 2nd connected participant joins).

```json
{
  "type": "room_activated",
  "participants": [
    { "participantToken": "9b4e7f2a...", "nickname": "Teal Fox" },
    { "participantToken": "7c3a9d...", "nickname": "Azure Sloth" }
  ]
}
```

The new joiner receives a `joined` message with `room.state: "active"` instead.

---

### `room_deactivated`

Broadcast when the room drops below 2 connected participants (returns to `waiting`).

```json
{ "type": "room_deactivated" }
```

---

### `participant_left`

Broadcast when a participant leaves voluntarily or is removed after the grace period expires.

```json
{
  "type": "participant_left",
  "participantToken": "7c3a9d..."
}
```

---

### `participant_disconnected`

Broadcast immediately when a participant's heartbeat times out (grace period begins).
The participant is still in the room but `isConnected: false`.

```json
{
  "type": "participant_disconnected",
  "participantToken": "7c3a9d..."
}
```

---

### `participant_reconnected`

Broadcast when a disconnected participant successfully rejoins within the grace period.

```json
{
  "type": "participant_reconnected",
  "participantToken": "7c3a9d..."
}
```

---

### `proposal_updated`

Broadcast to all room participants when any participant submits or updates a proposal.

```json
{
  "type": "proposal_updated",
  "participantToken": "7c3a9d...",
  "epochMs": 1711209600000
}
```

---

### `locked_in`

Broadcast to all room participants when lock-in quorum is reached. This is the
terminal state — the room accepts no further proposals.

```json
{
  "type": "locked_in",
  "epochMs": 1711209600000
}
```

`epochMs` is the **truncated-to-minute** epoch (floor to 60,000ms).

---

### `room_expired`

Broadcast to all connected participants when the room is deleted due to 2 hours of
inactivity, or when the server shuts down gracefully. Close your connection after
receiving this.

```json
{ "type": "room_expired" }
```

---

### `error`

Sent when the server rejects a client action.

```json
{
  "type": "error",
  "code": "ROOM_NOT_FOUND",
  "message": "Room not found"
}
```

#### Error Codes

| Code | Meaning |
|------|---------|
| `ROOM_NOT_FOUND` | Room does not exist, has expired, or is locked in |
| `ROOM_NOT_ACTIVE` | `propose` sent when room is not in `active` state |
| `ROOM_FULL` | Room has reached the 50-participant limit |
| `RATE_LIMITED` | Too many failed join attempts from this IP (exponential backoff) |
| `INVALID_PROPOSAL` | `epochMs` is out of the valid range |
| `REJOIN_FAILED` | Grace period has expired, room code mismatch, or no active grace entry |
| `INVALID_TOKEN` | Malformed message, unknown message type, or incompatible protocol version |

---

## Heartbeat Timeline

The server uses native WebSocket ping/pong for liveness detection.

```
T+0s    Client connects
T+20s   Server sends native ping
T+30s   No pong received:
          → participant.isConnected = false
          → broadcast: participant_disconnected
          → grace period starts (30s window to rejoin)
T+60s   Grace period expires:
          → participant removed from room
          → broadcast: participant_left
```

**Reconnect window: T+30s to T+60s (30 seconds).**

Clients do not need to send explicit pongs — the WebSocket library handles pong responses
automatically. Do not close and reopen connections speculatively; wait for
`participant_disconnected` before attempting `rejoin`.

---

## Room State Machine

```
waiting ──(2nd participant joins)──► active ──(quorum reached)──► locked_in
  ▲                                     │
  └────────(drops below 2 connected)────┘
```

- `waiting`: 1 connected participant. Proposals not accepted.
- `active`: 2+ connected participants. Proposals accepted.
- `locked_in`: Terminal. All participants have agreed on a minute. No transitions out.

---

## Quorum Rules (Lock-In)

Lock-in requires:
1. Room is in `active` state.
2. At least **2** participants have submitted proposals.
3. All participants who are **connected AND have a proposal** agree (same minute, after
   truncating to 60,000ms).

Excluded from quorum (do not block lock-in, do not contribute to it):
- Disconnected participants (heartbeat timed out, in grace period)
- Connected participants who have not yet submitted a proposal

---

## Example Flows

### Happy Path

```
# Alice connects
C→S: {"type":"join","roomCode":"purple-falcon-bridge"}
S→C: {"type":"joined","sessionToken":"a3f8...","nickname":"Teal Fox","room":{"state":"waiting",...}}

# Bob connects
C→S: {"type":"join","roomCode":"purple-falcon-bridge"}
S→Alice: {"type":"room_activated","participants":[...]}
S→Bob:   {"type":"joined","nickname":"Azure Sloth","room":{"state":"active",...}}

# Alice proposes
C(Alice)→S: {"type":"propose","epochMs":1711209600000}
S→Alice: {"type":"proposal_updated","participantToken":"...","epochMs":1711209600000}
S→Bob:   {"type":"proposal_updated","participantToken":"...","epochMs":1711209600000}

# Bob proposes same minute (+30s)
C(Bob)→S: {"type":"propose","epochMs":1711209630000}
S→Alice: {"type":"proposal_updated",...}
S→Bob:   {"type":"proposal_updated",...}
S→Alice: {"type":"locked_in","epochMs":1711209600000}
S→Bob:   {"type":"locked_in","epochMs":1711209600000}
```

### Reconnect Within Grace

```
# Alice disconnects (heartbeat timeout)
S→Bob: {"type":"participant_disconnected","participantToken":"alice-token"}

# Alice reconnects within 30s
C(Alice-new)→S: {"type":"rejoin","roomCode":"purple-falcon-bridge","sessionToken":"a3f8..."}
S→Alice-new: {"type":"joined",...,"room":{...snapshot with existing proposals...}}
S→Bob:       {"type":"participant_reconnected","participantToken":"alice-token"}
```

### Locked-In Room

```
# Carol tries to join after lock-in
C→S: {"type":"join","roomCode":"purple-falcon-bridge"}
S→C: {"type":"error","code":"ROOM_NOT_FOUND","message":"Room not found"}
```

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/models/messages.js';

const host = process.env.E2E_HOST ?? 'localhost:3000';
const isLocal = host.startsWith('localhost') || host.startsWith('127.');
const wsBase = `${isLocal ? 'ws' : 'wss'}://${host}/ws`;
const httpBase = `${isLocal ? 'http' : 'https'}://${host}`;

// Generate a random 4-letter lowercase word
function word(): string {
  return Array.from({ length: 4 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
}

// Unique three-word room code per call — matches /^[a-z]+-[a-z]+-[a-z]+$/
function roomCode(): string {
  return `${word()}-${word()}-${word()}`;
}

const openSockets: WebSocket[] = [];

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase);
    openSockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as ServerMessage));
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5_000): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: expected ${count} messages, got ${messages.length}`)),
      timeoutMs,
    );
    function onMessage(data: WebSocket.RawData) {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(messages);
      }
    }
    ws.on('message', onMessage);
  });
}

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
});

describe('HTTP health checks', () => {
  it('GET /health returns 200 ok', async () => {
    const res = await fetch(`${httpBase}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /ready returns 200 ok', async () => {
    const res = await fetch(`${httpBase}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('happy path', () => {
  it('single participant joins — waiting state, valid session token', async () => {
    const alice = await connect();
    const code = roomCode();

    send(alice, { type: 'join', roomCode: code });
    const msg = await nextMessage(alice);

    expect(msg.type).toBe('joined');
    if (msg.type !== 'joined') return;
    expect(msg.room.state).toBe('waiting');
    expect(msg.nickname).toBeTruthy();
    expect(msg.sessionToken).toMatch(/^[0-9a-f]{32}$/);
    expect(msg.protocolVersion).toBe('1.0');
  });

  it('two participants join — room activates', async () => {
    const alice = await connect();
    const bob = await connect();
    const code = roomCode();

    send(alice, { type: 'join', roomCode: code });
    await nextMessage(alice); // joined (waiting)

    const aliceActivatedPromise = nextMessage(alice);
    send(bob, { type: 'join', roomCode: code });

    const [aliceActivated, bobJoined] = await Promise.all([
      aliceActivatedPromise,
      nextMessage(bob),
    ]);

    expect(aliceActivated.type).toBe('room_activated');
    expect(bobJoined.type).toBe('joined');
    if (bobJoined.type === 'joined') {
      expect(bobJoined.room.state).toBe('active');
    }
  });

  it('two participants propose same minute — room locks in', async () => {
    const alice = await connect();
    const bob = await connect();
    const code = roomCode();

    send(alice, { type: 'join', roomCode: code });
    await nextMessage(alice);

    const aliceActivated$ = nextMessage(alice);
    send(bob, { type: 'join', roomCode: code });
    await Promise.all([aliceActivated$, nextMessage(bob)]);

    const epoch1 = 1_711_209_600_000;
    const epoch2 = 1_711_209_630_000; // same minute, 30s later

    const aliceProposal$ = nextMessage(alice);
    const bobProposal$ = nextMessage(bob);
    send(alice, { type: 'propose', epochMs: epoch1 });
    await Promise.all([aliceProposal$, bobProposal$]);

    const aliceMsgs$ = collectMessages(alice, 2);
    const bobMsgs$ = collectMessages(bob, 2);
    send(bob, { type: 'propose', epochMs: epoch2 });

    const [aliceMsgs, bobMsgs] = await Promise.all([aliceMsgs$, bobMsgs$]);

    expect(aliceMsgs.some(m => m.type === 'locked_in')).toBe(true);
    expect(bobMsgs.some(m => m.type === 'locked_in')).toBe(true);

    const locked = aliceMsgs.find(m => m.type === 'locked_in');
    if (locked?.type === 'locked_in') {
      expect(locked.epochMs % 60_000).toBe(0); // truncated to minute
    }
  });

  it('proposals in different minutes — no lock-in', async () => {
    const alice = await connect();
    const bob = await connect();
    const code = roomCode();

    send(alice, { type: 'join', roomCode: code });
    await nextMessage(alice);

    const aliceActivated$ = nextMessage(alice);
    send(bob, { type: 'join', roomCode: code });
    await Promise.all([aliceActivated$, nextMessage(bob)]);

    const epoch1 = 1_711_209_600_000;
    const epoch2 = epoch1 + 60_000; // different minute

    const aliceProposal$ = nextMessage(alice);
    const bobProposal$ = nextMessage(bob);
    send(alice, { type: 'propose', epochMs: epoch1 });
    await Promise.all([aliceProposal$, bobProposal$]);

    const aliceUpdate$ = nextMessage(alice);
    const bobUpdate$ = nextMessage(bob);
    send(bob, { type: 'propose', epochMs: epoch2 });
    const [aliceUpdate, bobUpdate] = await Promise.all([aliceUpdate$, bobUpdate$]);

    expect(aliceUpdate.type).toBe('proposal_updated');
    expect(bobUpdate.type).toBe('proposal_updated');
  });

  it('join locked-in room returns ROOM_NOT_FOUND', async () => {
    const alice = await connect();
    const bob = await connect();
    const code = roomCode();

    send(alice, { type: 'join', roomCode: code });
    await nextMessage(alice);

    const aliceActivated$ = nextMessage(alice);
    send(bob, { type: 'join', roomCode: code });
    await Promise.all([aliceActivated$, nextMessage(bob)]);

    const epoch = 1_711_209_600_000;
    const aliceProposal$ = nextMessage(alice);
    const bobProposal$ = nextMessage(bob);
    send(alice, { type: 'propose', epochMs: epoch });
    await Promise.all([aliceProposal$, bobProposal$]);

    const aliceLocked$ = collectMessages(alice, 2);
    const bobLocked$ = collectMessages(bob, 2);
    send(bob, { type: 'propose', epochMs: epoch });
    await Promise.all([aliceLocked$, bobLocked$]);

    const carol = await connect();
    send(carol, { type: 'join', roomCode: code });
    const errMsg = await nextMessage(carol);

    expect(errMsg.type).toBe('error');
    if (errMsg.type === 'error') {
      expect(errMsg.code).toBe('ROOM_NOT_FOUND');
    }
  });
});

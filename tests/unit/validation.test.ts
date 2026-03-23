import { describe, it, expect } from 'vitest';
import { parseClientMessage } from '../../src/utils/validation.js';

describe('parseClientMessage', () => {
  describe('join messages', () => {
    it('accepts a valid room code (three hyphen-separated lowercase words)', () => {
      const result = parseClientMessage(JSON.stringify({ type: 'join', roomCode: 'swift-bold-fox' }));
      expect(result.type).toBe('join');
    });

    it('rejects room code with numbers', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'join', roomCode: 'swift-b0ld-fox' }))).toThrow();
    });

    it('rejects room code with only two parts', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'join', roomCode: 'swift-fox' }))).toThrow();
    });

    it('rejects room code with uppercase', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'join', roomCode: 'Swift-bold-fox' }))).toThrow();
    });

    it('rejects room code with four parts', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'join', roomCode: 'a-b-c-d' }))).toThrow();
    });
  });

  describe('rejoin messages', () => {
    it('accepts valid rejoin with 32-char hex session token', () => {
      const token = 'a'.repeat(32);
      const result = parseClientMessage(JSON.stringify({ type: 'rejoin', roomCode: 'a-b-c', sessionToken: token }));
      expect(result.type).toBe('rejoin');
    });

    it('rejects session token that is not 32 hex chars', () => {
      expect(() =>
        parseClientMessage(JSON.stringify({ type: 'rejoin', roomCode: 'a-b-c', sessionToken: 'tooshort' }))
      ).toThrow();
    });

    it('rejects session token with non-hex characters', () => {
      const token = 'z'.repeat(32); // z is not hex
      expect(() =>
        parseClientMessage(JSON.stringify({ type: 'rejoin', roomCode: 'a-b-c', sessionToken: token }))
      ).toThrow();
    });
  });

  describe('propose messages', () => {
    it('accepts a valid epoch within bounds', () => {
      const result = parseClientMessage(JSON.stringify({ type: 'propose', epochMs: 1_700_000_000_000 }));
      expect(result.type).toBe('propose');
    });

    it('accepts epoch at minimum (0)', () => {
      const result = parseClientMessage(JSON.stringify({ type: 'propose', epochMs: 0 }));
      expect(result.type).toBe('propose');
    });

    it('accepts epoch at maximum (9_999_999_999_999)', () => {
      const result = parseClientMessage(JSON.stringify({ type: 'propose', epochMs: 9_999_999_999_999 }));
      expect(result.type).toBe('propose');
    });

    it('rejects epoch below minimum', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'propose', epochMs: -1 }))).toThrow();
    });

    it('rejects epoch above maximum', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'propose', epochMs: 10_000_000_000_000 }))).toThrow();
    });

    it('rejects non-integer epoch', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'propose', epochMs: 1.5 }))).toThrow();
    });
  });

  describe('leave messages', () => {
    it('accepts a valid leave message', () => {
      const result = parseClientMessage(JSON.stringify({ type: 'leave' }));
      expect(result.type).toBe('leave');
    });
  });

  describe('invalid messages', () => {
    it('throws on invalid JSON', () => {
      expect(() => parseClientMessage('not json')).toThrow('Invalid JSON');
    });

    it('throws on unknown message type', () => {
      expect(() => parseClientMessage(JSON.stringify({ type: 'unknown' }))).toThrow();
    });

    it('throws on missing type field', () => {
      expect(() => parseClientMessage(JSON.stringify({ roomCode: 'a-b-c' }))).toThrow();
    });
  });
});

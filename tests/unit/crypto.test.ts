import { describe, it, expect } from 'vitest';
import { generateToken, generateParticipantToken } from '../../src/utils/crypto.js';

describe('crypto utils', () => {
  describe('generateToken', () => {
    it('returns a 32-character hex string', () => {
      const token = generateToken();
      expect(token).toHaveLength(32);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates 1000 unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        tokens.add(generateToken());
      }
      expect(tokens.size).toBe(1000);
    });
  });

  describe('generateParticipantToken', () => {
    it('returns a 32-character hex string', () => {
      const token = generateParticipantToken();
      expect(token).toHaveLength(32);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates 1000 unique participant tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        tokens.add(generateParticipantToken());
      }
      expect(tokens.size).toBe(1000);
    });
  });
});

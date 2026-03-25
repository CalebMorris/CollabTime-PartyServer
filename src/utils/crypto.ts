import { randomBytes } from 'node:crypto';

export function generateToken(): string {
  return randomBytes(16).toString('hex');
}

export function generateParticipantToken(): string {
  return randomBytes(16).toString('hex');
}

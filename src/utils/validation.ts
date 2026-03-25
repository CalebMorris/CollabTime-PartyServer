import { z } from 'zod';
import { ROOM_CODE_PATTERN, SESSION_TOKEN_PATTERN, EPOCH_MIN_MS, EPOCH_MAX_MS } from '../config/constants.js';

const joinSchema = z.object({
  type: z.literal('join'),
  roomCode: z.string().regex(ROOM_CODE_PATTERN),
  protocolVersion: z.string().optional(),
});

const rejoinSchema = z.object({
  type: z.literal('rejoin'),
  roomCode: z.string().regex(ROOM_CODE_PATTERN),
  sessionToken: z.string().regex(SESSION_TOKEN_PATTERN),
  protocolVersion: z.string().optional(),
});

const proposeSchema = z.object({
  type: z.literal('propose'),
  epochMs: z.number().int().min(EPOCH_MIN_MS).max(EPOCH_MAX_MS),
});

const leaveSchema = z.object({
  type: z.literal('leave'),
});

const clientMessageSchema = z.discriminatedUnion('type', [
  joinSchema,
  rejoinSchema,
  proposeSchema,
  leaveSchema,
]);

export type ParsedClientMessage = z.infer<typeof clientMessageSchema>;

export function parseClientMessage(raw: string): ParsedClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON');
  }
  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid message: ${result.error.message}`);
  }
  return result.data;
}

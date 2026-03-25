export const ErrorCode = {
  ROOM_NOT_FOUND:               'ROOM_NOT_FOUND',
  ROOM_NOT_ACTIVE:              'ROOM_NOT_ACTIVE',
  ROOM_FULL:                    'ROOM_FULL',
  RATE_LIMITED:                 'RATE_LIMITED',
  INVALID_PROPOSAL:             'INVALID_PROPOSAL',
  REJOIN_FAILED:                'REJOIN_FAILED',
  INVALID_TOKEN:                'INVALID_TOKEN',
  PROTOCOL_VERSION_MISMATCH:    'PROTOCOL_VERSION_MISMATCH',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ProtocolError';
  }
}

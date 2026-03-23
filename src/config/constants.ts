export const ROOM_CODE_PATTERN = /^[a-z]+-[a-z]+-[a-z]+$/;
export const SESSION_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
export const PARTICIPANT_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
export const MAX_PARTICIPANTS = 50;
export const EPOCH_MIN_MS = 0;
export const EPOCH_MAX_MS = 9_999_999_999_999; // year ~2286
export const PROTOCOL_VERSION = '1.0';

/** Returns true if clientVersion is compatible (same major) or omitted. */
export function isCompatibleVersion(clientVersion: string | undefined): boolean {
  if (!clientVersion) return true;
  const clientMajor = clientVersion.split('.')[0];
  const serverMajor = PROTOCOL_VERSION.split('.')[0];
  return clientMajor === serverMajor;
}

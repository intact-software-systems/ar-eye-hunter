export { AuthSessionRepository } from '../auth/persistence/auth-session-repository.ts';
export {
  decodePersistedAgentSessionTicket,
  decodePersistedAuthSession,
  decodePersistedWebSocketTicket,
  type PersistedAgentSessionTicket,
  type PersistedAuthSession,
  type PersistedWebSocketTicket,
} from '../auth/persistence/auth-persistence-contracts.ts';
export {
  AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS,
  AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT,
} from '../auth/persistence/auth-legacy-compatibility.ts';
export { hashAuthSecret } from '../auth/credentials/hash-auth-secret.ts';
export type {
  IssuedAgentSessionTicket,
  IssuedAuthSession,
  IssuedWebSocketTicket,
} from '../auth/persistence/auth-session-types.ts';

import type { StateScope } from '@shared/api/state-types.ts';
import type { IssuedAuthSession } from '../repositories/auth-session-types.ts';
import type { PersistedAuthSession } from '../repositories/auth-persistence-contracts.ts';
import type {
  ClientMutationIssuedSessionAuthority,
  ClientMutationOperation,
  ClientMutationSystemAuthority,
} from './client-state-mutations.ts';

export function toClientMutationIssuedSessionAuthority(
  session: IssuedAuthSession | PersistedAuthSession,
  scope: StateScope,
  operation: Exclude<ClientMutationOperation, 'expireSession'>,
): ClientMutationIssuedSessionAuthority {
  return {
    kind: 'issued-session',
    version: 1,
    principalId: session.clientId,
    sessionId: session.sessionId,
    sessionIssuedAtEpochMs: session.issuedAtEpochMs,
    sessionExpiresAtEpochMs: session.expiresAtEpochMs,
    applicationId: scope.applicationId,
    workspaceId: scope.workspaceId,
    operation,
  };
}

export function toClientMutationSystemAuthority(
  serviceId: string,
): ClientMutationSystemAuthority {
  return {
    kind: 'system',
    version: 1,
    serviceId,
    operation: 'expireSession',
  };
}

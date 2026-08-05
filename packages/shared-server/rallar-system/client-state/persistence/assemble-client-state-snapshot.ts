import { validateAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toClientSnapshotLastSeenAtEpochMs } from '@shared/api/group-client-views.ts';
import type {
  ClientInstance,
  ClientPrincipal,
  ClientSession,
  ClientSnapshot,
} from '@shared/api/client-types.ts';

import { isLogicallyActiveSession } from '../../repositories/session-expiry.ts';
import {
  compareClientStateInstanceStorageKeys,
  compareClientStateSessionStorageKeys,
  clientStatePrincipalStorageKey,
} from './client-state-storage-keys.ts';

export type ClientStateSnapshotAssemblyInput = Readonly<{
  principal: ClientPrincipal;
  instances: readonly ClientInstance[];
  activeSessions: readonly ClientSession[];
  stateRevision: number;
}>;

export function toActiveClientSessions(
  sessions: readonly ClientSession[],
): readonly ClientSession[] {
  return sessions.filter(
    (session) =>
      session.status === 'active' &&
      session.disconnectedAtEpochMs === null &&
      isLogicallyActiveSession(session.expiresAtEpochMs),
  );
}

export function assembleClientStateSnapshot(
  input: ClientStateSnapshotAssemblyInput,
  invariantError: (storageKey: string, message: string) => Error,
): ClientSnapshot {
  const snapshot: ClientSnapshot = {
    stateRevision: input.stateRevision,
    principal: input.principal,
    instances: [...input.instances].sort(compareClientStateInstanceStorageKeys),
    activeSessions: [...input.activeSessions].sort(compareClientStateSessionStorageKeys),
    isOnline: input.activeSessions.length > 0,
    activeSessionCount: input.activeSessions.length,
    lastSeenAtEpochMs: toClientSnapshotLastSeenAtEpochMs(
      input.principal.lastSeenAtEpochMs,
      input.activeSessions,
    ),
  };
  try {
    validateAuthoritativeClientSnapshot(snapshot, input.principal);
    return snapshot;
  } catch (error) {
    throw invariantError(
      clientStatePrincipalStorageKey(input.principal),
      error instanceof Error ? error.message : 'Stored client-state value is invalid',
    );
  }
}

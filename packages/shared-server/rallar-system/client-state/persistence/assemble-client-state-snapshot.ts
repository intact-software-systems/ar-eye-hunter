import { validateAuthoritativeClientSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { ClientInstance, ClientPrincipal, ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import { toClientSnapshotLastSeenAtEpochMs } from '@shared/api/group-client-views.ts';

import { isLogicallyActiveSession } from '../../repositories/session-expiry.ts';
import { ClientStateRepositoryInvariantCorruptionError } from './client-state-persistence-contracts.ts';
import {
    clientStatePrincipalStorageKey,
    compareClientStateInstanceStorageKeys,
    compareClientStateSessionStorageKeys
} from './client-state-storage-keys.ts';

export type ClientStateSnapshotAssemblyInput = Readonly<{
    principal: ClientPrincipal;
    instances: readonly ClientInstance[];
    activeSessions: readonly ClientSession[];
    stateRevision: number;
}>;

export function toActiveClientSessions(
    sessions: readonly ClientSession[]
): readonly ClientSession[] {
    return sessions.filter(
        (session) =>
            session.status === 'active' &&
            session.disconnectedAtEpochMs === null &&
            isLogicallyActiveSession(session.expiresAtEpochMs)
    );
}

export function assembleClientStateSnapshot(
    input: ClientStateSnapshotAssemblyInput
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
            input.activeSessions
        )
    };
    try {
        validateAuthoritativeClientSnapshot(snapshot, input.principal);
        return snapshot;
    }
    catch (error) {
        throw new ClientStateRepositoryInvariantCorruptionError(
            clientStatePrincipalStorageKey(input.principal),
            error instanceof Error ? error.message : 'Stored client-state value is invalid'
        );
    }
}

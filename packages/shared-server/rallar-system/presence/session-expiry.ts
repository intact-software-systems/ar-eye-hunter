import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { ClientSession } from '@shared/api/client-types.ts';

export const STATE_SESSION_PURGE_GRACE_MSECS = 24 * 60 * 60 * 1000;

export type ClientSessionExpiryCandidate = Readonly<{
    applicationId: string;
    workspaceId: string;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    generationId: string;
    generationVersion: number;
    observedExpiresAtEpochMs: number;
}>;

export function toClientSessionExpiryCandidate(
    session: ClientSession
): ClientSessionExpiryCandidate {
    return {
        applicationId: session.applicationId,
        workspaceId: session.workspaceId,
        principalId: session.principalId,
        clientInstanceId: session.clientInstanceId,
        sessionId: session.sessionId,
        generationId: session.generationId,
        generationVersion: session.generationVersion,
        observedExpiresAtEpochMs: session.expiresAtEpochMs
    };
}

export function toSessionPurgeAfterEpochMs(
    expiresAtEpochMs: number,
    disconnectedAtEpochMs?: number | null
): number {
    const logicalExpiry = Math.max(expiresAtEpochMs, disconnectedAtEpochMs ?? 0);

    if (
        logicalExpiry >=
            NEVER_EXPIRE_AT_TIMESTAMP - STATE_SESSION_PURGE_GRACE_MSECS
    ) {
        return NEVER_EXPIRE_AT_TIMESTAMP;
    }

    return logicalExpiry + STATE_SESSION_PURGE_GRACE_MSECS;
}

/** A session that ended keeps its row for at most the retention after it ended, never longer than it otherwise would. */
export function toClientSessionPurgeAfterEpochMs(
    session: Pick<ClientSession, 'expiresAtEpochMs' | 'disconnectedAtEpochMs'>,
    disconnectedRetentionMs: number
): number {
    const purgeAfterEpochMs = toSessionPurgeAfterEpochMs(session.expiresAtEpochMs, session.disconnectedAtEpochMs);
    return session.disconnectedAtEpochMs === null
        ? purgeAfterEpochMs
        : Math.min(purgeAfterEpochMs, session.disconnectedAtEpochMs + disconnectedRetentionMs);
}

export function isLogicallyActiveSession(
    expiresAtEpochMs: number,
    timestamp: number = Date.now()
): boolean {
    return expiresAtEpochMs > timestamp;
}

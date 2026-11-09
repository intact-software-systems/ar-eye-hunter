import type { ClientPrincipal, ClientPrincipalRef, ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import { isClientSnapshotSessionLive } from '../presence/snapshot-presence.ts';

export interface PrincipalSessionReader {
    readonly readClientSnapshot: (ref: ClientPrincipalRef) => Promise<ClientSnapshot | undefined>;
    readonly nowEpochMs: () => number;
}

/** The principal's own session rows in its scope: every stored one, and those still live recipients. */
export interface PrincipalSessionIds {
    readonly sessionIds: readonly string[];
    readonly liveSessionIds: readonly string[];
}

/**
 * Durable own-account sessions only: group memberships never extend this audience. It reads the client snapshot, which
 * shows open sessions only, so it cannot tell a closed own session from a stranger's; `readPrincipalSessions` reads the
 * stored rows for the dequeue's re-check, which must.
 */
export async function readPrincipalSessionIds(
    ref: ClientPrincipalRef,
    reader: PrincipalSessionReader
): Promise<readonly string[] | undefined> {
    const snapshot = await reader.readClientSnapshot(ref);
    if (
        !snapshot || snapshot.principal.status !== 'active' ||
        snapshot.principal.applicationId !== ref.applicationId || snapshot.principal.workspaceId !== ref.workspaceId ||
        snapshot.principal.principalId !== ref.principalId
    ) {
        return undefined;
    }
    const now = reader.nowEpochMs();
    return snapshot.activeSessions.filter((session) =>
        session.applicationId === ref.applicationId && session.workspaceId === ref.workspaceId &&
        session.principalId === ref.principalId && isClientSnapshotSessionLive(session, now)
    ).map((session) => session.sessionId);
}

export interface PrincipalSessionRowsReader {
    readonly findPrincipal: (ref: ClientPrincipalRef) => Promise<ClientPrincipal | undefined>;
    /**
     * Every stored session row of the principal, closed ones included, until the purge at
     * `min(max(expiresAt, disconnectedAt) + 24 h, disconnectedAt + disconnectedRetentionMs)`; a closed own session
     * purged by then reads as nobody's and is kept, the harmless direction.
     */
    readonly listSessionsForPrincipal: (ref: ClientPrincipalRef) => Promise<readonly ClientSession[]>;
    readonly nowEpochMs: () => number;
}

/**
 * The principal's stored session rows, and the live ones while the principal is active; `undefined` when no principal
 * row exists in the scope. It reads the rows, not the snapshot `readPrincipalSessionIds` reads, so a closed own session
 * is judged dead instead of being taken for a co-member's.
 */
export async function readPrincipalSessions(
    ref: ClientPrincipalRef,
    reader: PrincipalSessionRowsReader
): Promise<PrincipalSessionIds | undefined> {
    const [principal, rows] = await Promise.all([reader.findPrincipal(ref), reader.listSessionsForPrincipal(ref)]);
    if (
        !principal || principal.applicationId !== ref.applicationId || principal.workspaceId !== ref.workspaceId ||
        principal.principalId !== ref.principalId
    ) {
        return undefined;
    }
    const sessions = rows.filter((session) =>
        session.applicationId === ref.applicationId && session.workspaceId === ref.workspaceId &&
        session.principalId === ref.principalId
    );
    const now = reader.nowEpochMs();
    return {
        sessionIds: sessions.map((session) => session.sessionId),
        liveSessionIds: principal.status === 'active'
            ? sessions.filter((session) => isClientSnapshotSessionLive(session, now)).map((session) =>
                session.sessionId
            )
            : []
    };
}

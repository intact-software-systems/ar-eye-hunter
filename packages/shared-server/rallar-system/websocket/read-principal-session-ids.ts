import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { isClientSnapshotSessionLive } from '../presence/snapshot-presence.ts';

export interface PrincipalSessionReader {
    readonly readClientSnapshot: (ref: ClientPrincipalRef) => Promise<ClientSnapshot | undefined>;
    readonly nowEpochMs: () => number;
}

/** The principal's own session rows in its scope: every one it knows, and those still live. */
export interface PrincipalSessionIds {
    readonly sessionIds: readonly string[];
    readonly liveSessionIds: readonly string[];
}

/** Durable own-account sessions only: group memberships never extend this audience. */
export async function readPrincipalSessionIds(
    ref: ClientPrincipalRef,
    reader: PrincipalSessionReader
): Promise<readonly string[] | undefined> {
    return (await readPrincipalSessions(ref, reader))?.liveSessionIds;
}

/** One durable read of the principal's session rows; `undefined` when the principal is not active in the scope. */
export async function readPrincipalSessions(
    ref: ClientPrincipalRef,
    reader: PrincipalSessionReader
): Promise<PrincipalSessionIds | undefined> {
    const snapshot = await reader.readClientSnapshot(ref);
    if (
        !snapshot || snapshot.principal.status !== 'active' ||
        snapshot.principal.applicationId !== ref.applicationId || snapshot.principal.workspaceId !== ref.workspaceId ||
        snapshot.principal.principalId !== ref.principalId
    ) {
        return undefined;
    }
    const now = reader.nowEpochMs();
    const sessions = snapshot.activeSessions.filter((session) =>
        session.applicationId === ref.applicationId && session.workspaceId === ref.workspaceId &&
        session.principalId === ref.principalId
    );
    return {
        sessionIds: sessions.map((session) => session.sessionId),
        liveSessionIds: sessions.filter((session) => isClientSnapshotSessionLive(session, now)).map((session) =>
            session.sessionId
        )
    };
}

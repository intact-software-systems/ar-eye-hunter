import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { isClientSnapshotSessionLive } from '../presence/snapshot-presence.ts';

export interface PrincipalSessionReader {
    readonly readClientSnapshot: (ref: ClientPrincipalRef) => Promise<ClientSnapshot | undefined>;
    readonly nowEpochMs: () => number;
}

/** Durable own-account sessions only: group memberships never extend this audience. */
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

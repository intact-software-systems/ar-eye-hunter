import type { ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';

export type RallarSnapshotPresenceClock = () => number;

export function isClientSnapshotSessionLive(
    session: Pick<ClientSession, 'status' | 'expiresAtEpochMs'>,
    atEpochMs: number
): boolean {
    return session.status === 'active' && session.expiresAtEpochMs > atEpochMs;
}

export function isGroupSnapshotSessionLive(
    session: Pick<GroupPresenceSession, 'status' | 'expiresAtEpochMs'>,
    atEpochMs: number
): boolean {
    return session.status === 'active' && session.expiresAtEpochMs > atEpochMs;
}

export function isClientSnapshotPresenceFresh(snapshot: ClientSnapshot, atEpochMs: number): boolean {
    return snapshot.activeSessions.every((session) => isClientSnapshotSessionLive(session, atEpochMs));
}

export function isGroupSnapshotPresenceFresh(snapshot: GroupSnapshot, atEpochMs: number): boolean {
    return snapshot.activeSessions.every((session) => isGroupSnapshotSessionLive(session, atEpochMs));
}

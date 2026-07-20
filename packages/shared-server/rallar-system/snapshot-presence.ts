import type { ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import type {
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';

export type RallarSnapshotPresenceClock = () => number;

export function isClientSnapshotSessionLive(
    session: ClientSession,
    atEpochMs: number = Date.now(),
): boolean {
    return session.status === 'active' &&
        session.disconnectedAtEpochMs === null &&
        session.expiresAtEpochMs > atEpochMs;
}

export function isGroupSnapshotSessionLive(
    session: GroupPresenceSession,
    atEpochMs: number = Date.now(),
): boolean {
    return session.disconnectedAtEpochMs === null &&
        session.expiresAtEpochMs > atEpochMs;
}

export function isClientSnapshotPresenceFresh(
    snapshot: ClientSnapshot,
    atEpochMs: number = Date.now(),
): boolean {
    return snapshot.activeSessions.every((session) =>
        isClientSnapshotSessionLive(session, atEpochMs)
    );
}

export function isGroupSnapshotPresenceFresh(
    snapshot: GroupSnapshot,
    atEpochMs: number = Date.now(),
): boolean {
    return snapshot.activeSessions.every((session) =>
        isGroupSnapshotSessionLive(session, atEpochMs)
    );
}

export function isSessionInLiveGroupSnapshot(
    snapshot: GroupSnapshot,
    sessionId: string,
    atEpochMs: number = Date.now(),
): boolean {
    return snapshot.activeSessions.some((session) =>
        session.sessionId === sessionId &&
        isGroupSnapshotSessionLive(session, atEpochMs)
    );
}

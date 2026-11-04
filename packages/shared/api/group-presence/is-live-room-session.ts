import type { GroupPresenceSession } from '../group-types.ts';

/** A session the roster still lists as active whose lease has not lapsed by `nowMs`. */
export function isLiveRoomSession(session: GroupPresenceSession, nowMs: number): boolean {
    return session.status === 'active' && session.expiresAtEpochMs > nowMs;
}

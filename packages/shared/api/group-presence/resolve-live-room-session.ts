import type { GroupPresenceSession, GroupSnapshot } from '../group-types.ts';
import { isLiveRoomSession } from './is-live-room-session.ts';

/** The session the roster names live at `nowMs`; `undefined` for one it does not list, a disconnected one, or a lapsed lease. */
export function resolveLiveRoomSession(
    snapshot: GroupSnapshot,
    sessionId: string,
    nowMs: number
): GroupPresenceSession | undefined {
    const session = snapshot.activeSessions.find((candidate) => candidate.sessionId === sessionId);
    return session !== undefined && isLiveRoomSession(session, nowMs) ? session : undefined;
}

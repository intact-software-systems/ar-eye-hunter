import type { GroupPresencePublicationKey, GroupSnapshot } from '../group-types.ts';
import { isLiveRoomSession } from './is-live-room-session.ts';

/** `null` when the session registered no key, or is not live at `nowMs`: a lapsed lease attests no key. */
export function resolvePublicationKey(
    snapshot: GroupSnapshot,
    sessionId: string,
    nowMs: number
): GroupPresencePublicationKey | null {
    const session = snapshot.activeSessions.find((candidate) => candidate.sessionId === sessionId);
    return session !== undefined && isLiveRoomSession(session, nowMs) ? session.publicationKey : null;
}

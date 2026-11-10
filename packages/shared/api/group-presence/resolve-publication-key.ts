import type { GroupPresencePublicationKey, GroupSnapshot } from '../group-types.ts';
import { resolveLiveRoomSession } from './resolve-live-room-session.ts';

/** `null` when the session registered no key, or is not live at `nowMs`: a lapsed lease attests no key. */
export function resolvePublicationKey(
    snapshot: GroupSnapshot,
    sessionId: string,
    nowMs: number
): GroupPresencePublicationKey | null {
    return resolveLiveRoomSession(snapshot, sessionId, nowMs)?.publicationKey ?? null;
}

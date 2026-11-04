import { isLiveRoomSession } from '../../api/group-presence/is-live-room-session.ts';
import { resolveGroupPublicationPermissions } from '../../api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';

/** The live sessions of the room whose principal holds effective `subscribe` on `topicId`: a granted send's audience. */
export function computeGrantedSubscribeHolders(
    snapshot: GroupSnapshot,
    topicId: string,
    nowEpochMs: number
): ReadonlySet<string> {
    return new Set(
        snapshot.activeSessions
            .filter((session) =>
                isLiveRoomSession(session, nowEpochMs) &&
                resolveGroupPublicationPermissions(snapshot, session.principalId, topicId).subscribe
            )
            .map((session) => session.sessionId)
    );
}

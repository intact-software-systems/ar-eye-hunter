import {
    isALAudienceSession,
    toALAudienceNarrowing,
    toALLeaderNarrowing
} from '@shared/al-contracts/al-audience-narrowing.ts';
import type { ALMessage, ALTargets } from '@shared/al-contracts/al-contract.ts';
import { readGroupVersion } from '@shared/api/group-client-views.ts';
import { resolveRallarGroupLeaderSessionId } from '@shared/api/group-director.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { isGroupSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import type { RallarServerWsRoomAudience } from '../router/rallar-server-ws-router-contracts.ts';

/** What a room message's authorized audience reads of it: whom it names, and the receipt it asks for. */
export interface AuthorizedRoomAudienceMessage {
    readonly targets: ALTargets;
    readonly delivery?: ALMessage['delivery'];
}

export function toAuthorizedRoomAudience(
    snapshot: GroupSnapshot,
    message: AuthorizedRoomAudienceMessage,
    nowEpochMs: number
): RallarServerWsRoomAudience {
    const { targets } = message;
    const narrowing = toALAudienceNarrowing(targets);
    const leader = toALLeaderNarrowing(message, resolveRallarGroupLeaderSessionId(snapshot));
    const activePrincipals = new Set(
        snapshot.members.filter((member) => member.status === 'active').map((member) => member.principalId)
    );
    return {
        targets,
        sessions: snapshot.activeSessions.filter((session) =>
            activePrincipals.has(session.principalId) && isGroupSnapshotSessionLive(session, nowEpochMs) &&
            isALAudienceSession(session, narrowing) && isALAudienceSession(session, leader)
        ),
        snapshotVersion: readGroupVersion(snapshot)
    };
}

import type { GroupRef } from '@shared/api/group-types.ts';

import type { TopologyChurnApi, TopologyChurnSession } from '../topology-churn-api.mts';
import { resolveTopologyChurnLeaderCandidate } from './resolve-topology-churn-leader-candidate.ts';

export namespace AppointTopologyChurnLeader {
    export interface Input {
        readonly api: TopologyChurnApi;
        readonly roomRef: GroupRef;
        readonly creator: TopologyChurnSession;
        readonly present: readonly TopologyChurnSession[];
        readonly leaderSessionId: string | null;
        readonly candidate: 'creator' | 'deepest';
    }
}

/**
 * Appoints the creator, or the present member the accepted layout is deepest from: an admin may appoint itself while
 * the owner is online, so the creator first makes that member an admin. Answers null when there is no candidate.
 */
export async function appointTopologyChurnLeader(
    input: AppointTopologyChurnLeader.Input
): Promise<TopologyChurnSession | null> {
    const appointee = input.candidate === 'creator' ? input.creator : await readDeepestPresentSession(input);
    if (appointee === null) {
        return null;
    }
    if (appointee.clientId !== input.creator.clientId) {
        await input.api.writeMemberRole({
            owner: input.creator,
            roomRef: input.roomRef,
            principalId: appointee.clientId,
            role: 'admin'
        });
    }
    await input.api.writeDirectorAppointment(appointee, input.roomRef);
    return appointee;
}

/** Only present sessions are eligible, so a session the accepted layout still holds after it left is passed over. */
async function readDeepestPresentSession(
    input: AppointTopologyChurnLeader.Input
): Promise<TopologyChurnSession | null> {
    const layout = await input.api.readAcceptedLayout(input.creator, input.roomRef);
    const presentSessionIds = new Set(input.present.map((session) => session.sessionId));
    const candidateSessionId = resolveTopologyChurnLeaderCandidate({
        layout: {
            activeSessionIds: layout.activeSessionIds.filter((sessionId) => presentSessionIds.has(sessionId)),
            nextHopsBySessionId: layout.nextHopsBySessionId
        },
        leaderSessionId: input.leaderSessionId
    });
    return input.present.find((session) => session.sessionId === candidateSessionId) ?? null;
}

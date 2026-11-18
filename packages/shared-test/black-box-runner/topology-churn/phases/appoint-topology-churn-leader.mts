import type { GroupRef } from '@shared/api/group-types.ts';

import type { TopologyChurnApi, TopologyChurnSession } from '../topology-churn-api.mts';
import type { TopologyChurnAction } from './compute-topology-churn-phase-schedule.ts';
import { resolveTopologyChurnLeaderCandidate } from './resolve-topology-churn-leader-candidate.ts';

interface AppointTopologyChurnLeaderInput {
    readonly api: TopologyChurnApi;
    readonly roomRef: GroupRef;
    readonly creator: TopologyChurnSession;
    readonly present: readonly TopologyChurnSession[];
    readonly leaderSessionId: string | null;
    readonly candidate: Extract<TopologyChurnAction, { kind: 'appoint'; }>['candidate'];
}

/**
 * Appoints the creator, or the present member the accepted layout is deepest from: an admin may appoint itself while
 * the owner is online, so the creator first makes that member an admin. Answers null when there is no candidate.
 */
export async function appointTopologyChurnLeader(
    input: AppointTopologyChurnLeaderInput
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

async function readDeepestPresentSession(
    input: AppointTopologyChurnLeaderInput
): Promise<TopologyChurnSession | null> {
    const candidateSessionId = resolveTopologyChurnLeaderCandidate({
        layout: await input.api.readAcceptedLayout(input.creator, input.roomRef),
        presentSessionIds: input.present.map((session) => session.sessionId),
        leaderSessionId: input.leaderSessionId
    });
    return input.present.find((session) => session.sessionId === candidateSessionId) ?? null;
}

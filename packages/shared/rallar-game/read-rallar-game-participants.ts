import { readActiveGroupSessionRole } from '../api/group-spectating.ts';
import type { GroupSnapshot } from '../api/group-types.ts';
import type { RallarGameParticipant } from './rematch.ts';

/** Transport reconnects preserve consent; a changed membership requires fresh consent. */
export function readRallarGameParticipants(
    snapshot: GroupSnapshot | undefined,
    nowEpochMs: number
): readonly RallarGameParticipant[] {
    if (!snapshot) {
        return [];
    }
    return snapshot.activeSessions.flatMap((session) => {
        const role = readActiveGroupSessionRole(snapshot, session.sessionId, nowEpochMs);
        const member = snapshot.members.find((candidate) => candidate.principalId === session.principalId);
        if (!member || role === undefined || role === 'spectator') {
            return [];
        }
        return [{
            sessionId: session.sessionId,
            participationKey: JSON.stringify([
                member.applicationId,
                member.workspaceId,
                member.groupId,
                member.principalId,
                member.role,
                member.updated.atEpochMs,
                member.updated.requestId,
                member.updated.traceId
            ])
        }];
    });
}

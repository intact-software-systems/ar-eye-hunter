import type {
    GroupMember,
    GroupMemberStatus,
    GroupPresenceSession,
} from '../api/group-types.ts';
import type {
    RallarMatchParticipant,
    RallarMatchParticipantsInput,
} from './types.ts';
import { compareRallarMatchOrdinalStrings } from './internal.ts';

export function deriveRallarMatchParticipants(
    input: RallarMatchParticipantsInput,
): readonly RallarMatchParticipant[] {
    if (input.members) {
        return Array.from(input.members).sort(compareParticipants);
    }

    const snapshot = input.snapshot;
    if (!snapshot) {
        return [];
    }

    const sessionsByPrincipal = groupSessionsByPrincipal(snapshot.activeSessions);
    const includeInactive = input.includeInactiveMembers === true;

    return snapshot.members
        .filter((member) => includeInactive || member.status === 'active')
        .map((member) => {
            const sessionIds = sessionsByPrincipal.get(member.principalId) ?? [];
            const identity = {
                principalId: member.principalId,
                role: member.role,
                status: member.status,
                sessionIds,
            };

            return {
                participantId: input.resolveParticipantId
                    ? input.resolveParticipantId(identity)
                    : member.principalId,
                principalId: member.principalId,
                role: member.role,
                status: member.status,
                online: sessionIds.length > 0,
                sessionIds,
            } satisfies RallarMatchParticipant;
        })
        .sort(compareParticipants);
}

function groupSessionsByPrincipal(
    sessions: readonly Pick<GroupPresenceSession, 'principalId' | 'sessionId'>[],
): ReadonlyMap<string, readonly string[]> {
    const grouped = new Map<string, string[]>();
    for (const session of sessions) {
        const values = grouped.get(session.principalId) ?? [];
        values.push(session.sessionId);
        grouped.set(session.principalId, values);
    }

    for (const [principalId, sessionIds] of grouped.entries()) {
        grouped.set(principalId, sessionIds.sort(compareRallarMatchOrdinalStrings));
    }

    return grouped;
}

function compareParticipants(
    left: Pick<RallarMatchParticipant, 'participantId'>,
    right: Pick<RallarMatchParticipant, 'participantId'>,
): number {
    return compareRallarMatchOrdinalStrings(
        left.participantId,
        right.participantId,
    );
}

export function isActiveGroupMemberStatus(status: GroupMemberStatus): boolean {
    return status === 'active';
}

export type RallarMatchParticipantMemberInput =
    Pick<GroupMember, 'principalId' | 'role' | 'status'>;

import type { AdminSupportFact } from '@shared/api/admin-support/admin-support-types.ts';
import { toGroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import { computeGroupAdmissionDecision } from '@shared/api/group-lifecycle/compute-group-admission-decision.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { readGroupRetentionState } from '@shared/api/group-retention.ts';
import { readGroupSessionSchedule, toGroupSessionTiming } from '@shared/api/group-sessions/group-session-schedule.ts';
import { countGroupPlayers, isGroupSpectator, readGroupSpectatorCapacity } from '@shared/api/group-spectating.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { isLiveGroupPresenceSession } from '../../group-state/policy/group-policy-primitives.ts';

interface GroupRoomFactsInput {
    readonly snapshot: GroupSnapshot;
    readonly policy: GroupLifecyclePolicy | null;
    readonly nowEpochMs: number;
}

/** Projects only platform-owned facts; app metadata and game participation are not support evidence. */
export function toGroupRoomFacts(input: GroupRoomFactsInput): readonly AdminSupportFact[] {
    return [
        ...toGroupMembershipFacts(input.snapshot, input.nowEpochMs),
        ...toGroupAccessFacts(input.snapshot, input.nowEpochMs),
        toLifecycleAdmissionFact(input),
        { label: 'group.gameplayParticipation', source: 'application', value: 'unknown', certainty: 'unavailable' },
        {
            label: 'group.sessionReservations',
            source: 'group-session-reservations',
            value: 'unknown',
            certainty: 'unavailable'
        }
    ];
}

function toGroupMembershipFacts(snapshot: GroupSnapshot, nowEpochMs: number): readonly AdminSupportFact[] {
    const liveSessions = snapshot.activeSessions.filter((session) => isLiveGroupPresenceSession(session, nowEpochMs));
    const sessionCounts = new Map<string, number>();
    for (const session of liveSessions) {
        sessionCounts.set(session.principalId, (sessionCounts.get(session.principalId) ?? 0) + 1);
    }
    const members = snapshot.members.map((member) => ({
        principalId: member.principalId,
        status: member.status,
        role: member.role,
        presence: sessionCounts.has(member.principalId) ? 'present' : 'away',
        liveSessionCount: sessionCounts.get(member.principalId) ?? 0
    }));
    return [
        { label: 'group.status', source: 'group-state', value: snapshot.group.status, certainty: 'exact' },
        { label: 'group.memberCount', source: 'group-state', value: snapshot.memberCount, certainty: 'exact' },
        { label: 'group.onlineMemberCount', source: 'group-state', value: sessionCounts.size, certainty: 'exact' },
        { label: 'group.activeSessionCount', source: 'group-state', value: liveSessions.length, certainty: 'exact' },
        { label: 'group.members', source: 'group-state', value: members, certainty: 'exact' },
        {
            label: 'group.playerMemberCount',
            source: 'group-state',
            value: countGroupPlayers(snapshot),
            certainty: 'exact'
        },
        {
            label: 'group.spectatorMemberCount',
            source: 'group-state',
            value: snapshot.members.filter(isGroupSpectator).length,
            certainty: 'exact'
        }
    ];
}

function toGroupAccessFacts(snapshot: GroupSnapshot, nowEpochMs: number): readonly AdminSupportFact[] {
    const group = snapshot.group;
    const retention = readGroupRetentionState(group.metadata);
    const schedule = readGroupSessionSchedule(group.metadata);
    return [
        {
            label: 'group.admission',
            source: 'group-state',
            certainty: 'exact',
            value: {
                joinMode: group.joinMode,
                directoryListing: toGroupDirectoryListing(group.metadata),
                storedMaxPlayers: group.maxMembers,
                maxSessionsPerMember: group.maxSessionsPerMember,
                spectatorCapacity: readGroupSpectatorCapacity(group.metadata)
            }
        },
        {
            label: 'group.retention',
            source: 'group-state',
            certainty: 'exact',
            value: {
                mode: retention?.mode ?? 'persistent',
                reconnectGraceMs: retention?.reconnectGraceMs ?? null,
                emptySinceEpochMs: group.emptySinceEpochMs,
                purgeAfterEpochMs: group.purgeAfterEpochMs,
                expiresAtEpochMs: group.expiresAtEpochMs
            }
        },
        {
            label: 'group.schedule',
            source: 'group-state',
            certainty: 'exact',
            value: schedule === null ? null : { ...toGroupSessionTiming(schedule, nowEpochMs) }
        }
    ];
}

function toLifecycleAdmissionFact(input: GroupRoomFactsInput): AdminSupportFact {
    const decision = input.policy === null ? null : computeGroupAdmissionDecision({
        admission: input.policy.admission,
        lifecycleState: input.snapshot.group.lifecycleState,
        activeMemberCount: countGroupPlayers(input.snapshot),
        invited: false,
        nowEpochMs: input.nowEpochMs
    });
    return {
        label: 'group.lifecycleAdmissionForUninvitedPlayer',
        source: 'group-lifecycle-policy',
        certainty: decision === null ? 'unavailable' : 'exact',
        value: decision === null ? 'unknown' : {
            outcome: decision.kind,
            reason: decision.kind === 'deny' ? decision.denial.message : null
        }
    };
}

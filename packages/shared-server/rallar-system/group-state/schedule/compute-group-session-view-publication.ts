import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { Group, GroupMember } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead,
    GroupSessionReservationWrite
} from '../mutation/group-mutation-contracts.ts';

export interface GroupSessionViewChange {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly group: Group;
    readonly members: readonly GroupMember[];
    readonly reservations: GroupSessionReservationWrite | null;
}

export function readsGroupSessionViewAudience(command: GroupMutationCommand): boolean {
    return command.operation !== 'connectPresence' && command.operation !== 'heartbeatPresence' &&
        command.operation !== 'disconnectPresence' && command.operation !== 'subscribeGroupTopic' &&
        command.operation !== 'unsubscribeGroupTopic';
}

/** Redacted private hints preserve the before audience when a reservation, intent, or membership disappears. */
export function computeGroupSessionViewPublication(input: GroupSessionViewChange): ViewInvalidationPublication {
    const { command, read, facts, group, members, reservations } = input;
    const before = read.group?.value;
    const oldSchedule = before === undefined ? null : readGroupSessionSchedule(before.metadata);
    const schedule = readGroupSessionSchedule(group.metadata);
    const changed = !jsonEquals(oldSchedule, schedule) || before?.status !== group.status ||
        before?.displayName !== group.displayName || before?.maxMembers !== group.maxMembers ||
        before?.ownerPrincipalId !== group.ownerPrincipalId || before?.joinMode !== group.joinMode ||
        members.length > 0 || reservations !== null;
    if ((oldSchedule === null && schedule === null) || !changed) {
        return { outbox: [], provenance: [] };
    }
    if (before !== undefined && oldSchedule !== null && read.sessionViewAudience === null) {
        throw new TypeError('Changed scheduled previews require their captured account audience');
    }
    return computeViewInvalidationPublication({
        resource: 'sessions',
        scope: { applicationId: group.applicationId, workspaceId: group.workspaceId },
        principalIds: [
            ...(read.sessionViewAudience?.principalIds ?? []),
            group.ownerPrincipalId,
            ...(before ? [before.ownerPrincipalId] : []),
            ...(read.sessionReservations?.value.principalIds ?? []),
            ...(reservations?.value.principalIds ?? []),
            ...members.map((member) => member.principalId)
        ],
        changeId: computeSha256CanonicalJson({
            ref: command.aggregateRef,
            commandId: command.commandId,
            revision: group.snapshotVersion
        }),
        createdAtEpochMs: facts.nowEpochMs,
        retentionMs: facts.expireAtEpochMs - facts.nowEpochMs,
        serviceId: facts.serviceId,
        traceId: facts.traceId
    });
}

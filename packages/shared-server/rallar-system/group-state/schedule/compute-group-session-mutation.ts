import {
    readGroupSessionSchedule,
    toGroupSessionTiming,
    type GroupSessionSchedule
} from '@shared/api/group-sessions/group-session-schedule.ts';
import { isGroupSpectator } from '@shared/api/group-spectating.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { GROUP_SESSION_INTENTS_NAMESPACE, groupSessionIntentKey } from './group-session-intent-storage.ts';

import { toPolicySnapshot } from '../mutation/aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../mutation/group-mutation-contracts.ts';
import {
    auditStamp,
    computeGroupMutationWriteResult,
    noOp,
    rejected,
    rejectedByGroupPolicy,
    requireGroup
} from '../mutation/group-mutation-result.ts';
import { canMutateActiveGroup } from '../policy/group-lifecycle-policy.ts';
import { canUseGroupAdmissionCredentials } from '../policy/group-membership-admission-policy.ts';
import { computeGroupSessionReservation } from './group-session-reservations.ts';

interface GroupSessionMutation {
    readonly command: Extract<GroupMutationCommand, { operation: 'changeGroupSession'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly stored: NonNullable<GroupMutationRead['group']>;
    readonly schedule: GroupSessionSchedule;
    readonly reservations: NonNullable<GroupMutationRead['sessionReservations']>;
    readonly activeMembers: NonNullable<GroupMutationRead['activeMembers']>;
    readonly principalId: string;
}

interface GroupSessionChanges {
    readonly schedule: GroupSessionSchedule;
    readonly reservations: NonNullable<GroupMutationRead['sessionReservations']>['value'];
    readonly intentEffect: RuntimeStateGuardedBatchEffect | null;
    readonly editsSchedule: boolean;
}

/** Schedule edits and account intent share the same group CAS as admission and retirement. */
export function computeGroupSessionMutation(
    command: Extract<GroupMutationCommand, { operation: 'changeGroupSession'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const active = canMutateActiveGroup({ group: stored.value, nowEpochMs: facts.attemptAtEpochMs });
    if (!active.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: active });
    }
    const schedule = readGroupSessionSchedule(stored.value.metadata);
    const rejection = schedule === null
        ? 'This room is not scheduled.'
        : command.input.actorPrincipalId === null
        ? 'An authenticated account is required.'
        : command.input.expectedScheduleRevision !== schedule.revision
        ? 'The schedule has changed. Review it again.'
        : null;
    if (rejection !== null) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message: rejection });
    }
    if (
        schedule === null || command.input.actorPrincipalId === null || read.sessionReservations === null ||
        read.activeMembers === null
    ) {
        throw new TypeError('Session changes require complete schedule, actor, reservation and member reads');
    }
    const mutation: GroupSessionMutation = {
        command,
        read,
        facts,
        stored,
        schedule,
        principalId: command.input.actorPrincipalId,
        reservations: read.sessionReservations,
        activeMembers: read.activeMembers
    };
    return command.input.action === 'reschedule' || command.input.action === 'cancel'
        ? computeOrganizerScheduleChange(mutation)
        : computeAccountReservationChange(mutation);
}

function computeOrganizerScheduleChange(mutation: GroupSessionMutation): GroupMutationComputed {
    const { command, read, facts, stored, schedule, principalId } = mutation;
    const timing = toGroupSessionTiming(schedule, facts.attemptAtEpochMs);
    const action = command.input.action;
    const rejection = stored.value.ownerPrincipalId !== principalId || read.actorMember?.status !== 'active'
        ? 'Only the current organizer may change the schedule.'
        : timing.phase !== 'upcoming'
        ? 'The schedule cannot change after the lobby opens.'
        : action === 'reschedule' &&
                (command.input.startsAtEpochMs === null ||
                    command.input.startsAtEpochMs <= facts.attemptAtEpochMs + 600_000)
        ? 'The rescheduled lobby must open in the future.'
        : null;
    if (rejection !== null) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message: rejection });
    }
    const nextSchedule = {
        revision: schedule.revision + 1,
        startsAtEpochMs: command.input.startsAtEpochMs ?? schedule.startsAtEpochMs,
        cancelledAtEpochMs: action === 'cancel' ? facts.attemptAtEpochMs : null
    };
    return computeSessionWrite(mutation, {
        schedule: nextSchedule,
        reservations: { ...command.aggregateRef, scheduleRevision: nextSchedule.revision, principalIds: [] },
        intentEffect: null,
        editsSchedule: true
    });
}

function computeAccountReservationChange(mutation: GroupSessionMutation): GroupMutationComputed {
    const { command, read, facts, stored, schedule, reservations, principalId } = mutation;
    const action = command.input.action;
    if (action !== 'reserve' && action !== 'withdraw') {
        throw new TypeError('Account reservation change requires reserve or withdraw');
    }
    if (action === 'reserve') {
        const credentials = canUseGroupAdmissionCredentials({
            snapshot: toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs),
            actor: { principalId, sessionId: command.input.actorSessionId ?? undefined },
            nowEpochMs: facts.attemptAtEpochMs
        });
        if (!credentials.allowed) {
            return rejectedByGroupPolicy({ command, read, facts, denial: credentials });
        }
    }
    if (stored.value.maxMembers === null) {
        throw new TypeError('Scheduled rooms require explicit capacity');
    }
    const result = computeGroupSessionReservation({
        schedule,
        reservations: reservations.value,
        activePlayerPrincipalIds: mutation.activeMembers.filter((member) => !isGroupSpectator(member)).map((member) =>
            member.principalId
        ),
        nowEpochMs: facts.attemptAtEpochMs,
        action,
        principalId,
        expectedScheduleRevision: command.input.expectedScheduleRevision,
        maxPlayers: stored.value.maxMembers
    });
    if (result.outcome === 'denied') {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Reservation refused: ${result.reason}.`
        });
    }
    const nextReservations = { ...command.aggregateRef, ...result.reservations };
    const intentEffect = computeSessionInterestEffect(mutation);
    return intentEffect === null && jsonEquals(nextReservations, reservations.value)
        ? noOp(command, read, facts)
        : computeSessionWrite(mutation, {
            schedule,
            reservations: nextReservations,
            intentEffect,
            editsSchedule: false
        });
}

function computeSessionInterestEffect(mutation: GroupSessionMutation): RuntimeStateGuardedBatchEffect | null {
    const { command, read, principalId, schedule } = mutation;
    const intent = read.sessionIntent;
    const key = groupSessionIntentKey(command.aggregateRef, principalId);
    if (command.input.action === 'withdraw' && intent !== null && read.actorMember?.status !== 'active') {
        return {
            effectId: 'session-interest',
            operation: 'delete',
            namespace: GROUP_SESSION_INTENTS_NAMESPACE,
            key,
            expectedRevision: intent.entry.revision
        };
    }
    if (command.input.action !== 'reserve' || intent?.value.reviewedScheduleRevision === schedule.revision) {
        return null;
    }
    const common = {
        effectId: 'session-interest',
        namespace: GROUP_SESSION_INTENTS_NAMESPACE,
        key,
        value: JSON.stringify({ ...command.aggregateRef, principalId, reviewedScheduleRevision: schedule.revision }),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
    return intent === null
        ? { ...common, operation: 'insert' }
        : { ...common, operation: 'update', expectedRevision: intent.entry.revision };
}

function computeSessionWrite(mutation: GroupSessionMutation, changes: GroupSessionChanges): GroupMutationComputed {
    const { command, read, facts, stored, principalId } = mutation;
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            expectedRevision: stored.entry.revision,
            value: {
                ...stored.value,
                metadata: { ...stored.value.metadata, rallarSessionSchedule: { ...changes.schedule } },
                snapshotVersion: stored.value.snapshotVersion + 1,
                metadataVersion: stored.value.metadataVersion + (changes.editsSchedule ? 1 : 0),
                updated: changes.editsSchedule ? auditStamp(command, facts, principalId) : stored.value.updated
            }
        },
        ...(changes.intentEffect === null ? {} : { sessionIntentEffect: changes.intentEffect }),
        sessionReservationWrite: {
            value: changes.reservations,
            expectedRevision: mutation.reservations.entry.revision
        },
        members: [],
        initialPresenceSummary: null,
        eventType: 'group-updated',
        lifecyclePolicy: null,
        publicationGrantEffects: [],
        presenceSummaryWork: 'enqueue'
    });
}

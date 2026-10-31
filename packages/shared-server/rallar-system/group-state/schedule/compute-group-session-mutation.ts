import { readGroupSessionSchedule, toGroupSessionTiming } from '@shared/api/group-sessions/group-session-schedule.ts';
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
    const reservations = read.sessionReservations;
    if (schedule === null) {
        return deny('This room is not scheduled.');
    }
    if (reservations === null || read.activeMembers === null) {
        throw new TypeError('Session changes require reservation and member reads');
    }
    const principalId = command.input.actorPrincipalId;
    if (principalId === null) {
        return deny('An authenticated account is required.');
    }
    if (command.input.expectedScheduleRevision !== schedule.revision) {
        return deny('The schedule has changed. Review it again.');
    }
    const timing = toGroupSessionTiming(schedule, facts.attemptAtEpochMs);
    const { action } = command.input;
    const editsSchedule = action === 'reschedule' || action === 'cancel';
    let sessionIntentEffect: RuntimeStateGuardedBatchEffect | null = null;
    let nextSchedule = schedule;
    let nextReservations = reservations.value;
    if (editsSchedule) {
        if (stored.value.ownerPrincipalId !== principalId || read.actorMember?.status !== 'active') {
            return deny('Only the current organizer may change the schedule.');
        }
        if (timing.phase !== 'upcoming') {
            return deny('The schedule cannot change after the lobby opens.');
        }
        if (
            action === 'reschedule' &&
            (command.input.startsAtEpochMs === null ||
                command.input.startsAtEpochMs <= facts.attemptAtEpochMs + 600_000)
        ) {
            return deny('The rescheduled lobby must open in the future.');
        }
        nextSchedule = {
            revision: schedule.revision + 1,
            startsAtEpochMs: command.input.startsAtEpochMs ?? schedule.startsAtEpochMs,
            cancelledAtEpochMs: action === 'cancel' ? facts.attemptAtEpochMs : null
        };
        nextReservations = { ...command.aggregateRef, scheduleRevision: nextSchedule.revision, principalIds: [] };
    }
    else {
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
            activePlayerPrincipalIds: read.activeMembers.filter((member) => !isGroupSpectator(member)).map((member) =>
                member.principalId
            ),
            nowEpochMs: facts.attemptAtEpochMs,
            action,
            principalId,
            expectedScheduleRevision: command.input.expectedScheduleRevision,
            maxPlayers: stored.value.maxMembers
        });
        if (result.outcome === 'denied') {
            return deny(`Reservation refused: ${result.reason}.`);
        }
        nextReservations = { ...command.aggregateRef, ...result.reservations };
        const intent = read.sessionIntent;
        const key = groupSessionIntentKey(command.aggregateRef, principalId);
        if (action === 'withdraw' && intent !== null && read.actorMember?.status !== 'active') {
            sessionIntentEffect = {
                effectId: 'session-interest',
                operation: 'delete',
                namespace: GROUP_SESSION_INTENTS_NAMESPACE,
                key,
                expectedRevision: intent.entry.revision
            };
        }
        else if (action === 'reserve' && intent?.value.reviewedScheduleRevision !== schedule.revision) {
            const value = JSON.stringify({
                ...command.aggregateRef,
                principalId,
                reviewedScheduleRevision: schedule.revision
            });
            const common = {
                effectId: 'session-interest',
                namespace: GROUP_SESSION_INTENTS_NAMESPACE,
                key,
                value,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            };
            sessionIntentEffect = intent === null
                ? { ...common, operation: 'insert' }
                : { ...common, operation: 'update', expectedRevision: intent.entry.revision };
        }
        if (sessionIntentEffect === null && jsonEquals(nextReservations, reservations.value)) {
            return noOp(command, read, facts);
        }
    }
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
                metadata: { ...stored.value.metadata, rallarSessionSchedule: { ...nextSchedule } },
                snapshotVersion: stored.value.snapshotVersion + 1,
                metadataVersion: stored.value.metadataVersion + (editsSchedule ? 1 : 0),
                updated: editsSchedule ? auditStamp(command, facts, principalId) : stored.value.updated
            }
        },
        ...(sessionIntentEffect === null ? {} : { sessionIntentEffect }),
        sessionReservationWrite: { value: nextReservations, expectedRevision: reservations.entry.revision },
        members: [],
        initialPresenceSummary: null,
        eventType: 'group-updated',
        lifecyclePolicy: null,
        publicationGrantEffects: [],
        presenceSummaryWork: 'enqueue'
    });

    function deny(message: string): GroupMutationComputed {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message });
    }
}

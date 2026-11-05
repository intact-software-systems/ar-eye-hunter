import {
    requireEpoch,
    requireExactKeys,
    requirePositiveInteger,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { readGroupSessionSchedule, toGroupSessionTiming } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { Group, GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeAppOutboxSignal } from '../../app-outbox/compute-app-outbox-signal.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export namespace GroupSessionDeadline {
    export interface Identity {
        readonly ref: GroupRef;
        readonly groupCreatedAtEpochMs: number;
        readonly dueAtEpochMs: number;
    }
    export interface Phase extends Identity {
        readonly kind: 'lobby' | 'start' | 'reservations-expire';
        readonly scheduleRevision: number;
        readonly startsAtEpochMs: number;
    }
    export interface Invitation extends Identity {
        readonly kind: 'invitation-expire';
        readonly principalId: string;
        readonly memberFingerprint: string;
    }
}

export type GroupSessionDeadline = GroupSessionDeadline.Phase | GroupSessionDeadline.Invitation;

export const GROUP_SESSION_DEADLINE_TOPIC = 'group-session.deadline';

export interface GroupSessionDeadlinesInput {
    readonly before: Group | null;
    readonly changedMembers: readonly GroupMember[];
    readonly previousMembers: readonly GroupMember[];
    readonly after: Group;
    readonly createdAtEpochMs: number;
    readonly retentionMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}

export function decodeGroupSessionDeadline(value: unknown): GroupSessionDeadline {
    const row = requireRecord(value, 'Session deadline');
    const identity = decodeDeadlineIdentity(row);
    if (row.kind === 'invitation-expire') {
        requireExactKeys(row, [
            'ref',
            'groupCreatedAtEpochMs',
            'dueAtEpochMs',
            'kind',
            'principalId',
            'memberFingerprint'
        ], 'Invitation deadline');
        requireString(row.principalId, 'Invitation principal');
        requireString(row.memberFingerprint, 'Invitation predecessor');
        if (!/^[a-f0-9]{64}$/.test(row.memberFingerprint)) {
            throw new TypeError('Invitation predecessor digest is invalid');
        }
        return { ...identity, kind: row.kind, principalId: row.principalId, memberFingerprint: row.memberFingerprint };
    }
    requireExactKeys(row, [
        'ref',
        'groupCreatedAtEpochMs',
        'scheduleRevision',
        'startsAtEpochMs',
        'kind',
        'dueAtEpochMs'
    ], 'Session deadline');
    requirePositiveInteger(row.scheduleRevision, 'Deadline schedule revision');
    requireEpoch(row.startsAtEpochMs, 'Deadline start');
    if (row.kind !== 'lobby' && row.kind !== 'start' && row.kind !== 'reservations-expire') {
        throw new TypeError('Session deadline kind is invalid');
    }
    const timing = toGroupSessionTiming({
        revision: Number(row.scheduleRevision),
        startsAtEpochMs: row.startsAtEpochMs,
        cancelledAtEpochMs: null
    }, 0);
    const due = row.kind === 'lobby'
        ? timing.lobbyOpensAtEpochMs
        : row.kind === 'start'
        ? timing.startsAtEpochMs
        : timing.reservationsExpireAtEpochMs;
    if (identity.dueAtEpochMs !== due) {
        throw new TypeError('Session deadline differs from its canonical phase boundary');
    }
    return {
        ...identity,
        scheduleRevision: Number(row.scheduleRevision),
        startsAtEpochMs: row.startsAtEpochMs,
        kind: row.kind
    };
}

function decodeDeadlineIdentity(value: unknown): GroupSessionDeadline.Identity {
    const row = requireRecord(value, 'Session deadline identity');
    const ref = requireRecord(row.ref, 'Session deadline reference');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Session deadline reference');
    requireString(ref.applicationId, 'Deadline application');
    requireString(ref.workspaceId, 'Deadline workspace');
    requireString(ref.groupId, 'Deadline group');
    requireEpoch(row.groupCreatedAtEpochMs, 'Deadline creation');
    requireEpoch(row.dueAtEpochMs, 'Deadline time');
    return {
        ref: { applicationId: ref.applicationId, workspaceId: ref.workspaceId, groupId: ref.groupId },
        groupCreatedAtEpochMs: row.groupCreatedAtEpochMs,
        dueAtEpochMs: row.dueAtEpochMs
    };
}

/** Schedule changes persist future phase wakes with the same group CAS and receipt. */
export function computeGroupSessionDeadlines(input: GroupSessionDeadlinesInput): readonly AppOutboxInsert[] {
    const schedule = readGroupSessionSchedule(input.after.metadata);
    if (schedule === null || schedule.cancelledAtEpochMs !== null || input.after.status !== 'active') {
        return [];
    }
    return [...computePhaseDeadlines(input), ...computeInvitationDeadlines(input)].map((deadline) =>
        toGroupSessionDeadlineSignal(input, deadline)
    );
}

function computePhaseDeadlines(input: GroupSessionDeadlinesInput): readonly GroupSessionDeadline.Phase[] {
    const schedule = readGroupSessionSchedule(input.after.metadata)!;
    const previous = input.before === null ? null : readGroupSessionSchedule(input.before.metadata);
    if (previous?.revision === schedule.revision && previous.startsAtEpochMs === schedule.startsAtEpochMs) {
        return [];
    }
    const { applicationId, workspaceId, groupId } = input.after;
    const timing = toGroupSessionTiming(schedule, input.createdAtEpochMs);
    const boundaries: readonly Pick<GroupSessionDeadline.Phase, 'kind' | 'dueAtEpochMs'>[] = [
        { kind: 'lobby', dueAtEpochMs: timing.lobbyOpensAtEpochMs },
        { kind: 'start', dueAtEpochMs: timing.startsAtEpochMs },
        { kind: 'reservations-expire', dueAtEpochMs: timing.reservationsExpireAtEpochMs }
    ];
    return boundaries.filter(({ dueAtEpochMs }) => dueAtEpochMs > input.createdAtEpochMs).map((boundary) => ({
        ref: { applicationId, workspaceId, groupId },
        groupCreatedAtEpochMs: input.after.created.atEpochMs,
        scheduleRevision: schedule.revision,
        startsAtEpochMs: schedule.startsAtEpochMs,
        ...boundary
    }));
}

function computeInvitationDeadlines(input: GroupSessionDeadlinesInput): readonly GroupSessionDeadline.Invitation[] {
    const deadlines: GroupSessionDeadline.Invitation[] = [];
    for (const member of input.changedMembers) {
        if (
            member.status !== 'invited' || member.invitationExpiresAtEpochMs === null ||
            member.invitationExpiresAtEpochMs <= input.createdAtEpochMs ||
            input.previousMembers.some((previous) => jsonEquals(previous, member))
        ) {
            continue;
        }
        deadlines.push({
            ref: { applicationId: member.applicationId, workspaceId: member.workspaceId, groupId: member.groupId },
            groupCreatedAtEpochMs: input.after.created.atEpochMs,
            kind: 'invitation-expire',
            principalId: member.principalId,
            memberFingerprint: computeSha256CanonicalJson(member),
            dueAtEpochMs: member.invitationExpiresAtEpochMs
        });
    }
    return deadlines;
}

function toGroupSessionDeadlineSignal(
    input: GroupSessionDeadlinesInput,
    deadline: GroupSessionDeadline
): AppOutboxInsert {
    const route = toGroupSessionDeadlineRoute(deadline);
    return computeAppOutboxSignal({
        ...route,
        typeId: AppOutboxType.GROUP_SESSION_DEADLINE,
        resource: JSON.stringify(deadline),
        createdAtEpochMs: input.createdAtEpochMs,
        dueAtEpochMs: deadline.dueAtEpochMs,
        expiresAtEpochMs: deadline.dueAtEpochMs + input.retentionMs,
        serviceId: input.serviceId,
        traceId: input.traceId
    });
}

export function toGroupSessionDeadlineRoute(deadline: GroupSessionDeadline): Key {
    return toAppQueueKey({
        topicId: GROUP_SESSION_DEADLINE_TOPIC,
        resourceId: computeSha256CanonicalJson(deadline),
        contextId: groupStateGroupStorageKey(deadline.ref)
    });
}

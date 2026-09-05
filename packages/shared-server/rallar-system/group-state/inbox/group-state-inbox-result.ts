import type { GroupEvent, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';

import { validateComputedProjection } from '../../computed-data-validation.ts';
import type { ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import type { GroupStateMutationCommand } from '../group-state-service-contracts.ts';
import type { GroupJoinCodeWritten, GroupStateWritten } from '../group-state-service-contracts.ts';
import type {
    GroupMutationComputed,
    GroupMutationRead,
    GroupMutationReceipt
} from '../mutation/group-mutation-contracts.ts';
import { assembleGroupStateSnapshot } from '../persistence/assemble-group-state-snapshot.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '../persistence/group-state-persistence-contracts.ts';
import { groupStateMemberStorageKey } from '../persistence/membership/group-membership-storage-key.ts';
import type { InactiveGroupPresenceResult } from '../presence/group-presence-service.ts';

export type GroupPresenceInboxDurableResult = GroupMutationReceipt | InactiveGroupPresenceResult;

export type GroupStateInboxDurableResult = GroupPresenceInboxDurableResult | GroupJoinCodeWritten | GroupStateWritten;

export interface ComputeGroupStateInboxResultInput {
    readonly command: GroupStateMutationCommand;
    readonly read: GroupMutationRead;
    readonly computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict' | 'rejected'; }>;
    readonly currentSnapshot: GroupSnapshot | undefined;
    readonly recordedEvent: GroupEvent | undefined;
}

export interface GroupStateInboxResultReadConflict {
    readonly kind: 'read-conflict';
    readonly message: string;
}

export type GroupStateInboxResultComputed =
    | Readonly<{
        kind: 'presence';
        durableResult: GroupMutationReceipt;
    }>
    | Readonly<{
        kind: 'group';
        snapshot: GroupSnapshot;
        event: GroupEvent | null;
        durableResult: GroupStateWritten | GroupJoinCodeWritten;
    }>;

export type GroupStateInboxResultComputation = Either<GroupStateInboxResultReadConflict, GroupStateInboxResultComputed>;

const RESULT_READ_CONFLICT: GroupStateInboxResultReadConflict = {
    kind: 'read-conflict',
    message: 'Group state result snapshot no longer matches the mutation read.'
};

export function computeGroupStateInboxResult(
    input: ComputeGroupStateInboxResultInput
): GroupStateInboxResultComputation {
    if (isPresenceOperation(input.command.command.operation)) {
        return Either.ofRight({
            kind: 'presence',
            durableResult: input.computed.receipt
        });
    }
    if (hasResultReadConflict(input)) {
        return Either.ofLeft(RESULT_READ_CONFLICT);
    }
    const snapshot = input.computed.outcome === 'write'
        ? assembleCommittedSnapshot(input, input.computed)
        : input.currentSnapshot;
    if (snapshot === undefined) {
        return Either.ofLeft(RESULT_READ_CONFLICT);
    }
    const event = input.computed.outcome === 'write'
        ? input.computed.event
        : readRecordedEvent(input.recordedEvent, input.computed.receipt);
    const durableResult = input.command.command.operation === 'rotateGroupJoinCode'
        ? toJoinCodeResult(input.computed.receipt, snapshot, event)
        : toGroupMutationResult({ command: input.command, receipt: input.computed.receipt, snapshot, event });
    return Either.ofRight({ kind: 'group', snapshot, event, durableResult });
}

export function validateGroupStateInboxResult(
    input: ComputeGroupStateInboxResultInput,
    computed: GroupStateInboxResultComputation
): readonly ComputedDataValidationIssue[] {
    if (isPresenceOperation(input.command.command.operation)) {
        return computed.right === undefined
            ? validateComputedProjection(
                { kind: 'presence', durableResult: input.computed.receipt },
                computed.left,
                'computed.right'
            )
            : validateComputedProjection(
                { kind: 'presence', durableResult: input.computed.receipt },
                computed.right,
                'computed.right'
            );
    }
    if (hasResultReadConflict(input)) {
        return computed.left === undefined
            ? validateComputedProjection(RESULT_READ_CONFLICT, computed.right, 'computed.left')
            : validateComputedProjection(RESULT_READ_CONFLICT, computed.left, 'computed.left');
    }
    if (computed.right === undefined) {
        return validateComputedProjection(
            expectedComputedResultKind(input),
            computed.left,
            'computed.right'
        );
    }
    if (computed.right.kind === 'presence') {
        return validateComputedProjection({ kind: 'group' }, computed.right, 'computed.right');
    }
    const event = input.computed.outcome === 'write'
        ? input.computed.event
        : readRecordedEvent(input.recordedEvent, input.computed.receipt);
    const durableResult = input.command.command.operation === 'rotateGroupJoinCode'
        ? toJoinCodeResult(input.computed.receipt, computed.right.snapshot, event)
        : toGroupMutationResult({
            command: input.command,
            receipt: input.computed.receipt,
            snapshot: computed.right.snapshot,
            event
        });
    return validateComputedProjection(
        { kind: 'group', snapshot: computed.right.snapshot, event, durableResult },
        computed.right,
        'computed.right'
    );
}

interface ToGroupMutationResultInput {
    readonly command: GroupStateMutationCommand;
    readonly receipt: GroupMutationReceipt;
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent | null;
}

function snapshotMatchesRead(
    snapshot: GroupSnapshot | undefined,
    read: GroupMutationRead
): boolean {
    if (read.group === null) {
        return snapshot === undefined;
    }
    const presenceRevision = read.presenceSummary?.value.causalRevision.presenceRevision ?? 0;
    const expectedSnapshotGroup = {
        ...read.group.value,
        presenceVersion: presenceRevision
    };
    return snapshot !== undefined &&
        jsonEquals(snapshot.group, expectedSnapshotGroup) &&
        snapshot.causalRevision.groupRevision === read.group.value.snapshotVersion &&
        snapshot.causalRevision.presenceRevision === presenceRevision;
}

function hasResultReadConflict(input: ComputeGroupStateInboxResultInput): boolean {
    return !snapshotMatchesRead(input.currentSnapshot, input.read) ||
        input.computed.outcome !== 'write' && input.currentSnapshot === undefined;
}

function expectedComputedResultKind(
    input: ComputeGroupStateInboxResultInput
): Readonly<{ kind: GroupStateInboxResultComputed['kind']; }> {
    return { kind: isPresenceOperation(input.command.command.operation) ? 'presence' : 'group' };
}

function assembleCommittedSnapshot(
    input: ComputeGroupStateInboxResultInput,
    computed: Extract<GroupMutationComputed, { outcome: 'write'; }>
): GroupSnapshot {
    if (computed.guard.kind !== 'group') {
        throw new TypeError('Presence mutations do not assemble group snapshots.');
    }
    return assembleGroupStateSnapshot(
        {
            group: computed.guard.value,
            members: mergeMembers(input.currentSnapshot?.members ?? [], computed.members),
            summary: computed.initialPresenceSummary?.value ?? input.read.presenceSummary?.value,
            authoritativeSessions: input.currentSnapshot?.activeSessions ?? [],
            groupRevision: computed.guard.value.snapshotVersion,
            observedAtEpochMs: input.command.facts.nowEpochMs,
            sessionLeaseFields: 'authoritative'
        },
        (storageKey, message) => new GroupStateRepositoryInvariantCorruptionError(storageKey, message)
    );
}

function mergeMembers(
    current: readonly GroupMember[],
    changed: readonly GroupMember[]
): readonly GroupMember[] {
    const members = new Map(current.map((member) => [groupStateMemberStorageKey(member), member]));
    for (const member of changed) {
        members.set(groupStateMemberStorageKey(member), member);
    }
    return [...members.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, member]) => member);
}

function readRecordedEvent(
    event: GroupEvent | undefined,
    receipt: GroupMutationReceipt
): GroupEvent | null {
    if (receipt.eventId === null) {
        return null;
    }
    if (
        event === undefined ||
        event.eventId !== receipt.eventId ||
        event.snapshotVersion !== receipt.snapshotVersion ||
        event.requestId !== receipt.requestId
    ) {
        throw new TypeError(`Group mutation event not found: ${receipt.eventId}`);
    }
    return event;
}

function isPresenceOperation(
    operation: GroupStateMutationCommand['command']['operation']
): boolean {
    return (
        operation === 'connectPresence' ||
        operation === 'heartbeatPresence' ||
        operation === 'disconnectPresence'
    );
}

function toJoinCodeResult(
    receipt: GroupMutationReceipt,
    snapshot: GroupSnapshot,
    event: GroupEvent | null
): GroupJoinCodeWritten {
    if (receipt.outcome === 'rejected') {
        throw new TypeError('Rejected join-code mutation reached success result assembly');
    }
    if (receipt.joinCode === null || receipt.joinCodeExpiresAtEpochMs === null) {
        throw new TypeError('Join-code mutation result is incomplete');
    }
    return {
        status: 'ok',
        result: {
            joinCode: receipt.joinCode,
            expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
            snapshot,
            event
        }
    };
}

function toGroupMutationResult(input: ToGroupMutationResultInput): GroupStateWritten {
    const { command, event, receipt, snapshot } = input;
    if (receipt.outcome === 'rejected') {
        throw new TypeError('Rejected group mutation reached success result assembly');
    }
    return {
        status: command.command.operation === 'createGroup' ? 'created' : 'ok',
        result: { snapshot, event }
    };
}

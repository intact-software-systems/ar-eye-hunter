import type { GroupEvent, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

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

export class GroupStateInboxResultReadConflictError extends Error {
    readonly code = 'runtime-state-write-conflict';

    constructor() {
        super('Group state result snapshot no longer matches the mutation read.');
        this.name = 'GroupStateInboxResultReadConflictError';
    }
}

export function computeGroupStateInboxResult(input: ComputeGroupStateInboxResultInput): GroupStateInboxDurableResult {
    if (isPresenceOperation(input.command.command.operation)) {
        return input.computed.receipt;
    }
    assertSnapshotMatchesRead(input.currentSnapshot, input.read);
    const snapshot = input.computed.outcome === 'write'
        ? assembleCommittedSnapshot(input, input.computed)
        : input.currentSnapshot;
    if (snapshot === undefined) {
        throw new GroupStateInboxResultReadConflictError();
    }
    const event = input.computed.outcome === 'write'
        ? input.computed.event
        : readRecordedEvent(input.recordedEvent, input.computed.receipt);
    return input.command.command.operation === 'rotateGroupJoinCode'
        ? toJoinCodeResult(input.computed.receipt, snapshot, event)
        : toGroupMutationResult({ command: input.command, receipt: input.computed.receipt, snapshot, event });
}

export function validateGroupStateInboxResult(
    input: ComputeGroupStateInboxResultInput,
    computed: GroupStateInboxDurableResult
): readonly ComputedDataValidationIssue[] {
    const expected = computeGroupStateInboxResult(input);
    return validateComputedProjection(expected, computed, 'computed');
}

interface ToGroupMutationResultInput {
    readonly command: GroupStateMutationCommand;
    readonly receipt: GroupMutationReceipt;
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent | null;
}

function assertSnapshotMatchesRead(
    snapshot: GroupSnapshot | undefined,
    read: GroupMutationRead
): void {
    if (read.group === null) {
        if (snapshot !== undefined) {
            throw new GroupStateInboxResultReadConflictError();
        }
        return;
    }
    const presenceRevision = read.presenceSummary?.value.causalRevision.presenceRevision ?? 0;
    const expectedSnapshotGroup = {
        ...read.group.value,
        presenceVersion: presenceRevision
    };
    if (
        snapshot === undefined ||
        !jsonEquals(snapshot.group, expectedSnapshotGroup) ||
        snapshot.causalRevision.groupRevision !== read.group.value.snapshotVersion ||
        snapshot.causalRevision.presenceRevision !== presenceRevision
    ) {
        throw new GroupStateInboxResultReadConflictError();
    }
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

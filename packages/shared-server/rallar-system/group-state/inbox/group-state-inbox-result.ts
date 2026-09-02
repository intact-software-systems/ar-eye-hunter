import {
    validateAuthoritativeGroupEventIssues,
    validateAuthoritativeGroupSnapshotIssues
} from '@shared/api/authoritative-state-validation.ts';
import type { GroupEvent, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';

import type {
    GroupJoinCodeWritten,
    GroupStateMutationCommand,
    GroupStateWritten
} from '../group-state-service-contracts.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateJsonSafe,
    type GroupStateValidationIssue
} from '../group-state-validation-issues.ts';
import type {
    GroupMutationComputed,
    GroupMutationRead,
    GroupMutationReceipt
} from '../mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '../mutation/orchestration/compute-group-mutation.ts';
import { validateGroupMutation } from '../mutation/state-validation/validate-group-mutation.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    computeGroupStateSnapshot,
    validateGroupStateSnapshotAssembly,
    type GroupStateSnapshotAssemblyInput
} from '../persistence/assemble-group-state-snapshot.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '../persistence/group-state-persistence-contracts.ts';
import { groupStateMemberStorageKey } from '../persistence/membership/group-membership-storage-key.ts';
import type { InactiveGroupPresenceResult } from '../presence/group-presence-service.ts';

export type GroupPresenceInboxDurableResult = GroupMutationReceipt | InactiveGroupPresenceResult;

export type GroupStateInboxDurableResult = GroupPresenceInboxDurableResult | GroupJoinCodeWritten | GroupStateWritten;

export interface GroupStateInboxMutationComputed {
    readonly mutation: GroupMutationComputed;
    readonly durableResult: GroupStateInboxDurableResult | undefined;
}

export interface ComputeGroupStateInboxMutationInput {
    readonly currentSnapshot: GroupSnapshot | undefined;
    readonly command: GroupStateMutationCommand;
    readonly read: GroupMutationRead;
    readonly recordedEvent: GroupEvent | undefined;
}

export interface ValidateGroupStateInboxMutationInput extends ComputeGroupStateInboxMutationInput {
    readonly computed: GroupStateInboxMutationComputed;
}

interface ToGroupMutationResultInput {
    readonly command: GroupStateMutationCommand;
    readonly receipt: GroupMutationReceipt;
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent | null;
}

export class GroupStateInboxResultReadConflictError extends Error {
    readonly code = 'runtime-state-write-conflict';

    constructor() {
        super('Group state result snapshot no longer matches the mutation read.');
        this.name = 'GroupStateInboxResultReadConflictError';
    }
}

export function computeGroupStateInboxMutation(
    input: ComputeGroupStateInboxMutationInput
): Either<GroupStateInboxResultReadConflictError, GroupStateInboxMutationComputed> {
    const mutation = computeGroupMutation({
        command: input.command.command,
        read: input.read,
        facts: input.command.facts
    });
    return computeGroupStateInboxResult(input, mutation);
}

function computeGroupStateInboxResult(
    input: ComputeGroupStateInboxMutationInput,
    mutation: GroupMutationComputed
): Either<GroupStateInboxResultReadConflictError, GroupStateInboxMutationComputed> {
    if (mutation.outcome === 'idempotency-conflict' || mutation.outcome === 'rejected') {
        return Either.ofRight({ mutation, durableResult: undefined });
    }
    if (isGroupPresenceInboxOperation(input.command.command.operation)) {
        return Either.ofRight({ mutation, durableResult: mutation.receipt });
    }
    const conflict = computeSnapshotPredecessorConflict(input);
    if (conflict !== undefined) {
        return Either.ofLeft(conflict);
    }
    const snapshot = mutation.outcome === 'write'
        ? computeGroupStateSnapshot(toCommittedSnapshotInput(input, mutation))
        : input.currentSnapshot;
    if (snapshot === undefined) {
        return Either.ofLeft(new GroupStateInboxResultReadConflictError());
    }
    return Either.ofRight({
        mutation,
        durableResult: toInboxResult({
            command: input.command,
            receipt: mutation.receipt,
            snapshot,
            event: mutation.outcome === 'write' ? mutation.event : resolveRecordedReceiptEvent(input, mutation.receipt)
        })
    });
}

export function validateGroupStateInboxMutation(
    input: ValidateGroupStateInboxMutationInput
): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(input.computed)) {
        return [toGroupStateValidationIssue('computed', 'Group inbox computed result must be an object')];
    }
    const issues = [...validateGroupMutation({
        command: input.command.command,
        read: input.read,
        facts: input.command.facts,
        computed: input.computed.mutation
    })];
    if (input.computed.durableResult !== undefined) {
        issues.push(...validateJsonSafe(input.computed.durableResult, 'Group inbox durable result'));
    }
    if (issues.length > 0) {
        return issues;
    }
    issues.push(...validateGroupInboxResultRead(input));
    if (issues.length > 0) {
        return issues;
    }
    const canonical = computeGroupStateInboxResult(input, input.computed.mutation);
    if (canonical.right === undefined) {
        return [{ path: 'currentSnapshot', cause: canonical.left! }];
    }
    const canonicalResult = canonical.right.durableResult;
    const { mutation } = input.computed;
    if (mutation.outcome === 'write' && canonicalResult !== undefined && 'result' in canonicalResult) {
        const assembly = toCommittedSnapshotInput(input, mutation);
        issues.push(
            ...validateGroupStateSnapshotAssembly(assembly, canonicalResult.result.snapshot)
                .map((issue) => ({
                    path: issue.path,
                    cause: new GroupStateRepositoryInvariantCorruptionError(
                        groupStateGroupStorageKey(assembly.group),
                        issue.message
                    )
                }))
        );
    }
    if (!jsonEquals(input.computed.durableResult, canonical.right.durableResult)) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.durableResult',
                'Group inbox result differs from its canonical deterministic projection.'
            )
        );
    }
    return issues;
}

function validateGroupInboxResultRead(
    input: ValidateGroupStateInboxMutationInput
): readonly GroupStateValidationIssue[] {
    const { mutation } = input.computed;
    const operation = input.command.command.operation;
    if (
        mutation.outcome === 'rejected' || mutation.outcome === 'idempotency-conflict' ||
        isGroupPresenceInboxOperation(operation)
    ) {
        return [];
    }
    const issues = [...validateGroupResultReceipt(operation, mutation.receipt)];
    if (input.currentSnapshot !== undefined) {
        issues.push(
            ...validateAuthoritativeGroupSnapshotIssues(input.currentSnapshot, input.command.command.aggregateRef)
                .map((issue) => toGroupStateValidationIssue(issue.path, issue.message))
        );
    }
    if (mutation.outcome === 'no-op' || mutation.outcome === 'replay') {
        issues.push(...validateRecordedReceiptEvent(input, mutation.receipt));
    }
    return issues;
}

function toCommittedSnapshotInput(
    input: ComputeGroupStateInboxMutationInput,
    computed: Extract<GroupMutationComputed, { outcome: 'write'; }>
): GroupStateSnapshotAssemblyInput {
    if (computed.guard.kind !== 'group') {
        throw new TypeError('Presence mutations do not assemble group snapshots.');
    }
    return {
        group: computed.guard.value,
        members: mergeMembers(input.currentSnapshot?.members ?? [], computed.members),
        summary: computed.initialPresenceSummary?.value ?? input.read.presenceSummary?.value,
        authoritativeSessions: input.currentSnapshot?.activeSessions ?? [],
        groupRevision: computed.guard.value.snapshotVersion,
        observedAtEpochMs: input.command.facts.nowEpochMs,
        sessionLeaseFields: 'authoritative'
    };
}

function computeSnapshotPredecessorConflict(
    input: ComputeGroupStateInboxMutationInput
): GroupStateInboxResultReadConflictError | undefined {
    const { currentSnapshot: current, command, read } = input;
    if (read.group === null) {
        return current === undefined ? undefined : new GroupStateInboxResultReadConflictError();
    }
    if (current === undefined) {
        return new GroupStateInboxResultReadConflictError();
    }
    const issues = validateAuthoritativeGroupSnapshotIssues(current, command.command.aggregateRef);
    if (issues.length > 0) {
        throw new TypeError(issues[0].message);
    }
    if (
        current.causalRevision.groupRevision !== read.group.value.snapshotVersion ||
        current.causalRevision.presenceRevision !== (read.presenceSummary?.value.causalRevision.presenceRevision ?? 0)
    ) {
        return new GroupStateInboxResultReadConflictError();
    }
    return undefined;
}

function mergeMembers(
    current: readonly GroupMember[],
    changed: readonly GroupMember[]
): readonly GroupMember[] {
    const membersByStorageKey = new Map(current.map((member) => [groupStateMemberStorageKey(member), member]));
    for (const member of changed) {
        membersByStorageKey.set(groupStateMemberStorageKey(member), member);
    }
    return [...membersByStorageKey.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, member]) => member);
}

function toInboxResult(input: ToGroupMutationResultInput): GroupStateInboxDurableResult {
    const { command, receipt, snapshot, event } = input;
    const issues = validateGroupResultReceipt(command.command.operation, receipt);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return command.command.operation === 'rotateGroupJoinCode'
        ? toJoinCodeResult(receipt, snapshot, event)
        : toGroupMutationResult({ command, receipt, snapshot, event });
}

function resolveRecordedReceiptEvent(
    input: ComputeGroupStateInboxMutationInput,
    receipt: GroupMutationReceipt
): GroupEvent | null {
    const issues = validateRecordedReceiptEvent(input, receipt);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return receipt.eventId === null ? null : input.recordedEvent!;
}

function validateRecordedReceiptEvent(
    input: ComputeGroupStateInboxMutationInput,
    receipt: GroupMutationReceipt
): readonly GroupStateValidationIssue[] {
    if (receipt.eventId === null) {
        return [];
    }
    const event = input.recordedEvent;
    if (event === undefined) {
        return [toGroupStateValidationIssue('recordedEvent', 'Recorded group mutation event is missing.')];
    }
    const issues = validateAuthoritativeGroupEventIssues(event, input.command.command.aggregateRef)
        .map((issue) => toGroupStateValidationIssue(issue.path, issue.message));
    if (!isGroupStateRecord(event)) {
        return issues;
    }
    if (
        event.eventId !== receipt.eventId || event.snapshotVersion !== receipt.snapshotVersion ||
        event.requestId !== receipt.requestId || !jsonEquals(event.causalRevision, receipt.causalRevision)
    ) {
        issues.push(
            toGroupStateValidationIssue('recordedEvent', 'Recorded group mutation event differs from its receipt.')
        );
    }
    return issues;
}

export function isGroupPresenceInboxOperation(
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
    return {
        status: 'ok',
        result: {
            joinCode: receipt.joinCode!,
            expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs!,
            snapshot,
            event
        }
    };
}

function toGroupMutationResult(input: ToGroupMutationResultInput): GroupStateWritten {
    const { command, event, snapshot } = input;
    return {
        status: command.command.operation === 'createGroup' ? 'created' : 'ok',
        result: { snapshot, event }
    };
}

function validateGroupResultReceipt(
    operation: GroupStateMutationCommand['command']['operation'],
    receipt: GroupMutationReceipt
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (receipt.outcome === 'rejected') {
        issues.push(toGroupStateValidationIssue(
            'computed.mutation.receipt',
            operation === 'rotateGroupJoinCode'
                ? 'Rejected join-code mutation reached success result assembly'
                : 'Rejected group mutation reached success result assembly'
        ));
    }
    if (
        operation === 'rotateGroupJoinCode' && (receipt.joinCode === null || receipt.joinCodeExpiresAtEpochMs === null)
    ) {
        issues.push(
            toGroupStateValidationIssue('computed.mutation.receipt', 'Join-code mutation result is incomplete')
        );
    }
    return issues;
}

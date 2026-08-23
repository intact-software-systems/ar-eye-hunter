import type { MutationActor } from '@shared/api/mutation-actor.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import {
    assertExactKeys,
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf
} from '../../group-state-validation-primitives.ts';
import { validateGroupEvent } from '../../persistence/persisted-group-event.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession,
    validatePresenceSummaryValue
} from '../../persistence/validate-persisted-group-presence.ts';
import { validateStoredGroup, validateStoredMember } from '../../persistence/validate-persisted-group.ts';
import { validateInitialGroupPresenceSummaryCandidate } from '../../presence/group-initial-presence-summary.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import {
    isGroupLifecycleTransitionOperation,
    type GroupLifecycleTransitionOperation
} from '../group-mutation-contracts.ts';
import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import {
    resolveGroupMutationTargetPrincipalId,
    resolveGroupMutationTargetSessionId
} from '../orchestration/resolve-group-mutation-target-identity.ts';
import { isPureLeaseRenewalHeartbeat } from '../presence/compute-group-presence-mutation.ts';
import { validateGroupMutationIdempotencyRecord, validateMutationReceipt } from './validate-group-mutation-result.ts';

export interface ValidateComputedWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly computed: Extract<GroupMutationComputed, { outcome: 'write'; }>;
}

export function validateComputedWrite(input: ValidateComputedWriteInput): void {
    validateComputedGuard(input);
    validateComputedMembers(input);
    validateComputedInitialPresenceSummary(input);
    validateComputedPresenceAdmission(input);
    validateComputedEventAndReceipt(input);
    validateComputedOutboxEntries(input);
}

function validateComputedGuard({
    command,
    read,
    facts,
    computed
}: ValidateComputedWriteInput): void {
    const guard = computed.guard;
    const expectedKeys = [
        'kind',
        'operation',
        'value',
        ...(computed.guard.operation === 'insert' ? [] : ['expectedRevision'])
    ];
    assertExactKeys(guard, expectedKeys, 'Group mutation computed guard');
    assertRequiredKeys(guard, expectedKeys, 'Group mutation computed guard');
    requireOneOf(computed.guard.kind, ['group', 'presence'], 'Group mutation computed guard kind');
    requireOneOf(
        computed.guard.operation,
        ['insert', 'update', 'delete'],
        'Group mutation computed guard operation'
    );
    if (computed.guard.operation !== 'insert') {
        requireNonNegativeSafeInteger(
            computed.guard.expectedRevision,
            'Group mutation computed guard expectedRevision'
        );
    }
    if (computed.guard.kind === 'group') {
        validateComputedGroupGuard(read, command, computed.guard);
    }
    else {
        validateComputedPresenceGuard({ command, read, facts, computed });
    }
}

function validateComputedGroupGuard(
    read: GroupMutationRead,
    command: GroupMutationCommand,
    guard: Extract<ValidateComputedWriteInput['computed']['guard'], { kind: 'group'; }>
): void {
    if ((guard as { readonly operation: string; }).operation === 'delete') {
        throw new TypeError('Group mutation cannot use a group delete guard');
    }
    validateStoredGroup(guard.value, command.aggregateRef);
    const expectedRevision = read.group?.entry.revision ?? read.expiredGroupEntry?.revision;
    if (guard.operation === 'insert') {
        if (expectedRevision !== undefined) {
            throw new TypeError('Group insert guard has an existing predecessor');
        }
    }
    else if (guard.expectedRevision !== expectedRevision) {
        throw new TypeError('Group update guard revision differs from predecessor');
    }
}

function validateComputedPresenceGuard({
    command,
    read,
    facts,
    computed
}: ValidateComputedWriteInput): void {
    if (computed.guard.kind !== 'presence') {
        return;
    }
    const guard = computed.guard;
    validatePresenceSession(
        guard.value,
        command.aggregateRef,
        'Group mutation computed presence guard'
    );
    const expectedSessionId = resolveGroupMutationTargetSessionId(command);
    const expectedPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    if (
        expectedSessionId === null ||
        expectedPrincipalId === null ||
        guard.value.sessionId !== expectedSessionId ||
        guard.value.principalId !== expectedPrincipalId
    ) {
        throw new TypeError('Group mutation presence guard differs from command target identity');
    }
    const expectedRevision = read.targetPresence?.entry.revision ?? read.expiredTargetPresenceEntry?.revision;
    if (guard.operation === 'insert') {
        if (expectedRevision !== undefined) {
            throw new TypeError('Presence insert guard has an existing predecessor');
        }
    }
    else if (guard.expectedRevision !== expectedRevision) {
        throw new TypeError('Presence write guard revision differs from predecessor');
    }
    if (
        guard.operation === 'delete' &&
        (command.operation !== 'disconnectPresence' ||
            facts.internalAuthority !== 'expiry' ||
            command.input.reason !== 'expired')
    ) {
        throw new TypeError('Presence delete guard requires expiry authority');
    }
}

function validateComputedMembers({ command, read, computed }: ValidateComputedWriteInput): void {
    if (!Array.isArray(computed.members)) {
        throw new TypeError('Group mutation computed members must be an array');
    }
    for (const member of computed.members) {
        validateStoredMember(member, command.aggregateRef, 'Group mutation computed member');
    }
    const expected = expectedMutationMemberPrincipalIds(command, read);
    const actual = computed.members.map((member) => member.principalId).toSorted();
    if (!jsonEquals(actual, expected)) {
        throw new TypeError('Group mutation member candidate identity differs from command target');
    }
}

function validateComputedInitialPresenceSummary({
    command,
    read,
    computed
}: ValidateComputedWriteInput): void {
    if (computed.initialPresenceSummary === null) {
        return;
    }
    if (command.operation !== 'createGroup') {
        throw new TypeError('Initial group presence summary operation requires group creation');
    }
    validateInitialGroupPresenceSummaryCandidate(
        computed.initialPresenceSummary,
        read.presenceSummary
    );
    validatePresenceSummaryValue(computed.initialPresenceSummary.value, command.aggregateRef);
}

function validateComputedPresenceAdmission({
    command,
    read,
    computed
}: ValidateComputedWriteInput): void {
    if (computed.presenceAdmission === null) {
        return;
    }
    const admission = computed.presenceAdmission;
    const expectedKeys = [
        'operation',
        'value',
        ...(computed.presenceAdmission.operation === 'update' ? ['expectedRevision'] : [])
    ];
    assertExactKeys(admission, expectedKeys, 'Group mutation computed admission');
    assertRequiredKeys(admission, expectedKeys, 'Group mutation computed admission');
    requireOneOf(
        computed.presenceAdmission.operation,
        ['insert', 'update'],
        'Group mutation computed admission operation'
    );
    validatePresenceAdmission(computed.presenceAdmission.value, command.aggregateRef);
    validateComputedAdmissionPredecessor(read, computed.presenceAdmission);
    const admittedPrincipalId = computed.presenceAdmission.value.principalId;
    const expectedPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    if (expectedPrincipalId === null || expectedPrincipalId !== admittedPrincipalId) {
        throw new TypeError('Group mutation admission principal differs from command target identity');
    }
}

function validateComputedAdmissionPredecessor(
    read: GroupMutationRead,
    admission: NonNullable<ValidateComputedWriteInput['computed']['presenceAdmission']>
): void {
    if (admission.operation === 'update') {
        requireNonNegativeSafeInteger(
            admission.expectedRevision,
            'Group mutation computed admission expectedRevision'
        );
    }
    const predecessor = read.targetAdmission;
    if (admission.operation === 'insert') {
        if (predecessor !== null) {
            throw new TypeError('Group mutation admission insert has an existing predecessor');
        }
    }
    else if (predecessor === null || admission.expectedRevision !== predecessor.entry.revision) {
        throw new TypeError('Group mutation admission update revision differs from predecessor');
    }
}

function validateComputedEventAndReceipt({
    command,
    facts,
    computed
}: ValidateComputedWriteInput): void {
    validateGroupEvent(computed.event, command.aggregateRef, 'Group mutation computed event');
    if (
        computed.event.eventId !== facts.eventId ||
        computed.event.occurredAtEpochMs !== facts.nowEpochMs ||
        (computed.event.requestId ?? null) !== command.requestId ||
        actorPrincipalId(computed.event.actor) !== command.input.actorPrincipalId ||
        actorSessionId(computed.event.actor) !== command.input.actorSessionId
    ) {
        throw new TypeError('Group mutation computed event identity differs from command and facts');
    }
    validateMutationReceipt(
        computed.receipt,
        command.aggregateRef,
        'Group mutation computed receipt'
    );
    if (
        computed.receipt.outcome !== 'applied' ||
        computed.receipt.commandId !== command.commandId ||
        computed.receipt.requestId !== command.requestId ||
        computed.receipt.commandHash !== facts.commandHash
    ) {
        throw new TypeError('Group mutation computed receipt differs from command');
    }
    validateComputedIdempotency(command, computed);
}

function validateComputedIdempotency(
    command: GroupMutationCommand,
    computed: ValidateComputedWriteInput['computed']
): void {
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (computed.idempotency !== null) {
        validateGroupMutationIdempotencyRecord(computed.idempotency, command.aggregateRef);
        if (
            computed.idempotency.requestId !== idempotencyKey ||
            !jsonEquals(computed.idempotency.receipt, computed.receipt)
        ) {
            throw new TypeError('Group mutation computed idempotency differs from receipt');
        }
    }
    else if (idempotencyKey !== null) {
        throw new TypeError('Group mutation computed idempotency is missing');
    }
}

function expectedMutationMemberPrincipalIds(
    command: GroupMutationCommand,
    read: GroupMutationRead
): readonly string[] {
    switch (command.operation) {
        case 'createGroup':
            return [command.input.createdByPrincipalId];
        case 'joinGroup':
        case 'acceptGroupInvite':
        case 'createGroupInvite':
        case 'revokeGroupInvite':
        case 'grantGroupAdmission':
        case 'declineGroupAdmission':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
        case 'upsertMember':
            return [command.targetPrincipalId];
        case 'transferGroupOwnership': {
            const currentOwner = read.group?.value.ownerPrincipalId;
            return currentOwner === undefined
                ? [command.targetPrincipalId]
                : [currentOwner, command.targetPrincipalId].toSorted();
        }
        default:
            return [];
    }
}

export function validateComputedOutboxEntries(input: ValidateComputedWriteInput): void {
    const { command, read, facts, computed } = input;
    if (!Array.isArray(computed.outboxEntries)) {
        throw new TypeError('Group mutation computed outbox entries must be an array');
    }
    const pureLeaseRenewal = command.operation === 'heartbeatPresence' &&
        isPureLeaseRenewalHeartbeat(command, read, facts);
    if (pureLeaseRenewal) {
        if (computed.outboxEntries.length !== 0 || computed.receipt.outboxIds.length !== 0) {
            throw new TypeError('A pure lease renewal must not expand a presence summary');
        }
        return;
    }
    const expectedTimerEntries = computeExpectedFormationTimerEntries(input);
    if (computed.outboxEntries.length !== 1 + expectedTimerEntries.length) {
        throw new TypeError('Group mutation must compute one presence-summary outbox entry');
    }
    for (const [index, expectedTimer] of expectedTimerEntries.entries()) {
        if (!jsonEquals(computed.outboxEntries[1 + index], expectedTimer)) {
            throw new TypeError('Group mutation formation-timer outbox entry is not canonical');
        }
    }
    const expected = computeGroupPresenceSummaryEntry(
        {
            effectKind: 'group-presence-summary',
            aggregateRef: command.aggregateRef,
            commandId: command.commandId,
            createdAtEpochMs: facts.nowEpochMs,
            expireAtEpochMs: facts.expireAtEpochMs,
            acceptedCausalRevision: computed.receipt.causalRevision,
            event: computed.event
        },
        facts.serviceId
    );
    if (!jsonEquals(computed.outboxEntries[0], expected)) {
        throw new TypeError('Group mutation presence-summary outbox entry is not canonical');
    }
}

function computeExpectedFormationTimerEntries(
    input: ValidateComputedWriteInput
): readonly ResourceEntry[] {
    const { command, read, facts, computed } = input;
    if (!isGroupLifecycleTransitionOperation(command.operation)) {
        return [];
    }
    if (computed.guard.kind !== 'group' || read.lifecyclePolicy === null) {
        return [];
    }
    if (read.lifecyclePolicy.status === 'corrupt') {
        return [];
    }
    const policy = read.lifecyclePolicy.status === 'present'
        ? read.lifecyclePolicy.policy
        : createDefaultGroupLifecyclePolicy();
    return computeFormationTimerEntries({
        command: command as Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>,
        next: computed.guard.value as Group,
        policy,
        facts
    });
}

function actorPrincipalId(actor: MutationActor): string | null {
    return actor.kind === 'service' ? null : actor.principalId;
}

function actorSessionId(actor: MutationActor): string | null {
    return actor.kind === 'session' ? actor.sessionId : null;
}

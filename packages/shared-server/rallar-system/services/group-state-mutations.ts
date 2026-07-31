import type {
    Group,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
} from '@shared/api/group-types.ts';
import {
    compareGroupCausalRevision,
    toGroupSnapshotStateRevision,
} from '@shared/api/group-client-views.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { GroupPolicyDeniedError } from '../group-policy.ts';
import {
    computeGroupPresenceSummaryEntry,
    GROUP_PRESENCE_SUMMARY_TOPIC,
    type GroupPresenceSummaryWorkData,
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    groupStateGroupStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey,
} from '../group-state-storage-keys.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationIdempotencyProbe,
    GroupMutationIdempotencyRecord,
    GroupMutationRead,
    GroupMutationReceipt,
} from '../group-state/mutation/group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-state/mutation/group-mutation-contracts.ts';
import { validateGroupMutationCommand } from '../group-state/mutation/group-mutation-command-validation.ts';
import {
    validateGroupMutationRead,
    mutationTargetPrincipalId,
    mutationTargetSessionId,
    validateRuntimeEntryValue,
} from '../group-state/mutation/validate-group-mutation-read.ts';
import {
    requireGroup,
    validateCommandHash,
    validateGroupMutationIdempotencyRecord,
    validateMutationReceipt,
} from '../group-state/mutation/group-mutation-result.ts';
import {
    computeCreate,
    computeDirector,
    computeRotateJoinCode,
    computeUpdate,
} from '../group-state/mutation/compute-group-aggregate-mutation.ts';
import {
    computeGovernedMember,
    computeInvite,
    computeJoin,
    computeRevokeInvite,
    computeTransfer,
    computeUpsertMember,
    findKnownMember,
} from '../group-state/mutation/compute-group-membership-mutation.ts';
import {
    admissionIdentity,
    computeConnectPresence,
    computeDisconnectPresence,
    computeHeartbeatPresence,
} from '../group-state/mutation/compute-group-presence-mutation.ts';
import {
    validateStoredGroup,
    validateStoredMember,
} from '../group-state/persistence/validate-persisted-group.ts';
import {
    validatePresenceAdmission,
    validatePresenceSession,
    validatePresenceSummaryValue,
} from '../group-state/persistence/validate-persisted-group-presence.ts';
import { validateInitialGroupPresenceSummaryCandidate } from './group-initial-presence-summary.ts';
import {
    assertExactKeys,
    assertRequiredKeys,
    requireJsonSafe,
    requireNonEmptyString,
    requireNonNegativeSafeInteger,
    requireOneOf,
    requirePositiveSafeInteger,
    requireRecord,
} from '../group-state/mutation/group-state-validation-primitives.ts';
import { validateGroupEvent } from '../persisted-group-event.ts';
export {
    normalizePersistedGroupEvent,
    validatePersistedGroupEvent,
} from '../persisted-group-event.ts';
export {
    computeGroupPresenceSummaryEntry,
    GROUP_PRESENCE_SUMMARY_TOPIC as APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC,
};
export type { GroupPresenceSummaryWorkData };
export type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationIdempotencyProbe,
    GroupMutationIdempotencyRecord,
    GroupMutationRead,
    GroupMutationReceipt,
} from '../group-state/mutation/group-mutation-contracts.ts';
export { GroupMutationRejectedError } from '../group-state/mutation/group-mutation-contracts.ts';
export { validateGroupMutationCommand } from '../group-state/mutation/group-mutation-command-validation.ts';
export {
    validateGroupMutationRequest,
    validateGroupPresenceMutationRequest,
} from '../group-state/mutation/group-mutation-request-validation.ts';
export {
    normalizePersistedGroup,
    normalizePersistedGroupMember,
    normalizePersistedGroupPresenceAdmission,
    normalizePersistedGroupPresenceSession,
    normalizePersistedGroupPresenceSummary,
} from '../group-state/persistence/group-state-persistence-codec.ts';
export {
    validatePersistedGroup,
    validatePersistedGroupMember,
} from '../group-state/persistence/validate-persisted-group.ts';
export {
    validatePersistedGroupPresenceAdmission,
    validatePersistedGroupPresenceSession,
    validatePersistedGroupPresenceSummary,
} from '../group-state/persistence/validate-persisted-group-presence.ts';
export { validateGroupMutationIdempotencyRecord };

export type GroupPresenceSummaryRead = Readonly<{
    group: RuntimeStateEntryValue<Group>;
    members: readonly RuntimeStateEntryValue<GroupMember>[];
    admissions: readonly RuntimeStateEntryValue<GroupPresenceAdmission>[];
    presenceSessions: readonly RuntimeStateEntryValue<GroupPresenceSession>[];
    current: RuntimeStateEntryValue<GroupPresenceSummary> | null;
}>;

export type GroupPresenceSummaryComputed =
    | Readonly<{
        outcome: 'no-op';
        evaluatedAtEpochMs: number;
        summary: GroupPresenceSummary;
    }>
    | Readonly<{
        outcome: 'write';
        evaluatedAtEpochMs: number;
        operation: 'insert' | 'update';
        expectedRevision: number | null;
        summary: GroupPresenceSummary;
    }>;

export function computeGroupMutation(input: Readonly<{
    command: GroupMutationCommand;
    read: GroupMutationRead;
    facts: GroupMutationFacts;
}>): GroupMutationComputed {
    const { command, read, facts } = input;
    validateGroupMutationCommand(command);
    validateGroupMutationRead(read, command);
    validateFacts(facts);
    validateTrustedAuthorityMode(command, facts);
    const idempotency = probeGroupMutationIdempotency(
        command,
        read,
        facts.commandHash,
    );
    if (idempotency.outcome !== 'miss') return idempotency;

    switch (command.operation) {
        case 'createGroup':
            return computeCreate(command, read, facts);
        case 'updateGroup':
            return computeUpdate(command, read, facts);
        case 'appointDirector':
            return computeDirector(command, read, facts);
        case 'joinGroup':
        case 'acceptGroupInvite':
            return computeJoin(command, read, facts);
        case 'createGroupInvite':
            return computeInvite(command, read, facts);
        case 'revokeGroupInvite':
            return computeRevokeInvite(command, read, facts);
        case 'rotateGroupJoinCode':
            return computeRotateJoinCode(command, read, facts);
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
            return computeGovernedMember(command, read, facts);
        case 'transferGroupOwnership':
            return computeTransfer(command, read, facts);
        case 'upsertMember':
            return computeUpsertMember(command, read, facts);
        case 'connectPresence':
            return computeConnectPresence(command, read, facts);
        case 'heartbeatPresence':
            return computeHeartbeatPresence(command, read, facts);
        case 'disconnectPresence':
            return computeDisconnectPresence(command, read, facts);
    }
}

export function probeGroupMutationIdempotency(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    commandHash: string,
): GroupMutationIdempotencyProbe {
    validateGroupMutationCommand(command);
    validateGroupMutationRead(read, command);
    validateCommandHash(commandHash, 'Group mutation commandHash');
    if (!read.idempotency) return { outcome: 'miss' };
    const record = read.idempotency.value;
    if (record.receipt.commandId !== command.commandId) {
        throw new TypeError(
            'Stored group idempotency receipt command differs from command identity',
        );
    }
    return record.commandHash === commandHash
        ? { outcome: 'replay', receipt: record.receipt }
        : {
            outcome: 'idempotency-conflict',
            existingCommandHash: record.commandHash,
            receivedCommandHash: commandHash,
        };
}

export function validateGroupMutation(input: Readonly<{
    command: GroupMutationCommand;
    read: GroupMutationRead;
    facts: GroupMutationFacts;
    computed: GroupMutationComputed;
}>): void {
    validateGroupMutationCommand(input.command);
    validateGroupMutationRead(input.read, input.command);
    validateFacts(input.facts);
    validateTrustedAuthorityMode(input.command, input.facts);
    requireJsonSafe(
        input.computed.outcome === 'write'
            ? { ...input.computed, outboxEntries: [] }
            : input.computed,
        'Group mutation computed result',
    );
    validateComputedMutationShape(
        input.command,
        input.read,
        input.facts,
        input.computed,
    );
    const canonical = computeGroupMutation({
        command: input.command,
        read: input.read,
        facts: input.facts,
    });
    if (!jsonEquals(input.computed, canonical)) {
        throw new TypeError(
            `Group ${input.command.operation} mutation differs from its canonical deterministic projection`,
        );
    }
    if (input.computed.outcome === 'idempotency-conflict') return;
    const receipt = input.computed.receipt;
    if (receipt.commandHash !== input.facts.commandHash) {
        throw new TypeError('Group mutation receipt hash differs from facts');
    }
    if (input.computed.outcome === 'write') {
        validateComputedRosterFacts(input.read, input.computed);
        if (input.computed.presenceAdmission) {
            validatePresenceAdmission(input.computed.presenceAdmission.value);
        }
        validateComputedOutboxEntries(input.command, input.facts, input.computed);
        if (input.computed.event.eventId !== receipt.eventId) {
            throw new TypeError('Group mutation receipt event differs from write event');
        }
        if (input.computed.guard.kind === 'presence' && input.computed.members.length > 0) {
            throw new TypeError('Presence mutation must not write group members');
        }
    }
}





















function validateComputedMutationShape(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    computed: GroupMutationComputed,
): void {
    const value = computed as unknown as Record<string, unknown>;
    switch (computed.outcome) {
        case 'replay':
        case 'no-op':
        case 'rejected':
            assertExactKeys(value, ['outcome', 'receipt'],
                'Group mutation computed result');
            assertRequiredKeys(value, ['outcome', 'receipt'],
                'Group mutation computed result');
            validateMutationReceipt(computed.receipt, command.aggregateRef,
                'Group mutation computed receipt');
            if (computed.receipt.commandHash !== facts.commandHash) {
                throw new TypeError('Group mutation computed receipt hash differs from facts');
            }
            if (computed.outcome !== 'replay' &&
                computed.receipt.outcome !== computed.outcome) {
                throw new TypeError('Group mutation computed receipt outcome differs');
            }
            return;
        case 'idempotency-conflict':
            assertExactKeys(value, [
                'outcome', 'existingCommandHash', 'receivedCommandHash',
            ], 'Group mutation computed result');
            assertRequiredKeys(value, [
                'outcome', 'existingCommandHash', 'receivedCommandHash',
            ], 'Group mutation computed result');
            validateCommandHash(computed.existingCommandHash,
                'Group mutation existingCommandHash');
            validateCommandHash(computed.receivedCommandHash,
                'Group mutation receivedCommandHash');
            if (computed.receivedCommandHash !== facts.commandHash) {
                throw new TypeError('Group mutation conflict hash differs from facts');
            }
            return;
        case 'write':
            assertExactKeys(value, [
                'outcome', 'guard', 'members', 'initialPresenceSummary',
                'presenceAdmission', 'event', 'receipt', 'idempotency', 'outboxEntries',
            ], 'Group mutation computed result');
            assertRequiredKeys(value, [
                'outcome', 'guard', 'members', 'initialPresenceSummary',
                'presenceAdmission', 'event', 'receipt', 'idempotency', 'outboxEntries',
            ], 'Group mutation computed result');
            validateComputedWrite(command, read, facts, computed);
            return;
    }
}

function validateComputedWrite(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
    const ref = command.aggregateRef;
    const guard = computed.guard as unknown as Record<string, unknown>;
    assertExactKeys(guard, [
        'kind', 'operation', 'value',
        ...(computed.guard.operation === 'insert' ? [] : ['expectedRevision']),
    ], 'Group mutation computed guard');
    assertRequiredKeys(guard, [
        'kind', 'operation', 'value',
        ...(computed.guard.operation === 'insert' ? [] : ['expectedRevision']),
    ], 'Group mutation computed guard');
    requireOneOf(computed.guard.kind, ['group', 'presence'],
        'Group mutation computed guard kind');
    requireOneOf(computed.guard.operation, ['insert', 'update', 'delete'],
        'Group mutation computed guard operation');
    if (computed.guard.operation !== 'insert') {
        requireNonNegativeSafeInteger(computed.guard.expectedRevision,
            'Group mutation computed guard expectedRevision');
    }
    if (computed.guard.kind === 'group') {
        if (guard.operation === 'delete') {
            throw new TypeError('Group mutation cannot use a group delete guard');
        }
        validateStoredGroup(computed.guard.value, ref);
        const expectedRevision = read.group?.entry.revision ??
            read.expiredGroupEntry?.revision;
        if (computed.guard.operation === 'insert') {
            if (expectedRevision !== undefined) {
                throw new TypeError('Group insert guard has an existing predecessor');
            }
        } else if (computed.guard.expectedRevision !== expectedRevision) {
            throw new TypeError('Group update guard revision differs from predecessor');
        }
    } else {
        validatePresenceSession(computed.guard.value, ref,
            'Group mutation computed presence guard');
        const expectedSessionId = mutationTargetSessionId(command);
        const expectedPrincipalId = mutationTargetPrincipalId(command);
        if (expectedSessionId === null || expectedPrincipalId === null ||
            computed.guard.value.sessionId !== expectedSessionId ||
            computed.guard.value.principalId !== expectedPrincipalId) {
            throw new TypeError(
                'Group mutation presence guard differs from command target identity',
            );
        }
        const expectedRevision = read.targetPresence?.entry.revision ??
            read.expiredTargetPresenceEntry?.revision;
        if (computed.guard.operation === 'insert') {
            if (expectedRevision !== undefined) {
                throw new TypeError('Presence insert guard has an existing predecessor');
            }
        } else if (computed.guard.expectedRevision !== expectedRevision) {
            throw new TypeError('Presence write guard revision differs from predecessor');
        }
        if (computed.guard.operation === 'delete' &&
            (command.operation !== 'disconnectPresence' ||
                facts.internalAuthority !== 'expiry' ||
                command.input.reason !== 'expired')) {
            throw new TypeError('Presence delete guard requires expiry authority');
        }
    }
    if (!Array.isArray(computed.members)) {
        throw new TypeError('Group mutation computed members must be an array');
    }
    for (const member of computed.members) {
        validateStoredMember(member, ref, 'Group mutation computed member');
    }
    const expectedMemberPrincipalIds = expectedMutationMemberPrincipalIds(command, read);
    const actualMemberPrincipalIds = computed.members
        .map((member) => member.principalId)
        .toSorted();
    if (!jsonEquals(actualMemberPrincipalIds, expectedMemberPrincipalIds)) {
        throw new TypeError(
            'Group mutation member candidate identity differs from command target',
        );
    }
    if (computed.initialPresenceSummary !== null) {
        if (command.operation !== 'createGroup') throw new TypeError('Initial group presence summary operation requires group creation');
        validateInitialGroupPresenceSummaryCandidate(computed.initialPresenceSummary,
            read.presenceSummary);
        validatePresenceSummaryValue(computed.initialPresenceSummary.value, ref);
    }
    if (computed.presenceAdmission !== null) {
        const admission = computed.presenceAdmission as unknown as Record<string, unknown>;
        assertExactKeys(admission, [
            'operation', 'value',
            ...(computed.presenceAdmission.operation === 'update'
                ? ['expectedRevision']
                : []),
        ], 'Group mutation computed admission');
        assertRequiredKeys(admission, [
            'operation', 'value',
            ...(computed.presenceAdmission.operation === 'update'
                ? ['expectedRevision']
                : []),
        ], 'Group mutation computed admission');
        requireOneOf(computed.presenceAdmission.operation, ['insert', 'update'],
            'Group mutation computed admission operation');
        validatePresenceAdmission(computed.presenceAdmission.value, ref);
        if (computed.presenceAdmission.operation === 'update') {
            requireNonNegativeSafeInteger(computed.presenceAdmission.expectedRevision,
                'Group mutation computed admission expectedRevision');
        }
        const predecessor = read.targetAdmission;
        if (computed.presenceAdmission.operation === 'insert') {
            if (predecessor !== null) {
                throw new TypeError(
                    'Group mutation admission insert has an existing predecessor',
                );
            }
        } else if (
            predecessor === null ||
            computed.presenceAdmission.expectedRevision !== predecessor.entry.revision
        ) {
            throw new TypeError(
                'Group mutation admission update revision differs from predecessor',
            );
        }
        const admittedPrincipalId = computed.presenceAdmission.value.principalId;
        const expectedPrincipalId = mutationTargetPrincipalId(command);
        if (expectedPrincipalId === null || expectedPrincipalId !== admittedPrincipalId) {
            throw new TypeError(
                'Group mutation admission principal differs from command target identity',
            );
        }
    }
    validateGroupEvent(computed.event, ref, 'Group mutation computed event');
    if (computed.event.eventId !== facts.eventId ||
        computed.event.occurredAtEpochMs !== facts.nowEpochMs ||
        (computed.event.requestId ?? null) !== command.requestId ||
        actorPrincipalId(computed.event.actor) !== command.input.actorPrincipalId ||
        actorSessionId(computed.event.actor) !== command.input.actorSessionId) {
        throw new TypeError(
            'Group mutation computed event identity differs from command and facts',
        );
    }
    validateMutationReceipt(computed.receipt, ref, 'Group mutation computed receipt');
    if (computed.receipt.outcome !== 'applied' ||
        computed.receipt.commandId !== command.commandId ||
        computed.receipt.commandHash !== facts.commandHash) {
        throw new TypeError('Group mutation computed receipt differs from command');
    }
    if (computed.idempotency !== null) {
        validateGroupMutationIdempotencyRecord(computed.idempotency, ref);
        if (computed.idempotency.requestId !== command.requestId ||
            !jsonEquals(computed.idempotency.receipt, computed.receipt)) {
            throw new TypeError('Group mutation computed idempotency differs from receipt');
        }
    } else if (command.requestId !== null) {
        throw new TypeError('Group mutation computed idempotency is missing');
    }
    validateComputedOutboxEntries(command, facts, computed);
}

function expectedMutationMemberPrincipalIds(
    command: GroupMutationCommand,
    read: GroupMutationRead,
): readonly string[] {
    switch (command.operation) {
        case 'createGroup':
            return [command.input.createdByPrincipalId];
        case 'joinGroup':
        case 'acceptGroupInvite':
        case 'createGroupInvite':
        case 'revokeGroupInvite':
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
        case 'updateGroup':
        case 'appointDirector':
        case 'rotateGroupJoinCode':
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
            return [];
    }
}

function validateComputedOutboxEntries(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
    if (!Array.isArray(computed.outboxEntries) || computed.outboxEntries.length !== 1) {
        throw new TypeError('Group mutation must compute one presence-summary outbox entry');
    }
    const expected = computeGroupPresenceSummaryEntry({
        effectKind: 'group-presence-summary',
        aggregateRef: command.aggregateRef,
        commandId: command.commandId,
        createdAtEpochMs: facts.nowEpochMs,
        expireAtEpochMs: facts.expireAtEpochMs,
        acceptedCausalRevision: computed.receipt.causalRevision,
        event: computed.event,
    }, facts.serviceId);
    if (!jsonEquals(computed.outboxEntries[0], expected)) {
        throw new TypeError('Group mutation presence-summary outbox entry is not canonical');
    }
}

function validateComputedRosterFacts(
    read: GroupMutationRead,
    computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
    if (computed.guard.kind !== 'group') return;
    const candidate = computed.guard.value;
    if (!Number.isSafeInteger(candidate.activeMemberCount) ||
        candidate.activeMemberCount < 1) {
        throw new TypeError('Group activeMemberCount must be a positive safe integer');
    }
    requireNonEmptyString(candidate.ownerPrincipalId, 'Group ownerPrincipalId');
    if (computed.guard.operation === 'insert' ||
        (read.group === null && computed.guard.operation === 'update' &&
            computed.guard.expectedRevision === read.expiredGroupEntry?.revision)) {
        const active = computed.members.filter((member) => member.status === 'active');
        const owners = active.filter((member) => member.role === 'owner');
        if (
            candidate.activeMemberCount !== active.length ||
            owners.length !== 1 ||
            owners[0]?.principalId !== candidate.ownerPrincipalId
        ) {
            throw new TypeError('Inserted group roster facts differ from member candidates');
        }
        return;
    }
    const current = requireGroup(read, candidate);
    let expectedCount = current.value.activeMemberCount;
    for (const member of computed.members) {
        const previous = findKnownMember(read, member.principalId);
        if ((previous?.status === 'active') !== (member.status === 'active')) {
            expectedCount += member.status === 'active' ? 1 : -1;
        }
    }
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 ||
        candidate.activeMemberCount !== expectedCount) {
        throw new TypeError('Updated group activeMemberCount has an invalid predecessor delta');
    }
    const promoted = computed.members.filter((member) =>
        member.status === 'active' && member.role === 'owner' &&
        member.principalId !== current.value.ownerPrincipalId
    );
    const currentOwnerCandidate = computed.members.find((member) =>
        member.principalId === current.value.ownerPrincipalId
    );
    const expectedOwner = promoted.length === 1 && currentOwnerCandidate &&
            (currentOwnerCandidate.status !== 'active' || currentOwnerCandidate.role !== 'owner')
        ? promoted[0]!.principalId
        : current.value.ownerPrincipalId;
    if (promoted.length > 1 || candidate.ownerPrincipalId !== expectedOwner) {
        throw new TypeError('Updated group ownerPrincipalId has an invalid predecessor delta');
    }
}

export function computeGroupPresenceSummary(input: Readonly<{
    ref: GroupRef;
    read: GroupPresenceSummaryRead;
    nowEpochMs: number;
}>): GroupPresenceSummaryComputed {
    const { ref, read, nowEpochMs } = input;
    const content = deriveGroupPresenceSummaryContent(read, nowEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    if (current && (current.causalRevision.groupRevision > groupRevision ||
        current.causalRevision.groupRevision === groupRevision &&
        jsonEquals(summaryContent(current), content))) {
        return { outcome: 'no-op', evaluatedAtEpochMs: nowEpochMs, summary: current };
    }
    const summary: GroupPresenceSummary = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
        causalRevision: {
            groupRevision,
            presenceRevision:
                (current?.causalRevision.presenceRevision ?? 0) + 1,
        },
        ...content,
        computedAtEpochMs: nowEpochMs,
    };
    return {
        outcome: 'write',
        evaluatedAtEpochMs: nowEpochMs,
        operation: read.current ? 'update' : 'insert',
        expectedRevision: read.current?.entry.revision ?? null,
        summary,
    };
}

export function validateGroupPresenceSummary(input: Readonly<{
    ref: GroupRef;
    read: GroupPresenceSummaryRead;
    computed: GroupPresenceSummaryComputed;
}>): void {
    const { ref, read, computed } = input;
    requireJsonSafe(read, 'Group presence summary read');
    requireJsonSafe(computed, 'Group presence summary computed result');
    assertExactKeys(read as unknown as Record<string, unknown>, [
        'group', 'members', 'admissions', 'presenceSessions', 'current',
    ], 'Group presence summary read');
    assertRequiredKeys(read as unknown as Record<string, unknown>, [
        'group', 'members', 'admissions', 'presenceSessions', 'current',
    ], 'Group presence summary read');
    validateRuntimeEntryValue(
        read.group,
        'Stored summary group',
        groupStateGroupStorageKey(ref),
    );
    validateStoredGroup(read.group.value, ref);
    validateGroupPresenceSummaryReadCollections(ref, read);
    if (read.current) {
        validateRuntimeEntryValue(
            read.current,
            'Stored current presence summary',
            groupStatePresenceSummaryStorageKey(ref),
        );
        validatePresenceSummaryValue(read.current.value, ref);
    }
    const summary = computed.summary;
    validatePresenceSummaryValue(summary, ref);
    requirePositiveSafeInteger(computed.evaluatedAtEpochMs,
        'Group presence summary evaluatedAtEpochMs');
    const expectedContent = deriveGroupPresenceSummaryContent(read,
        computed.evaluatedAtEpochMs);
    const groupRevision = read.group.value.snapshotVersion;
    const current = read.current?.value;
    const expectedNoOp = current !== undefined && (
        current.causalRevision.groupRevision > groupRevision ||
        current.causalRevision.groupRevision === groupRevision &&
        jsonEquals(summaryContent(current), expectedContent));
    const shape = computed as unknown as Record<string, unknown>;
    if (computed.outcome === 'no-op') {
        assertExactKeys(shape, ['outcome', 'evaluatedAtEpochMs', 'summary'],
            'Group presence summary computed result');
        if (!expectedNoOp || !current || !jsonEquals(summary, current)) {
            throw new TypeError(
                'Group presence summary no-op differs from current canonical candidate',
            );
        }
    } else {
        assertExactKeys(shape,
            ['outcome', 'evaluatedAtEpochMs', 'operation', 'expectedRevision', 'summary'],
            'Group presence summary computed result');
        const expectedSummary: GroupPresenceSummary = {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId,
            causalRevision: {
                groupRevision,
                presenceRevision:
                    (current?.causalRevision.presenceRevision ?? 0) + 1,
            },
            ...expectedContent,
            computedAtEpochMs: computed.evaluatedAtEpochMs,
        };
        if (expectedNoOp ||
            computed.operation !== (read.current ? 'update' : 'insert') ||
            computed.expectedRevision !== (read.current?.entry.revision ?? null) ||
            !jsonEquals(summary, expectedSummary)) {
            throw new TypeError(
                'Group presence summary write differs from canonical predecessor projection',
            );
        }
    }
    if (read.current) {
        const comparison = compareGroupCausalRevision(
            summary.causalRevision,
            read.current.value.causalRevision,
        );
        if (computed.outcome === 'write' && comparison !== 'dominates') {
            throw new TypeError('Group presence summary write must advance its causal tuple');
        }
        if (
            comparison === 'equal' &&
            !jsonEquals(summaryContent(summary), summaryContent(read.current.value))
        ) {
            throw new TypeError('Equal group presence summary tuple has different content');
        }
    }
}

function deriveGroupPresenceSummaryContent(
    read: GroupPresenceSummaryRead,
    nowEpochMs: number,
): ReturnType<typeof summaryContent> {
    const groupActive = read.group.value.status === 'active' &&
        (read.group.value.expiresAtEpochMs === null ||
            read.group.value.expiresAtEpochMs > nowEpochMs);
    const activeMemberIds = new Set(read.members
        .map((stored) => stored.value)
        .filter((member) => member.status === 'active')
        .map((member) => member.principalId));
    const admitted = new Set(read.admissions.flatMap(({ value: admission }) =>
        admission.admittedSessions.map((session) =>
            admissionIdentity(admission.principalId, session)
        )
    ));
    const activeSessions = (groupActive
        ? read.presenceSessions.map(({ value }) => value).filter((session) =>
            activeMemberIds.has(session.principalId) &&
            admitted.has(admissionIdentity(session.principalId, session)) &&
            session.disconnectedAtEpochMs === null &&
            session.expiresAtEpochMs > nowEpochMs
        )
        : [])
        .toSorted((left, right) =>
            left.sessionId.localeCompare(right.sessionId) ||
            left.generationVersion - right.generationVersion
        );
    const activePrincipalIds = [...new Set(
        activeSessions.map((session) => session.principalId),
    )].toSorted();
    return {
        activePrincipalIds,
        activeSessionIds: activeSessions.map((session) => session.sessionId),
        activeSessions,
        activePrincipalCount: activePrincipalIds.length,
        activeSessionCount: activeSessions.length,
    };
}

function validateGroupPresenceSummaryReadCollections(
    ref: GroupRef,
    read: GroupPresenceSummaryRead,
): void {
    for (const [label, values] of [
        ['members', read.members],
        ['admissions', read.admissions],
        ['presence sessions', read.presenceSessions],
    ] as const) {
        if (!Array.isArray(values)) {
            throw new TypeError(`Group presence summary ${label} must be an array`);
        }
    }
    const memberIds = new Set<string>();
    for (const stored of read.members) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary member',
            groupStateMemberStorageKey({
                ...ref,
                principalId: stored.value.principalId,
            }),
        );
        validateStoredMember(stored.value, ref, 'Stored summary member');
        if (memberIds.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary member principal is duplicated');
        }
        memberIds.add(stored.value.principalId);
    }
    const activeMembers = read.members.map(({ value }) => value)
        .filter((member) => member.status === 'active');
    const activeOwners = activeMembers.filter((member) => member.role === 'owner');
    if (read.group.value.activeMemberCount !== activeMembers.length ||
        activeOwners.length !== 1 ||
        activeOwners[0]?.principalId !== read.group.value.ownerPrincipalId) {
        throw new TypeError('Group presence summary roster facts are inconsistent');
    }

    const admissionPrincipals = new Set<string>();
    const admittedSessionOwners = new Map<string, string>();
    for (const stored of read.admissions) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary admission',
            groupStatePresenceAdmissionStorageKey({
                ...ref,
                principalId: stored.value.principalId,
            }),
        );
        validatePresenceAdmission(stored.value, ref);
        if (admissionPrincipals.has(stored.value.principalId)) {
            throw new TypeError('Group presence summary admission principal is duplicated');
        }
        admissionPrincipals.add(stored.value.principalId);
        for (const session of stored.value.admittedSessions) {
            const existing = admittedSessionOwners.get(session.sessionId);
            if (existing !== undefined && existing !== stored.value.principalId) {
                throw new TypeError('Group presence summary session has multiple principals');
            }
            admittedSessionOwners.set(session.sessionId, stored.value.principalId);
        }
    }

    const sessionsById = new Map<string, GroupPresenceSession>();
    for (const stored of read.presenceSessions) {
        validateRuntimeEntryValue(
            stored,
            'Stored summary presence session',
            groupStatePresenceSessionStorageKey({
                ...ref,
                sessionId: stored.value.sessionId,
            }),
        );
        validatePresenceSession(stored.value, ref, 'Stored summary presence session');
        if (sessionsById.has(stored.value.sessionId)) {
            throw new TypeError('Group presence summary sessionId is duplicated');
        }
        sessionsById.set(stored.value.sessionId, stored.value);
    }
    for (const stored of read.admissions) {
        for (const admitted of stored.value.admittedSessions) {
            const session = sessionsById.get(admitted.sessionId);
            if (!session) continue;
            if (session.principalId !== stored.value.principalId ||
                session.generationId !== admitted.generationId ||
                session.generationVersion !== admitted.generationVersion ||
                session.connectedAtEpochMs !== admitted.connectedAtEpochMs) {
                throw new TypeError(
                    'Group presence summary admission differs from stored generation',
                );
            }
        }
    }
}




function actorPrincipalId(actor: MutationActor): string | null {
    return actor.kind === 'service' ? null : actor.principalId;
}

function actorSessionId(actor: MutationActor): string | null {
    return actor.kind === 'session' ? actor.sessionId : null;
}

function summaryContent(summary: GroupPresenceSummary): Readonly<{
    activePrincipalIds: readonly string[];
    activeSessionIds: readonly string[];
    activeSessions: readonly GroupPresenceSession[];
    activePrincipalCount: number;
    activeSessionCount: number;
}> {
    return {
        activePrincipalIds: summary.activePrincipalIds,
        activeSessionIds: summary.activeSessionIds,
        activeSessions: summary.activeSessions,
        activePrincipalCount: summary.activePrincipalCount,
        activeSessionCount: summary.activeSessionCount,
    };
}

export { compareGroupCausalRevision };

function validateFacts(facts: GroupMutationFacts): void {
    requireJsonSafe(facts, 'Group mutation facts');
    assertExactKeys(facts as unknown as Record<string, unknown>, [
        'nowEpochMs', 'expireAtEpochMs', 'serviceId', 'eventId', 'commandHash', 'resolvedJoinCode',
        'joinCodeVerifier', 'internalAuthority', 'authenticatedAuthority',
        'attemptCount',
    ], 'Group mutation facts');
    if (!Number.isSafeInteger(facts.nowEpochMs) || facts.nowEpochMs < 0) {
        throw new TypeError('Group mutation timestamp is invalid');
    }
    if (!Number.isSafeInteger(facts.expireAtEpochMs) ||
        facts.expireAtEpochMs <= facts.nowEpochMs) {
        throw new TypeError('Group mutation expiry timestamp is invalid');
    }
    requirePositiveSafeInteger(facts.attemptCount, 'Group mutation attemptCount');
    requireNonEmptyString(facts.serviceId, 'Group mutation serviceId');
    requireNonEmptyString(facts.eventId, 'Group mutation eventId');
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('Group mutation commandHash is invalid');
    }
    if (!['none', 'expiry', 'session-cleanup'].includes(facts.internalAuthority)) {
        throw new TypeError('Group mutation internal authority is invalid');
    }
    if (facts.authenticatedAuthority !== null) {
        const authority = requireRecord(
            facts.authenticatedAuthority,
            'Group mutation authenticated authority',
        );
        assertExactKeys(authority, ['principalId', 'sessionId'],
            'Group mutation authenticated authority');
        requireNonEmptyString(authority.principalId,
            'Group mutation authenticated authority principalId');
        requireNonEmptyString(authority.sessionId,
            'Group mutation authenticated authority sessionId');
    }
    if (facts.joinCodeVerifier !== null) {
        requireNonEmptyString(facts.joinCodeVerifier,
            'Group mutation joinCodeVerifier');
    }
    if (facts.resolvedJoinCode !== null) {
        requireNonEmptyString(facts.resolvedJoinCode,
            'Group mutation resolvedJoinCode');
    }
    if ((facts.resolvedJoinCode === null) !== (facts.joinCodeVerifier === null)) {
        throw new TypeError('Group mutation resolved join code and verifier differ');
    }
    if (facts.internalAuthority !== 'none' && facts.authenticatedAuthority !== null) {
        throw new TypeError('Internal group authority cannot also be authenticated authority');
    }
}

function validateTrustedAuthorityMode(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
): void {
    validateResolvedJoinCodeFacts(command, facts);
    const authority = facts.authenticatedAuthority;
    if (facts.internalAuthority === 'none' && authority === null) {
        throw new TypeError(
            'User group mutation requires authenticated authority facts',
        );
    }
    if (facts.internalAuthority !== 'none') {
        if (authority !== null) {
            throw new TypeError(
                'Internal group mutation cannot use authenticated authority facts',
            );
        }
        if (command.operation !== 'disconnectPresence') {
            throw new TypeError(
                'Internal group authority is limited to presence maintenance',
            );
        }
        if (command.input.actorPrincipalId !== null ||
            command.input.actorSessionId !== null) {
            throw new TypeError(
                'Internal group maintenance cannot claim semantic actor authority',
            );
        }
        if (facts.internalAuthority === 'expiry' && command.input.reason !== 'expired') {
            throw new TypeError('Group expiry authority requires an expiry command');
        }
        if (facts.internalAuthority === 'session-cleanup' &&
            command.input.reason !== null) {
            throw new TypeError('Group session cleanup authority has invalid command facts');
        }
        return;
    }
    if (!authority) {
        throw new TypeError('Authenticated group mutation authority is missing');
    }
    if (command.input.actorPrincipalId !== authority.principalId ||
        command.input.actorSessionId !== authority.sessionId) {
        throw new TypeError('Group mutation actor differs from authenticated authority');
    }
}

function validateResolvedJoinCodeFacts(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
): void {
    if (command.operation === 'rotateGroupJoinCode') {
        if (facts.resolvedJoinCode === null || facts.joinCodeVerifier === null) {
            throw new TypeError('Group rotate mutation is missing its generated join code facts');
        }
        if (command.input.joinCode !== null &&
            facts.resolvedJoinCode !== command.input.joinCode) {
            throw new TypeError(
                'Group rotate resolved join code differs from explicit command intent',
            );
        }
        return;
    }
    if (command.operation === 'joinGroup' || command.operation === 'acceptGroupInvite') {
        if (facts.resolvedJoinCode !== command.input.joinCode) {
            throw new TypeError('Group resolved join code differs from join command intent');
        }
        return;
    }
    if (facts.resolvedJoinCode !== null || facts.joinCodeVerifier !== null) {
        throw new TypeError('Unrelated group operation contains resolved join code facts');
    }
}

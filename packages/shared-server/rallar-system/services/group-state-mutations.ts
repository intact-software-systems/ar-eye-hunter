import type {
    AuditStamp,
    Group,
    GroupEvent,
    GroupEventType,
    GroupJoinMode,
    GroupMember,
    GroupPresenceAdmission,
    GroupMemberStatus,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    GroupStateCausalRevision,
    GroupStatus,
} from '@shared/api/group-types.ts';
import {
    compareGroupCausalRevision,
    toGroupSnapshotStateRevision,
} from '@shared/api/group-client-views.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import {
    canActivateGroupMember,
    canConnectGroupPresenceSession,
    canGovernGroupMember,
    canJoinGroup,
    canMutateActiveGroup,
    type GroupGovernanceAction,
    GroupPolicyDeniedError,
} from '../group-policy.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import {
    computeGroupPresenceSummaryEntry,
    GROUP_PRESENCE_SUMMARY_TOPIC,
    type GroupPresenceSummaryWorkData,
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import {
    createRallarGroupDirectorAppointment,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorAppointment,
    readRallarGroupDirectorFromSnapshot,
    resolveRallarGroupDirectorAppointmentEligibility,
} from '@shared/api/group-director.ts';
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
    GroupGuardCandidate,
    PresenceAdmissionCandidate,
    PresenceGuardCandidate,
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
    validateCommandHash,
    validateGroupMutationIdempotencyRecord,
    validateMutationReceipt,
} from '../group-state/mutation/group-mutation-result.ts';
import {
    validateStoredGroup,
    validateStoredMember,
} from '../group-state/persistence/validate-persisted-group.ts';
import {
    compareGenerationOrder,
    validatePresenceAdmission,
    validatePresenceSession,
    validatePresenceSummaryValue,
    validateStoredGeneration,
} from '../group-state/persistence/validate-persisted-group-presence.ts';
import {
    toExpiredAwareInsertCandidate,
} from './group-expired-state-authority.ts';
import { type InitialGroupPresenceSummaryCandidate, nextInitialGroupSnapshotVersion,
    toInitialGroupPresenceSummaryCandidate, validateInitialGroupPresenceSummaryCandidate } from './group-initial-presence-summary.ts';
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

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GROUP_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_GROUP_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';
const RALLAR_GROUP_JOIN_CODE_VERSION = 1;

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

function computeCreate(
    command: Extract<GroupMutationCommand, { operation: 'createGroup' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    if (command.input.actorPrincipalId !== command.input.createdByPrincipalId) {
        return rejected(command, read, facts, 'Creator authority does not match createdByPrincipalId');
    }
    if (read.group) {
        return rejected(command, read, facts, `Group already exists: ${command.aggregateRef.groupId}`);
    }
    const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
    const snapshotVersion = nextInitialGroupSnapshotVersion(read.expiredGroupEntry, read.presenceSummary);
    const group: Group = {
        ...command.aggregateRef,
        slug: command.input.slug, displayName: command.input.displayName,
        description: command.input.description, kind: command.input.kind,
        status: 'active', joinMode: command.input.joinMode,
        maxMembers: command.input.maxMembers, maxSessionsPerMember: command.input.maxSessionsPerMember,
        metadata: cloneRecord(command.input.metadata),
        activeMemberCount: 1,
        ownerPrincipalId: command.input.createdByPrincipalId,
        snapshotVersion, metadataVersion: 1,
        rosterVersion: 1, presenceVersion: 0,
        created: audit, updated: audit,
        archived: null,
        deleted: null,
        expiresAtEpochMs: command.input.expiresAtEpochMs,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: command.input.purgeAfterEpochMs,
    };
    const owner: GroupMember = {
        ...command.aggregateRef,
        principalId: command.input.createdByPrincipalId,
        role: 'owner',
        status: 'active',
        joined: audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
    };
    const summary: GroupPresenceSummary = {
        ...command.aggregateRef,
        causalRevision: { groupRevision: snapshotVersion,
            presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0 },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: facts.nowEpochMs,
    };
    return writeResult(command, read, facts, {
        guard: {
            kind: 'group',
            ...toExpiredAwareInsertCandidate(read.expiredGroupEntry, group),
        },
        members: [owner],
        initialPresenceSummary: toInitialGroupPresenceSummaryCandidate(summary, read.presenceSummary),
        presenceAdmission: null,
        eventType: 'group-created',
    });
}

function computeUpdate(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertUpdateAuthority(command, read);
    const allowsArchivedDeletion = stored.value.status === 'archived' &&
        command.input.status === 'deleted';
    if (!allowsArchivedDeletion) {
        assertActive(stored.value, facts.nowEpochMs);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const current = stored.value;
    const status = command.input.status ?? current.status;
    const next = transitionGroupLifecycle({
        ...current,
        slug: command.input.slug ?? current.slug,
        displayName: command.input.displayName ?? current.displayName,
        description: command.input.description ?? current.description,
        kind: command.input.kind ?? current.kind,
        joinMode: command.input.joinMode ?? current.joinMode,
        maxMembers: command.input.maxMembers ?? current.maxMembers,
        maxSessionsPerMember:
            command.input.maxSessionsPerMember ?? current.maxSessionsPerMember,
        metadata: command.input.metadata === null
            ? current.metadata
            : cloneRecord(command.input.metadata),
        snapshotVersion: current.snapshotVersion + 1,
        metadataVersion: current.metadataVersion + 1,
        updated: audit,
        expiresAtEpochMs: command.input.expiresAtEpochMs ?? current.expiresAtEpochMs,
        emptySinceEpochMs: command.input.emptySinceEpochMs ?? current.emptySinceEpochMs,
        purgeAfterEpochMs: command.input.purgeAfterEpochMs ?? current.purgeAfterEpochMs,
    }, status, audit);
    if (next.maxMembers !== null && next.maxMembers < next.activeMemberCount) {
        throw new GroupMutationRejectedError(
            'Group maxMembers cannot be lower than activeMemberCount.',
        );
    }
    if (sameGroupIgnoringVersions(current, next)) return noOp(command, read, facts);
    return groupWrite(command, read, facts, next,
        status === 'archived' ? 'group-archived' :
        status === 'deleted' ? 'group-deleted' : 'group-updated');
}

function computeDirector(
    command: Extract<GroupMutationCommand, { operation: 'appointDirector' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    const principalId = command.input.actorPrincipalId;
    const sessionId = command.input.actorSessionId;
    if (!principalId || !sessionId) {
        throw new GroupMutationRejectedError(
            'Forbidden: Cannot appoint a director without a local session.',
        );
    }
    const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
    const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
        snapshot,
        principalId,
        sessionId,
    });
    if (!eligibility.allowed) {
        throw new GroupMutationRejectedError(
            `Forbidden: ${eligibility.reason ?? 'Cannot appoint the browser director.'}`,
        );
    }
    const appointment = createRallarGroupDirectorAppointment({
        session: { clientId: principalId, sessionId },
        previous: readRallarGroupDirectorFromSnapshot(snapshot),
        now: facts.nowEpochMs,
        heartbeatTtlMs: command.input.heartbeatTtlMs,
    });
    const next: Group = {
        ...stored.value,
        metadata: mergeRallarGroupDirectorMetadata(stored.value.metadata, appointment),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: auditStamp(command, facts, principalId),
    };
    return groupWrite(command, read, facts, next, 'group-updated');
}

function computeJoin(
    command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    assertPrincipalAuthority(command, command.targetPrincipalId);
    const stored = requireGroup(read, command.aggregateRef);
    const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
    const joinCodeMetadata = readJoinCode(stored.value.metadata);
    assertAllowed(canJoinGroup({
        snapshot,
        actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined,
        },
        nowEpochMs: facts.nowEpochMs,
        inviteToken: command.input.inviteToken ?? undefined,
        joinCode: command.input.joinCode ?? undefined,
        joinCodeVerifier: facts.joinCodeVerifier ?? undefined,
        expectedJoinCodeVerifier: stored.value.joinMode === 'code'
            ? joinCodeMetadata?.verifier ?? ''
            : undefined,
        joinCodeExpiresAtEpochMs: joinCodeMetadata?.expiresAtEpochMs,
    }));
    const existing = read.targetMember ?? undefined;
    if (existing?.status === 'active') return noOp(command, read, facts);
    const audit = auditStamp(command, facts, command.targetPrincipalId);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: existing?.role ?? 'member',
        status: 'active',
        joined: existing?.joined ?? audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: existing?.invitedByPrincipalId ?? null,
        invitationExpiresAtEpochMs:
            existing?.invitationExpiresAtEpochMs ?? null,
    };
    return memberWrite(command, read, facts, [member], 'member-joined');
}

function computeInvite(
    command: Extract<GroupMutationCommand, { operation: 'createGroupInvite' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'invite');
    const existing = findTargetMember(read);
    if (existing?.status === 'active') return noOp(command, read, facts);
    if (existing?.status === 'banned') {
        throw new GroupMutationRejectedError('Cannot invite a banned group member.');
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const member: GroupMember = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: existing?.role ?? 'member',
        status: 'invited',
        joined: null,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: command.input.actorPrincipalId,
        invitationExpiresAtEpochMs: command.input.invitationExpiresAtEpochMs ??
            facts.nowEpochMs + DEFAULT_GROUP_INVITE_TTL_MS,
    };
    return memberWrite(command, read, facts, [member], 'member-invited');
}

function computeRevokeInvite(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'remove');
    const existing = findTargetMember(read);
    if (existing?.status !== 'invited') return noOp(command, read, facts);
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    return memberWrite(command, read, facts, [transitionMemberLifecycle({
        ...existing,
        updated: audit,
    }, 'left', audit)], 'member-left');
}

function computeRotateJoinCode(
    command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'invite');
    const materialized = materializedRotateJoinCode(command, facts);
    if (!facts.joinCodeVerifier) {
        throw new GroupMutationRejectedError('Join code verifier is required');
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const next: Group = {
        ...stored.value,
        metadata: mergeJoinCode(stored.value.metadata, {
            version: RALLAR_GROUP_JOIN_CODE_VERSION,
            verifier: facts.joinCodeVerifier,
            expiresAtEpochMs: materialized.expiresAtEpochMs,
            rotatedAtEpochMs: facts.nowEpochMs,
        }),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: audit,
    };
    return groupWrite(command, read, facts, next, 'group-updated');
}

function materializedRotateJoinCode(
    command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
    facts: GroupMutationFacts,
): Readonly<{ joinCode: string; expiresAtEpochMs: number }> {
    const joinCode = command.input.joinCode ?? facts.resolvedJoinCode;
    const expiresAtEpochMs = command.input.expiresAtEpochMs ??
        facts.nowEpochMs + DEFAULT_GROUP_JOIN_CODE_TTL_MS;
    if (!joinCode || !Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= 0) {
        throw new GroupMutationRejectedError(
            'Join code defaults could not be materialized safely',
        );
    }
    return { joinCode, expiresAtEpochMs };
}

function computeGovernedMember(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const action: GroupGovernanceAction = command.operation === 'banGroupMember'
        ? 'ban'
        : command.operation === 'unbanGroupMember'
        ? 'unban'
        : command.operation === 'setGroupMemberRole'
        ? 'promote'
        : 'remove';
    assertGovernance(command, read, facts, action);
    const existing = findTargetMember(read);
    if (!existing && command.operation === 'unbanGroupMember') return noOp(command, read, facts);
    if (!existing && command.operation === 'setGroupMemberRole') {
        throw new GroupMutationRejectedError(`Group member not found: ${command.targetPrincipalId}`);
    }
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const base: GroupMember = existing ?? {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role: 'member',
        status: 'left',
        joined: null,
        updated: audit,
        left: audit,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
    };
    const status = command.operation === 'banGroupMember'
        ? 'banned'
        : command.operation === 'unbanGroupMember'
        ? 'left'
        : command.operation === 'removeGroupMember'
        ? 'removed'
        : base.status;
    const role = command.operation === 'setGroupMemberRole'
        ? command.input.role
        : base.role;
    if (command.operation === 'setGroupMemberRole' && role === 'owner') {
        throw new GroupMutationRejectedError(
            'Ownership can only change through transferGroupOwnership.',
        );
    }
    if (
        command.operation === 'setGroupMemberRole' && role === 'admin' &&
        read.actorMember?.role === 'admin' && base.role !== 'admin'
    ) {
        throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
    }
    if (base.status === status && base.role === role) return noOp(command, read, facts);
    assertNotLastOwner(requireGroup(read, command.aggregateRef).value, base, status, role);
    const member = transitionMemberLifecycle({
        ...base,
        role,
        updated: audit,
    }, status, audit);
    const eventType: GroupEventType = command.operation === 'banGroupMember'
        ? 'member-banned'
        : command.operation === 'unbanGroupMember'
        ? 'member-unbanned'
        : command.operation === 'setGroupMemberRole'
        ? 'member-role-changed'
        : 'member-removed';
    return memberWrite(command, read, facts, [member], eventType);
}

function computeTransfer(
    command: Extract<GroupMutationCommand, { operation: 'transferGroupOwnership' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertGovernance(command, read, facts, 'transfer-ownership');
    const actor = read.actorMember ?? undefined;
    const target = findTargetMember(read);
    if (!actor || actor.status !== 'active' || actor.role !== 'owner') {
        throw new GroupMutationRejectedError('Only an active owner can transfer ownership.');
    }
    if (!target || target.status !== 'active') {
        throw new GroupMutationRejectedError('Ownership target must be active.');
    }
    if (actor.principalId === target.principalId) return noOp(command, read, facts);
    const audit = auditStamp(command, facts, actor.principalId);
    return memberWrite(command, read, facts, [
        { ...actor, role: 'admin', updated: audit },
        { ...target, role: 'owner', updated: audit },
    ], 'ownership-transferred');
}

function computeUpsertMember(
    command: Extract<GroupMutationCommand, { operation: 'upsertMember' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const isSelf = command.input.actorPrincipalId === command.targetPrincipalId;
    if (!isSelf) {
        assertGovernance(command, read, facts,
            command.input.status === 'banned' ? 'ban' : 'promote');
    } else {
        assertPrincipalAuthority(command, command.targetPrincipalId);
        if (command.input.status !== 'active' && command.input.status !== 'left') {
            throw new GroupMutationRejectedError(
                'Self upsert may only join or leave the group.',
            );
        }
        if (command.input.role !== null &&
            command.input.role !== (read.targetMember?.role ?? 'member')) {
            throw new GroupMutationRejectedError('Self upsert cannot change role.');
        }
    }
    if (command.input.role === 'owner') {
        throw new GroupMutationRejectedError(
            'Ownership can only change through transferGroupOwnership.',
        );
    }
    if (
        !isSelf && command.input.role === 'admin' &&
        read.actorMember?.role === 'admin' && read.targetMember?.role !== 'admin'
    ) {
        throw new GroupMutationRejectedError('Group admins cannot grant the admin role.');
    }
    const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
    if (command.input.status === 'active') {
        assertAllowed(command.input.actorPrincipalId === command.targetPrincipalId
            ? canJoinGroup({
                snapshot,
                actor: {
                    principalId: command.input.actorPrincipalId ?? undefined,
                    sessionId: command.input.actorSessionId ?? undefined,
                },
                nowEpochMs: facts.nowEpochMs,
            })
            : canActivateGroupMember({
                snapshot,
                targetPrincipalId: command.targetPrincipalId,
                nowEpochMs: facts.nowEpochMs,
            }));
    }
    const existing = findTargetMember(read);
    const role = command.input.role ?? existing?.role ?? 'member';
    const invitedByPrincipalId =
        command.input.invitedByPrincipalId ?? existing?.invitedByPrincipalId ?? null;
    const invitationExpiresAtEpochMs =
        command.input.invitationExpiresAtEpochMs ??
        existing?.invitationExpiresAtEpochMs ?? null;
    if (
        existing &&
        existing.status === command.input.status &&
        existing.role === role &&
        existing.invitedByPrincipalId === invitedByPrincipalId &&
        existing.invitationExpiresAtEpochMs === invitationExpiresAtEpochMs
    ) {
        return noOp(command, read, facts);
    }
    const audit = auditStamp(command, facts,
        command.input.actorPrincipalId ?? command.targetPrincipalId);
    const member = transitionMemberLifecycle({
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        role,
        joined: existing?.joined ?? audit,
        updated: audit,
        left: existing?.left ?? null,
        removed: existing?.removed ?? null,
        banned: existing?.banned ?? null,
        invitedByPrincipalId,
        invitationExpiresAtEpochMs,
    }, command.input.status, audit);
    if (existing && jsonEquals(existing, member)) return noOp(command, read, facts);
    assertNotLastOwner(requireGroup(read, command.aggregateRef).value,
        existing, member.status, member.role);
    return memberWrite(command, read, facts, [member], memberEventType(member.status));
}

function computeConnectPresence(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertPrincipalAuthority(command, command.input.principalId);
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') {
        throw new GroupMutationRejectedError(
            `Forbidden: active group member required for presence: ${command.input.principalId}`,
        );
    }
    assertAllowed(canConnectGroupPresenceSession({
        snapshot: toPolicySnapshot(read, facts.nowEpochMs),
        actor: {
            principalId: command.input.principalId,
            sessionId: command.input.actorSessionId ?? undefined,
        },
        sessionId: command.sessionId,
        nowEpochMs: facts.nowEpochMs,
    }));
    const existing = read.targetPresence;
    const connectedAt = existing?.value.generationId === command.input.generationId &&
            command.input.connectedAtEpochMs === null
        ? existing.value.connectedAtEpochMs
        : command.input.connectedAtEpochMs ?? facts.nowEpochMs;
    requirePositiveSafeInteger(connectedAt, 'Group presence connectedAtEpochMs');
    // connectedAt is the durable generation version. The generation id only
    // breaks equal-timestamp ties, so every writer derives the same total order.
    const incomingOrder = [connectedAt, command.input.generationId] as const;
    if (existing) {
        validateStoredGeneration(existing.value);
        if (existing.value.principalId !== command.input.principalId) {
            throw new GroupMutationRejectedError(
                'A presence session cannot be reassigned to another principal.',
            );
        }
        const currentOrder = [
            existing.value.generationVersion,
            existing.value.generationId,
        ] as const;
        const order = compareGenerationOrder(incomingOrder, currentOrder);
        if (order < 0) return noOp(command, read, facts);
        if (order === 0 && existing.value.disconnectedAtEpochMs !== null) {
            return noOp(command, read, facts);
        }
        if (
            existing.value.generationId === command.input.generationId &&
            command.input.connectedAtEpochMs !== null &&
            connectedAt !== existing.value.connectedAtEpochMs
        ) {
            throw new GroupMutationRejectedError(
                'A generationId cannot be reused with a different connectedAtEpochMs.',
            );
        }
    }
    const sameGeneration = existing !== null &&
        existing.value.generationId === command.input.generationId &&
        existing.value.generationVersion === connectedAt;
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    const expiresAt = command.input.expiresAtEpochMs ??
        facts.nowEpochMs + DEFAULT_GROUP_SESSION_TTL_MS;
    if (heartbeatAt < connectedAt || expiresAt < heartbeatAt) {
        throw new GroupMutationRejectedError(
            'Presence connection timestamps are causally inconsistent.',
        );
    }
    const session: GroupPresenceSession = {
        ...command.aggregateRef,
        sessionId: command.sessionId,
        principalId: command.input.principalId,
        generationId: command.input.generationId,
        generationVersion: connectedAt,
        connectedAtEpochMs: sameGeneration
            ? existing.value.connectedAtEpochMs
            : connectedAt,
        lastHeartbeatAtEpochMs: sameGeneration
            ? Math.max(existing.value.lastHeartbeatAtEpochMs, heartbeatAt)
            : heartbeatAt,
        expiresAtEpochMs: sameGeneration
            ? Math.max(existing.value.expiresAtEpochMs, expiresAt)
            : expiresAt,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
    if (existing && jsonEquals(existing.value, session)) return noOp(command, read, facts);
    const admission = admissionForConnect(command, read, session, facts);
    return presenceWrite(command, read, facts, session,
        existing ? 'update' : 'insert', 'session-connected', admission);
}

function computeHeartbeatPresence(
    command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const group = requireGroup(read, command.aggregateRef);
    assertActive(group.value, facts.nowEpochMs);
    const existing = read.targetPresence;
    if (!existing) throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
    assertPresenceAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        existing.value.disconnectedAtEpochMs !== null
    ) return noOp(command, read, facts);
    if (!isExactlyAdmitted(read.targetAdmission?.value, existing.value)) {
        return noOp(command, read, facts);
    }
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') return noOp(command, read, facts);
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (heartbeatAt < existing.value.lastHeartbeatAtEpochMs) return noOp(command, read, facts);
    const expiresAt = Math.max(
        existing.value.expiresAtEpochMs,
        command.input.expiresAtEpochMs ?? existing.value.expiresAtEpochMs,
    );
    if (expiresAt < heartbeatAt) {
        throw new GroupMutationRejectedError(
            'Presence heartbeat expiry must not predate the heartbeat.',
        );
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: expiresAt,
    };
    if (jsonEquals(existing.value, session)) return noOp(command, read, facts);
    return presenceWrite(command, read, facts, session, 'update', 'session-heartbeat');
}

function computeDisconnectPresence(
    command: Extract<GroupMutationCommand, { operation: 'disconnectPresence' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const existing = read.targetPresence;
    if (!existing) {
        if (facts.internalAuthority === 'expiry') return noOp(command, read, facts);
        throw new GroupMutationRejectedError(
            `Group presence session not found: ${command.sessionId}`,
        );
    }
    assertPresenceAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        (command.input.generationVersion !== null &&
            existing.value.generationVersion !== command.input.generationVersion) ||
        (command.input.observedExpiresAtEpochMs !== null &&
            existing.value.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs) ||
        existing.value.disconnectedAtEpochMs !== null
    ) return noOp(command, read, facts);
    const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
    if (disconnectedAt < existing.value.lastHeartbeatAtEpochMs) {
        return noOp(command, read, facts);
    }
    if (facts.internalAuthority === 'expiry') {
        return presenceWrite(
            command,
            read,
            facts,
            existing.value,
            'delete',
            'session-disconnected',
            admissionForDisconnect(read, existing.value, facts),
        );
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        status: 'disconnected',
        disconnectedAtEpochMs: disconnectedAt,
        disconnectReason: command.input.reason ?? 'closed',
    };
    return presenceWrite(command, read, facts, session, 'update',
        'session-disconnected', admissionForDisconnect(read, existing.value, facts));
}

function groupWrite(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    group: Group,
    eventType: GroupEventType,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    return writeResult(command, read, facts, {
        guard: {
            kind: 'group',
            operation: 'update',
            value: group,
            expectedRevision: stored.entry.revision,
        },
        members: [],
        initialPresenceSummary: null,
        eventType,
    });
}

function memberWrite(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    members: readonly GroupMember[],
    eventType: GroupEventType,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const audit = auditStamp(command, facts,
        command.input.actorPrincipalId ?? undefined);
    let activeMemberCount = stored.value.activeMemberCount;
    for (const member of members) {
        const previous = findKnownMember(read, member.principalId);
        const previousActive = previous?.status === 'active';
        const nextActive = member.status === 'active';
        if (previousActive !== nextActive) {
            activeMemberCount += nextActive ? 1 : -1;
        }
    }
    if (!Number.isSafeInteger(activeMemberCount) || activeMemberCount < 0) {
        throw new TypeError('Group activeMemberCount delta is invalid');
    }
    const promotedOwner = members.find((member) =>
        member.status === 'active' && member.role === 'owner'
    );
    const ownerPrincipalId = eventType === 'ownership-transferred'
        ? promotedOwner?.principalId
        : stored.value.ownerPrincipalId;
    if (!ownerPrincipalId) {
        throw new TypeError('Group owner transition has no active owner');
    }
    for (const member of members) {
        if (member.principalId === ownerPrincipalId &&
            (member.status !== 'active' || member.role !== 'owner')) {
            throw new GroupMutationRejectedError(
                'Cannot remove or demote the active group owner.',
            );
        }
        if (member.status === 'active' && member.role === 'owner' &&
            member.principalId !== ownerPrincipalId) {
            throw new GroupMutationRejectedError(
                'Ownership can only change through a single guarded transfer.',
            );
        }
    }
    const group: Group = {
        ...stored.value,
        activeMemberCount,
        ownerPrincipalId,
        snapshotVersion: stored.value.snapshotVersion + 1,
        rosterVersion: stored.value.rosterVersion + 1,
        updated: audit,
    };
    return writeResult(command, read, facts, {
        guard: {
            kind: 'group',
            operation: 'update',
            value: group,
            expectedRevision: stored.entry.revision,
        },
        members,
        initialPresenceSummary: null,
        presenceAdmission: admissionForMemberWrite(read, members, facts),
        eventType,
    });
}

function presenceWrite(
    command: Extract<GroupMutationCommand, {
        operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';
    }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    session: GroupPresenceSession,
    operation: 'insert' | 'update' | 'delete',
    eventType: GroupEventType,
    presenceAdmission: PresenceAdmissionCandidate | null = null,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const guard = operation === 'insert'
        ? {
            kind: 'presence',
            ...toExpiredAwareInsertCandidate(read.expiredTargetPresenceEntry, session),
        } as const
        : operation === 'update'
        ? {
            kind: 'presence',
            operation: 'update',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision,
        } as const
        : {
            kind: 'presence',
            operation: 'delete',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision,
        } as const;
    return writeResult(command, read, facts, {
        guard,
        members: [],
        initialPresenceSummary: null,
        eventType,
        eventGroup: stored.value,
        presenceAdmission,
    });
}

function writeResult(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    input: Readonly<{
        guard: GroupGuardCandidate | PresenceGuardCandidate;
        members: readonly GroupMember[];
        initialPresenceSummary: InitialGroupPresenceSummaryCandidate | null;
        presenceAdmission?: PresenceAdmissionCandidate | null;
        eventType: GroupEventType;
        eventGroup?: Group;
    }>,
): GroupMutationComputed {
    const group = input.eventGroup ??
        (input.guard.kind === 'group' ? input.guard.value : requireGroup(read, command.aggregateRef).value);
    const groupRevision = group.snapshotVersion;
    const presenceRevision = read.presenceSummary?.value.causalRevision.presenceRevision ?? 0;
    const causalRevision = { groupRevision, presenceRevision };
    const event = newGroupEvent(
        input.eventType,
        group,
        causalRevision,
        command,
        facts,
    );
    const outboxEntry = computeGroupPresenceSummaryEntry({
        effectKind: 'group-presence-summary',
        aggregateRef: command.aggregateRef,
        commandId: command.commandId,
        createdAtEpochMs: facts.nowEpochMs,
        expireAtEpochMs: facts.expireAtEpochMs,
        acceptedCausalRevision: causalRevision,
        event,
    }, facts.serviceId);
    const receipt = receiptFor(command, facts, {
        outcome: 'applied',
        causalRevision,
        snapshotVersion: group.snapshotVersion,
        acceptedStorageRevision: input.guard.operation === 'insert'
            ? 0
            : input.guard.expectedRevision + 1,
        eventId: event.eventId,
        outboxIds: [outboxEntry.key.resourceId],
        rejection: null,
    });
    const idempotency = command.requestId === null ? null : {
        aggregateRef: command.aggregateRef,
        requestId: command.requestId,
        commandHash: facts.commandHash,
        receipt,
    };
    return {
        outcome: 'write',
        guard: input.guard,
        members: input.members,
        initialPresenceSummary: input.initialPresenceSummary,
        presenceAdmission: input.presenceAdmission ?? null,
        event,
        receipt,
        idempotency,
        outboxEntries: [outboxEntry],
    };
}

function noOp(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const causalRevision = currentCausalRevision(read);
    return {
        outcome: 'no-op',
        receipt: receiptFor(command, facts, {
            outcome: 'no-op',
            causalRevision,
            snapshotVersion: stored.value.snapshotVersion,
            acceptedStorageRevision: stored.entry.revision,
            eventId: null,
            outboxIds: [],
            rejection: null,
        }),
    };
}

function rejected(
    command: GroupMutationCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    message: string,
): GroupMutationComputed {
    const causalRevision = currentCausalRevision(read);
    return {
        outcome: 'rejected',
        receipt: receiptFor(command, facts, {
            outcome: 'rejected',
            causalRevision,
            snapshotVersion: read.group?.value.snapshotVersion ?? 0,
            acceptedStorageRevision: read.group?.entry.revision ?? null,
            eventId: null,
            outboxIds: [],
            rejection: message,
        }),
    };
}

function receiptFor(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    input: Readonly<{
        outcome: GroupMutationReceipt['outcome'];
        causalRevision: GroupStateCausalRevision;
        snapshotVersion: number;
        acceptedStorageRevision: number | null;
        eventId: string | null;
        outboxIds: readonly string[];
        rejection: string | null;
    }>,
): GroupMutationReceipt {
    const joinCode = command.operation === 'rotateGroupJoinCode'
        ? materializedRotateJoinCode(command, facts)
        : null;
    return {
        commandId: command.commandId,
        requestId: command.requestId,
        commandHash: facts.commandHash,
        aggregateRef: command.aggregateRef,
        outcome: input.outcome,
        attemptCount: facts.attemptCount,
        acceptedStorageRevision: input.acceptedStorageRevision,
        stateRevision: toGroupSnapshotStateRevision(
            input.causalRevision.groupRevision,
            input.causalRevision.presenceRevision,
        ),
        snapshotVersion: input.snapshotVersion,
        causalRevision: input.causalRevision,
        eventId: input.eventId,
        outboxIds: input.outboxIds,
        joinCode: joinCode?.joinCode ?? null,
        joinCodeExpiresAtEpochMs: joinCode?.expiresAtEpochMs ?? null,
        rejection: input.rejection,
    };
}

function currentCausalRevision(read: GroupMutationRead): GroupStateCausalRevision {
    return {
        groupRevision: read.group?.value.snapshotVersion ?? 0,
        presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0,
    };
}

function toPolicySnapshot(read: GroupMutationRead, nowEpochMs: number): GroupSnapshot {
    const stored = requireGroup(read, {
        applicationId: '',
        workspaceId: '',
        groupId: '',
    });
    const members = [
        read.actorMember,
        read.targetMember,
        read.authorityMember,
        read.directorMember,
    ]
        .filter((member): member is GroupMember => member !== null)
        .filter((member, index, values) =>
            values.findIndex((candidate) =>
                candidate.principalId === member.principalId
            ) === index
        );
    const targetSessions = read.targetPresence &&
        read.targetPresence.value.disconnectedAtEpochMs === null &&
        read.targetPresence.value.expiresAtEpochMs > nowEpochMs &&
        isExactlyAdmitted(read.targetAdmission?.value, read.targetPresence.value)
        ? [read.targetPresence.value]
        : [];
    const authoritySessions = read.authorityPresenceSessions.filter((session) =>
        session.disconnectedAtEpochMs === null &&
        session.expiresAtEpochMs > nowEpochMs &&
        (
            isExactlyAdmitted(read.authorityAdmission?.value, session) ||
            isExactlyAdmitted(read.directorAdmission?.value, session)
        )
    );
    const activeSessions = [...targetSessions, ...authoritySessions]
        .filter((session, index, sessions) =>
            sessions.findIndex((candidate) =>
                candidate.sessionId === session.sessionId &&
                candidate.generationId === session.generationId &&
                candidate.generationVersion === session.generationVersion
            ) === index
        );
    const activePrincipals = new Set(activeSessions.map((session) => session.principalId));
    const causalRevision = currentCausalRevision(read);
    return {
        stateRevision: toGroupSnapshotStateRevision(
            causalRevision.groupRevision,
            causalRevision.presenceRevision,
        ),
        causalRevision,
        group: {
            ...stored.value,
            presenceVersion: causalRevision.presenceRevision,
        },
        members,
        activeSessions,
        memberCount: stored.value.activeMemberCount,
        onlineMemberCount: members.filter((member) =>
            member.status === 'active' && activePrincipals.has(member.principalId)
        ).length,
    };
}

function requireGroup(
    read: GroupMutationRead,
    ref: GroupRef,
): RuntimeStateEntryValue<Group> {
    if (!read.group) throw new GroupMutationRejectedError(`Group not found: ${ref.groupId}`);
    return read.group;
}

function assertActive(group: Group, nowEpochMs: number): void {
    assertAllowed(canMutateActiveGroup({ group, nowEpochMs }));
}

function assertGovernance(
    command: Extract<GroupMutationCommand, { targetPrincipalId: string }> |
        Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts,
    action: GroupGovernanceAction,
): void {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    assertAllowed(canGovernGroupMember({
        snapshot: toPolicySnapshot(read, facts.nowEpochMs),
        actor: {
            principalId: command.input.actorPrincipalId ?? undefined,
            sessionId: command.input.actorSessionId ?? undefined,
        },
        targetPrincipalId: 'targetPrincipalId' in command
            ? command.targetPrincipalId
            : `${command.aggregateRef.groupId}:join-code`,
        action,
    }));
}

function assertAllowed(result: GroupPolicyResult): void {
    if (result.allowed) return;
    throw new GroupPolicyDeniedError(result);
}

function assertUpdateAuthority(
    command: Extract<GroupMutationCommand, { operation: 'updateGroup' }>,
    read: GroupMutationRead,
): void {
    const actor = read.actorMember;
    if (
        !command.input.actorPrincipalId ||
        actor?.principalId !== command.input.actorPrincipalId ||
        actor.status !== 'active' ||
        (actor.role !== 'owner' && actor.role !== 'admin')
    ) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'forbidden-role',
            message: 'Only active group owners/admins can update groups.',
        });
    }
}

function assertPrincipalAuthority(
    command: GroupMutationCommand,
    principalId: string,
): void {
    if (command.input.actorPrincipalId !== principalId) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'member-not-active',
            message: 'Mutation actor must match the authoritative principal.',
        });
    }
}

function assertPresenceAuthority(
    command: GroupMutationCommand,
    principalId: string,
    facts: GroupMutationFacts,
): void {
    if (facts.internalAuthority !== 'none') return;
    assertPrincipalAuthority(command, principalId);
}

function findKnownMember(
    read: GroupMutationRead,
    principalId: string,
): GroupMember | undefined {
    if (read.actorMember?.principalId === principalId) return read.actorMember;
    if (read.targetMember?.principalId === principalId) return read.targetMember;
    return undefined;
}

function admissionForConnect(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>,
    read: GroupMutationRead,
    session: GroupPresenceSession,
    facts: GroupMutationFacts,
): PresenceAdmissionCandidate {
    const current = read.targetAdmission;
    if (current) validatePresenceAdmission(current.value);
    const retained = (current?.value.admittedSessions ?? [])
        .filter((entry) => entry.sessionId !== session.sessionId);
    const admittedSessions = [...retained, {
        sessionId: session.sessionId,
        generationId: session.generationId,
        generationVersion: session.generationVersion,
        connectedAtEpochMs: session.connectedAtEpochMs,
    }].toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
    const cap = requireGroup(read, command.aggregateRef).value.maxSessionsPerMember;
    if (cap !== null && admittedSessions.length > cap) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'member-session-limit-reached',
            message: 'Group member session capacity has been reached.',
        });
    }
    const value: GroupPresenceAdmission = {
        ...command.aggregateRef,
        principalId: session.principalId,
        admittedSessions,
        updatedAtEpochMs: Math.max(
            current?.value.updatedAtEpochMs ?? 0,
            facts.nowEpochMs,
        ),
    };
    validatePresenceAdmission(value);
    return current
        ? { operation: 'update', value, expectedRevision: current.entry.revision }
        : { operation: 'insert', value };
}

function admissionForDisconnect(
    read: GroupMutationRead,
    session: GroupPresenceSession,
    facts: GroupMutationFacts,
): PresenceAdmissionCandidate | null {
    const current = read.targetAdmission;
    if (!current || !isExactlyAdmitted(current.value, session)) return null;
    const value: GroupPresenceAdmission = {
        ...current.value,
        admittedSessions: current.value.admittedSessions.filter((entry) =>
            entry.sessionId !== session.sessionId
        ),
        updatedAtEpochMs: Math.max(current.value.updatedAtEpochMs, facts.nowEpochMs),
    };
    validatePresenceAdmission(value);
    return {
        operation: 'update',
        value,
        expectedRevision: current.entry.revision,
    };
}

function admissionForMemberWrite(
    read: GroupMutationRead,
    members: readonly GroupMember[],
    facts: GroupMutationFacts,
): PresenceAdmissionCandidate | null {
    const current = read.targetAdmission;
    const target = members.find((member) => member.status !== 'active');
    if (!target) return null;
    if (current) {
        validatePresenceAdmission(current.value);
        if (current.value.principalId !== target.principalId) {
            throw new TypeError(
                'Presence admission predecessor differs from member authority target',
            );
        }
    }
    const previousUpdatedAt = current?.value.updatedAtEpochMs ?? 0;
    if (previousUpdatedAt >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Presence admission fence timestamp cannot advance');
    }
    const value: GroupPresenceAdmission = {
        ...commandRefForAdmission(target),
        admittedSessions: [],
        updatedAtEpochMs: Math.max(previousUpdatedAt + 1, facts.nowEpochMs),
    };
    validatePresenceAdmission(value);
    return current
        ? {
            operation: 'update',
            value,
            expectedRevision: current.entry.revision,
        }
        : { operation: 'insert', value };
}

function commandRefForAdmission(
    member: GroupMember,
): GroupRef & Readonly<{ principalId: string }> {
    return {
        applicationId: member.applicationId,
        workspaceId: member.workspaceId,
        groupId: member.groupId,
        principalId: member.principalId,
    };
}

function isExactlyAdmitted(
    admission: GroupPresenceAdmission | undefined,
    session: GroupPresenceSession,
): boolean {
    return admission?.principalId === session.principalId &&
        admission.admittedSessions.some((entry) =>
            entry.sessionId === session.sessionId &&
            entry.generationId === session.generationId &&
            entry.generationVersion === session.generationVersion
        ) === true;
}


function admissionIdentity(
    principalId: string,
    session: Pick<GroupPresenceSession, 'sessionId' | 'generationId' | 'generationVersion'>,
): string {
    return JSON.stringify([
        principalId,
        session.sessionId,
        session.generationId,
        session.generationVersion,
    ]);
}




function findTargetMember(
    read: GroupMutationRead,
): GroupMember | undefined {
    return read.targetMember ?? undefined;
}

function assertNotLastOwner(
    group: Group,
    existing: GroupMember | undefined,
    nextStatus: GroupMemberStatus,
    nextRole: GroupRole,
): void {
    if (!existing || existing.role !== 'owner' || existing.status !== 'active') return;
    if (nextStatus === 'active' && nextRole === 'owner') return;
    if (group.ownerPrincipalId === existing.principalId) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'last-owner',
            message: 'Cannot remove or demote the last active owner.',
        });
    }
}

function auditStamp(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    fallbackPrincipalId: string | undefined,
): AuditStamp {
    return {
        atEpochMs: facts.nowEpochMs,
        actor: mutationActor(command, facts, fallbackPrincipalId),
        reason: command.input.reason,
        traceId: command.input.traceId,
        requestId: command.requestId,
    };
}

function mutationActor(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    fallbackPrincipalId?: string,
): MutationActor {
    const principalId = command.input.actorPrincipalId ?? fallbackPrincipalId;
    if (command.input.actorSessionId !== null) {
        if (!principalId) {
            throw new GroupMutationRejectedError(
                'A session actor requires a principal identity.',
            );
        }
        return {
            kind: 'session',
            sessionId: command.input.actorSessionId,
            principalId,
        };
    }
    if (principalId) return { kind: 'principal', principalId };
    return { kind: 'service', serviceId: facts.serviceId };
}

function actorPrincipalId(actor: MutationActor): string | null {
    return actor.kind === 'service' ? null : actor.principalId;
}

function actorSessionId(actor: MutationActor): string | null {
    return actor.kind === 'session' ? actor.sessionId : null;
}

function transitionGroupLifecycle(
    group: Group,
    status: GroupStatus,
    audit: AuditStamp,
): Group {
    if (status === 'active') {
        return { ...group, status, archived: null, deleted: null };
    }
    if (status === 'archived') {
        return {
            ...group,
            status,
            archived: group.archived ?? audit,
            deleted: null,
        };
    }
    return {
        ...group,
        status,
        archived: group.archived,
        deleted: group.deleted ?? audit,
    };
}

function transitionMemberLifecycle(
    member: Omit<GroupMember, 'status' | 'left' | 'removed' | 'banned'> &
        Readonly<{
            left: AuditStamp | null;
            removed: AuditStamp | null;
            banned: AuditStamp | null;
        }>,
    status: GroupMemberStatus,
    audit: AuditStamp,
): GroupMember {
    if (status === 'invited') {
        return {
            ...member,
            status,
            joined: null,
            left: null,
            removed: null,
            banned: null,
        };
    }
    if (status === 'active') {
        return {
            ...member,
            status,
            joined: member.joined ?? audit,
            left: null,
            removed: null,
            banned: null,
        };
    }
    if (status === 'left') {
        return { ...member, status, left: audit, removed: null, banned: null };
    }
    if (status === 'removed') {
        return { ...member, status, left: null, removed: audit, banned: null };
    }
    return { ...member, status, left: null, removed: null, banned: audit };
}

function newGroupEvent(
    eventType: GroupEventType,
    group: Group,
    causalRevision: GroupStateCausalRevision,
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
): GroupEvent {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        eventId: facts.eventId,
        eventType,
        snapshotVersion: group.snapshotVersion,
        causalRevision,
        occurredAtEpochMs: facts.nowEpochMs,
        actor: mutationActor(command, facts),
        reason: command.input.reason,
        traceId: command.input.traceId,
        requestId: command.requestId,
        payload: {},
    };
}

function sameGroupIgnoringVersions(current: Group, next: Group): boolean {
    return jsonEquals(
        { ...current, snapshotVersion: 0, metadataVersion: 0, updated: null },
        { ...next, snapshotVersion: 0, metadataVersion: 0, updated: null },
    );
}

function memberEventType(status: GroupMemberStatus): GroupEventType {
    switch (status) {
        case 'invited': return 'member-invited';
        case 'active': return 'member-joined';
        case 'left': return 'member-left';
        case 'removed': return 'member-removed';
        case 'banned': return 'member-banned';
    }
}

type JoinCodeMetadata = Readonly<{
    version: number;
    verifier: string;
    expiresAtEpochMs: number;
    rotatedAtEpochMs: number;
}>;

function readJoinCode(metadata: Readonly<Record<string, unknown>>): JoinCodeMetadata | undefined {
    const value = metadata[RALLAR_GROUP_JOIN_CODE_METADATA_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.version === 'number' &&
            typeof candidate.verifier === 'string' &&
            typeof candidate.expiresAtEpochMs === 'number' &&
            typeof candidate.rotatedAtEpochMs === 'number'
        ? candidate as JoinCodeMetadata
        : undefined;
}

function mergeJoinCode(
    metadata: Readonly<Record<string, unknown>>,
    joinCode: JoinCodeMetadata,
): Record<string, unknown> {
    return { ...metadata, [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: joinCode };
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return structuredClone(value) as Record<string, unknown>;
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

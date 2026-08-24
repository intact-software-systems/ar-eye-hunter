import {
    assertExactKeys,
    requireJsonSafe,
    requireNonEmptyString,
    requirePositiveSafeInteger,
    requireRecord
} from '../../group-state-validation-primitives.ts';
import {
    computeCreate,
    computeDirector,
    computeRotateJoinCode,
    computeUpdate
} from '../aggregate/compute-group-aggregate-mutation.ts';
import { computeLifecycleTransition } from '../aggregate/compute-lifecycle-transition.ts';
import { validateGroupMutationCommand } from '../command-validation/validate-group-mutation-command.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationIdempotencyProbe,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import {
    computeDeclineGroupAdmission,
    computeGrantGroupAdmission
} from '../membership/compute-group-admission-mutation.ts';
import {
    computeGovernedMember,
    computeInvite,
    computeJoin,
    computeRevokeInvite,
    computeTransfer,
    computeUpsertMember
} from '../membership/compute-group-membership-mutation.ts';
import {
    computeConnectPresence,
    computeDisconnectPresence,
    computeHeartbeatPresence
} from '../presence/compute-group-presence-mutation.ts';
import { validateCommandHash } from '../result-validation/validate-group-mutation-result.ts';
import { validateGroupMutationRead } from '../state-validation/validate-group-mutation-read.ts';
export function computeGroupMutation(
    input: Readonly<{
        command: GroupMutationCommand;
        read: GroupMutationRead;
        facts: GroupMutationFacts;
    }>
): GroupMutationComputed {
    const { command, read, facts } = input;
    validateGroupMutationCommand(command);
    validateGroupMutationRead(read, command);
    validateFacts(facts);
    validateTrustedAuthorityMode(command, facts);
    const idempotency = probeGroupMutationIdempotency(command, read, facts.commandHash);
    if (idempotency.outcome !== 'miss') {
        return idempotency.outcome === 'replay'
            ? { ...idempotency, rejectionCode: null }
            : idempotency;
    }

    switch (command.operation) {
        case 'createGroup':
            return computeCreate(command, read, facts);
        case 'updateGroup':
            return computeUpdate(command, read, facts);
        case 'appointDirector':
            return computeDirector(command, read, facts);
        case 'startGroupEstablishment':
        case 'activateGroup':
        case 'reopenGroupEstablishment':
        case 'failGroupFormation':
            return computeLifecycleTransition(command, read, facts);
        case 'joinGroup':
        case 'acceptGroupInvite':
            return computeJoin(command, read, facts);
        case 'createGroupInvite':
            return computeInvite(command, read, facts);
        case 'revokeGroupInvite':
            return computeRevokeInvite(command, read, facts);
        case 'grantGroupAdmission':
            return computeGrantGroupAdmission(command, read, facts);
        case 'declineGroupAdmission':
            return computeDeclineGroupAdmission(command, read, facts);
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
    commandHash: string
): GroupMutationIdempotencyProbe {
    validateGroupMutationCommand(command);
    validateGroupMutationRead(read, command);
    validateCommandHash(commandHash, 'Group mutation commandHash');
    if (!read.idempotency) {
        return { outcome: 'miss' };
    }
    const record = read.idempotency.value;
    if (record.receipt.commandId !== command.commandId) {
        throw new TypeError('Stored group idempotency receipt command differs from command identity');
    }
    return record.commandHash === commandHash
        ? { outcome: 'replay', receipt: record.receipt }
        : {
            outcome: 'idempotency-conflict',
            existingCommandHash: record.commandHash,
            receivedCommandHash: commandHash
        };
}

export function validateFacts(facts: GroupMutationFacts): void {
    requireJsonSafe(facts, 'Group mutation facts');
    assertExactKeys(
        facts,
        [
            'nowEpochMs',
            'expireAtEpochMs',
            'serviceId',
            'eventId',
            'commandHash',
            'resolvedJoinCode',
            'joinCodeVerifier',
            'internalAuthority',
            'capacity',
            'authenticatedAuthority',
            'attemptCount'
        ],
        'Group mutation facts'
    );
    if (!Number.isSafeInteger(facts.nowEpochMs) || facts.nowEpochMs < 0) {
        throw new TypeError('Group mutation timestamp is invalid');
    }
    if (!Number.isSafeInteger(facts.expireAtEpochMs) || facts.expireAtEpochMs <= facts.nowEpochMs) {
        throw new TypeError('Group mutation expiry timestamp is invalid');
    }
    requirePositiveSafeInteger(facts.attemptCount, 'Group mutation attemptCount');
    requireNonEmptyString(facts.serviceId, 'Group mutation serviceId');
    requireNonEmptyString(facts.eventId, 'Group mutation eventId');
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('Group mutation commandHash is invalid');
    }
    const internalAuthorityModes = ['none', 'expiry', 'session-cleanup', 'formation-criterion'];
    if (!internalAuthorityModes.includes(facts.internalAuthority)) {
        throw new TypeError('Group mutation internal authority is invalid');
    }
    validateCapacityFacts(facts.capacity);
    validateAuthenticatedAuthority(facts.authenticatedAuthority);
    validateResolvedJoinCodePair(facts);
    if (facts.internalAuthority !== 'none' && facts.authenticatedAuthority !== null) {
        throw new TypeError('Internal group authority cannot also be authenticated authority');
    }
}

function validateCapacityFacts(capacity: GroupMutationFacts['capacity']): void {
    if (capacity === undefined) {
        return;
    }
    const record = requireRecord(capacity, 'Group mutation capacity facts');
    assertExactKeys(record, ['defaultMaxMembers'], 'Group mutation capacity facts');
    if (record.defaultMaxMembers === null) {
        return;
    }
    requirePositiveSafeInteger(record.defaultMaxMembers, 'Group mutation capacity defaultMaxMembers');
}

function validateAuthenticatedAuthority(
    authenticatedAuthority: GroupMutationFacts['authenticatedAuthority']
): void {
    if (authenticatedAuthority !== null) {
        const authority = requireRecord(
            authenticatedAuthority,
            'Group mutation authenticated authority'
        );
        assertExactKeys(
            authority,
            ['principalId', 'sessionId'],
            'Group mutation authenticated authority'
        );
        requireNonEmptyString(
            authority.principalId,
            'Group mutation authenticated authority principalId'
        );
        requireNonEmptyString(authority.sessionId, 'Group mutation authenticated authority sessionId');
    }
}

function validateResolvedJoinCodePair(facts: GroupMutationFacts): void {
    if (facts.joinCodeVerifier !== null) {
        requireNonEmptyString(facts.joinCodeVerifier, 'Group mutation joinCodeVerifier');
    }
    if (facts.resolvedJoinCode !== null) {
        requireNonEmptyString(facts.resolvedJoinCode, 'Group mutation resolvedJoinCode');
    }
    if ((facts.resolvedJoinCode === null) !== (facts.joinCodeVerifier === null)) {
        throw new TypeError('Group mutation resolved join code and verifier differ');
    }
}

export function validateTrustedAuthorityMode(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): void {
    validateResolvedJoinCodeFacts(command, facts);
    const authority = facts.authenticatedAuthority;
    if (facts.internalAuthority === 'none' && authority === null) {
        throw new TypeError('User group mutation requires authenticated authority facts');
    }
    if (facts.internalAuthority !== 'none') {
        if (authority !== null) {
            throw new TypeError('Internal group mutation cannot use authenticated authority facts');
        }
        if (facts.internalAuthority === 'formation-criterion') {
            if (
                command.operation !== 'activateGroup' &&
                command.operation !== 'failGroupFormation' &&
                command.operation !== 'startGroupEstablishment'
            ) {
                throw new TypeError('Formation-criterion authority is limited to criterion transitions');
            }
            if (
                (command.operation === 'activateGroup' || command.operation === 'failGroupFormation') &&
                command.input.observedRate === null
            ) {
                throw new TypeError('Criterion transitions must carry the observed rate');
            }
        }
        else if (command.operation !== 'disconnectPresence') {
            throw new TypeError('Internal group authority is limited to presence maintenance');
        }
        if (command.input.actorPrincipalId !== null || command.input.actorSessionId !== null) {
            throw new TypeError('Internal group maintenance cannot claim semantic actor authority');
        }
        if (facts.internalAuthority === 'expiry' && command.input.reason !== 'expired') {
            throw new TypeError('Group expiry authority requires an expiry command');
        }
        if (facts.internalAuthority === 'session-cleanup' && command.input.reason !== null) {
            throw new TypeError('Group session cleanup authority has invalid command facts');
        }
        return;
    }
    if (!authority) {
        throw new TypeError('Authenticated group mutation authority is missing');
    }
    if (
        command.input.actorPrincipalId !== authority.principalId ||
        command.input.actorSessionId !== authority.sessionId
    ) {
        throw new TypeError('Group mutation actor differs from authenticated authority');
    }
}

function validateResolvedJoinCodeFacts(
    command: GroupMutationCommand,
    facts: GroupMutationFacts
): void {
    if (command.operation === 'rotateGroupJoinCode') {
        if (facts.resolvedJoinCode === null || facts.joinCodeVerifier === null) {
            throw new TypeError('Group rotate mutation is missing its generated join code facts');
        }
        if (command.input.joinCode !== null && facts.resolvedJoinCode !== command.input.joinCode) {
            throw new TypeError('Group rotate resolved join code differs from explicit command intent');
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

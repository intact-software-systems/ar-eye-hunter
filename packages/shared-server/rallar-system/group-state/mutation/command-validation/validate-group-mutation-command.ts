import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

import {
    assertExactKeys,
    assertRequiredKeys,
    requireJsonSafe,
    requireNonEmptyString,
    requireNonNegativeSafeInteger,
    requireOneOf,
    requirePositiveSafeInteger,
    requireRecord,
    validateGroupRef
} from '../../group-state-validation-primitives.ts';
import type { GroupMutationCommand } from '../group-mutation-contracts.ts';
import { ACTOR_INPUT_KEYS } from './group-mutation-request-validation.ts';
import { validateExpectedLayoutIdentity } from './validate-expected-layout-identity.ts';

export function validateGroupMutationCommand(
    command: unknown
): asserts command is GroupMutationCommand {
    requireJsonSafe(command, 'Group mutation command');
    const value = requireRecord(command, 'Group mutation command');
    if ('commandHash' in value) {
        throw new TypeError('Group mutation command must not contain commandHash');
    }
    requireNonEmptyString(value.operation, 'Group mutation operation');
    if (!GROUP_MUTATION_OPERATIONS.has(value.operation)) {
        throw new TypeError('Group mutation operation is invalid');
    }
    const operation = value.operation as GroupMutationCommand['operation'];
    const hasTarget = TARGET_GROUP_MUTATION_OPERATIONS.has(operation);
    const hasSession = PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation);
    assertExactKeys(
        value,
        [
            'operation',
            'aggregateRef',
            'commandId',
            'requestId',
            'input',
            ...(hasTarget ? ['targetPrincipalId'] : []),
            ...(hasSession ? ['sessionId'] : [])
        ],
        'Group mutation command'
    );
    requireNonEmptyString(value.commandId, 'Group mutation commandId');
    if (value.requestId !== null) {
        requireNonEmptyString(value.requestId, 'Group mutation requestId');
    }
    validateGroupRef(value.aggregateRef);
    const input = requireRecord(value.input, 'Group mutation input');
    assertExactKeys(input, GROUP_MUTATION_INPUT_KEYS[operation], `Group ${operation} input`);
    for (const key of ['actorPrincipalId', 'actorSessionId', 'reason', 'traceId']) {
        if (input[key] !== null) {
            requireNonEmptyString(input[key], `Group mutation ${key}`);
        }
    }
    if ('sessionId' in value) {
        requireNonEmptyString(value.sessionId, 'Group session id');
    }
    if ('targetPrincipalId' in value) {
        requireNonEmptyString(value.targetPrincipalId, 'Group target principal id');
    }
    if (hasSession) {
        requireNonEmptyString(input.generationId, 'Group presence generationId');
    }
    validateOperationInput(operation, input);
}

function validateOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    if (AGGREGATE_GROUP_MUTATION_OPERATIONS.has(operation)) {
        validateAggregateOperationInput(operation, input);
        return;
    }
    if (PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation)) {
        validatePresenceOperationInput(operation, input);
        return;
    }
    validateMembershipOperationInput(operation, input);
}

function validateAggregateOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    switch (operation) {
        case 'createGroup':
            validateNullableString(input, 'slug');
            requireNonEmptyString(input.displayName, 'Group displayName');
            validateNullableString(input, 'description');
            requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
            requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
            validateNullableInteger(input, 'maxMembers', true);
            validateNullableInteger(input, 'maxSessionsPerMember', true);
            requireRecord(input.metadata, 'Group metadata');
            requireNonEmptyString(input.createdByPrincipalId, 'Group createdByPrincipalId');
            validateNullableInteger(input, 'expiresAtEpochMs', true);
            validateNullableInteger(input, 'purgeAfterEpochMs', true);
            if (input.lifecyclePolicy !== undefined) {
                requireRecord(input.lifecyclePolicy, 'Group lifecyclePolicy');
            }
            return;
        case 'updateGroup':
            validateNullableString(input, 'slug');
            validateNullableString(input, 'displayName');
            validateNullableString(input, 'description');
            if (input.kind !== null) {
                requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
            }
            if (input.status !== null) {
                requireOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status');
            }
            if (input.joinMode !== null) {
                requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
            }
            validateNullableInteger(input, 'maxMembers', true);
            validateNullableInteger(input, 'maxSessionsPerMember', true);
            if (input.metadata !== null) {
                requireRecord(input.metadata, 'Group metadata');
            }
            validateNullableInteger(input, 'expiresAtEpochMs', true);
            validateNullableInteger(input, 'emptySinceEpochMs', true);
            validateNullableInteger(input, 'purgeAfterEpochMs', true);
            return;
        case 'appointDirector':
            requirePositiveSafeInteger(input.heartbeatTtlMs, 'Group heartbeatTtlMs');
            return;
        case 'rotateGroupJoinCode':
            validateNullableString(input, 'joinCode');
            validateNullableInteger(input, 'expiresAtEpochMs', true);
            return;
        // The lifecycle inputs require key presence, not just no-extras: a
        // wire-decoded criterion command missing its fence keys is malformed
        // here, never a lying stale-epoch rejection deep in compute.
        case 'connectGroup':
        case 'applyPlannedLayout':
            assertRequiredKeys(input, GROUP_MUTATION_INPUT_KEYS[operation], `Group ${operation} input`);
            // The fences are non-null on this operation: null here is as
            // malformed as an absent key.
            requireNonNegativeSafeInteger(
                input.expectedFormationEpoch,
                `Group ${operation} expectedFormationEpoch`
            );
            if (input.expectedLayout === null) {
                throw new TypeError(`Group ${operation} expectedLayout must not be null`);
            }
            validateExpectedLayoutInput(input, operation);
            return;
        case 'startGroupEstablishment':
        case 'reopenGroupEstablishment':
        case 'planGroupLayout':
            assertRequiredKeys(input, GROUP_MUTATION_INPUT_KEYS[operation], `Group ${operation} input`);
            validateExpectedFormationEpochInput(input, operation);
            return;
        case 'activateGroup':
            assertRequiredKeys(input, GROUP_MUTATION_INPUT_KEYS[operation], `Group ${operation} input`);
            if (input.observedRate !== null && !isUnitIntervalNumber(input.observedRate)) {
                throw new TypeError('Group activateGroup observedRate must be null or within [0, 1]');
            }
            if (input.degraded !== null && typeof input.degraded !== 'boolean') {
                throw new TypeError('Group activateGroup degraded must be boolean or null');
            }
            validateExpectedFormationEpochInput(input, operation);
            validateExpectedLayoutInput(input, operation);
            return;
        // The valve carries no operation field at all, so the exact-key
        // assertion above is the whole contract; the arm is explicit because
        // the default one is for the membership families.
        case 'pauseGroupTransport':
        case 'resumeGroupTransport':
            return;
        case 'failGroupFormation':
            assertRequiredKeys(input, GROUP_MUTATION_INPUT_KEYS[operation], `Group ${operation} input`);
            if (!isUnitIntervalNumber(input.observedRate)) {
                throw new TypeError('Group failGroupFormation observedRate must be within [0, 1]');
            }
            validateExpectedFormationEpochInput(input, operation);
            validateExpectedLayoutInput(input, operation);
            return;
        default:
            return;
    }
}

type AggregateOperationInputRecord = Parameters<typeof validateAggregateOperationInput>[1];

function isUnitIntervalNumber(value: AggregateOperationInputRecord[string]): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateExpectedFormationEpochInput(
    input: AggregateOperationInputRecord,
    operation: string
): void {
    if (input.expectedFormationEpoch !== null) {
        requireNonNegativeSafeInteger(
            input.expectedFormationEpoch,
            `Group ${operation} expectedFormationEpoch`
        );
    }
}

function validateExpectedLayoutInput(
    input: AggregateOperationInputRecord,
    operation: string
): void {
    if (input.expectedLayout === null) {
        return;
    }
    validateExpectedLayoutIdentity(input, `Group ${operation} expectedLayout`);
}

function validateMembershipOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    switch (operation) {
        case 'joinGroup':
        case 'acceptGroupInvite':
            validateNullableString(input, 'inviteToken');
            validateNullableString(input, 'joinCode');
            return;
        case 'createGroupInvite':
            validateNullableInteger(input, 'invitationExpiresAtEpochMs', true);
            return;
        case 'setGroupMemberRole':
            requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
            return;
        case 'upsertMember':
            if (input.role !== null) {
                requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
            }
            // 'pending' is deliberately absent: only the admission decision may
            // compute it, never client input (plan decision 5.1).
            requireOneOf(
                input.status,
                ['invited', 'active', 'left', 'removed', 'banned'],
                'Group member status'
            );
            validateNullableString(input, 'invitedByPrincipalId');
            validateNullableInteger(input, 'invitationExpiresAtEpochMs', true);
            return;
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'grantGroupAdmission':
        case 'declineGroupAdmission':
        case 'transferGroupOwnership':
            return;
    }
}

function validatePresenceOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    if (operation === 'connectPresence') {
        requireNonEmptyString(input.principalId, 'Group presence principalId');
        validateNullableInteger(input, 'connectedAtEpochMs', true);
    }
    else {
        validateNullableString(input, 'principalId');
    }
    if (operation === 'disconnectPresence') {
        validateNullableInteger(input, 'generationVersion', true);
        validateNullableInteger(input, 'observedExpiresAtEpochMs', true);
        validateNullableInteger(input, 'disconnectedAtEpochMs', true);
    }
    validateNullableInteger(input, 'lastHeartbeatAtEpochMs', true);
    validateNullableInteger(input, 'expiresAtEpochMs', true);
}

function validateNullableString(input: Readonly<Record<string, unknown>>, key: string): void {
    if (input[key] !== null) {
        requireNonEmptyString(input[key], `Group ${key}`);
    }
}

function validateNullableInteger(
    input: Readonly<Record<string, unknown>>,
    key: string,
    positive = false
): void {
    const value = input[key];
    if (value === null) {
        return;
    }
    if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
        throw new TypeError(`Group ${key} is invalid`);
    }
}

const GROUP_MUTATION_OPERATIONS = new Set([
    'createGroup',
    'updateGroup',
    'appointDirector',
    'startGroupEstablishment',
    'planGroupLayout',
    'connectGroup',
    'activateGroup',
    'reopenGroupEstablishment',
    'failGroupFormation',
    'applyPlannedLayout',
    'pauseGroupTransport',
    'resumeGroupTransport',
    'joinGroup',
    'acceptGroupInvite',
    'createGroupInvite',
    'revokeGroupInvite',
    'grantGroupAdmission',
    'declineGroupAdmission',
    'rotateGroupJoinCode',
    'removeGroupMember',
    'banGroupMember',
    'unbanGroupMember',
    'setGroupMemberRole',
    'transferGroupOwnership',
    'upsertMember',
    'connectPresence',
    'heartbeatPresence',
    'disconnectPresence'
]);

const TARGET_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
    'joinGroup',
    'acceptGroupInvite',
    'createGroupInvite',
    'revokeGroupInvite',
    'grantGroupAdmission',
    'declineGroupAdmission',
    'removeGroupMember',
    'banGroupMember',
    'unbanGroupMember',
    'setGroupMemberRole',
    'transferGroupOwnership',
    'upsertMember'
]);

const PRESENCE_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
    'connectPresence',
    'heartbeatPresence',
    'disconnectPresence'
]);

const AGGREGATE_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
    'createGroup',
    'updateGroup',
    'appointDirector',
    'rotateGroupJoinCode',
    'startGroupEstablishment',
    'planGroupLayout',
    'connectGroup',
    'activateGroup',
    'reopenGroupEstablishment',
    'failGroupFormation',
    'applyPlannedLayout',
    'pauseGroupTransport',
    'resumeGroupTransport'
]);

const GROUP_MUTATION_INPUT_KEYS: Readonly<Record<GroupMutationCommand['operation'], readonly string[]>> = {
    createGroup: [
        ...ACTOR_INPUT_KEYS,
        'slug',
        'displayName',
        'description',
        'kind',
        'joinMode',
        'maxMembers',
        'maxSessionsPerMember',
        'metadata',
        'createdByPrincipalId',
        'expiresAtEpochMs',
        'purgeAfterEpochMs',
        'lifecyclePolicy'
    ],
    updateGroup: [
        ...ACTOR_INPUT_KEYS,
        'slug',
        'displayName',
        'description',
        'kind',
        'status',
        'joinMode',
        'maxMembers',
        'maxSessionsPerMember',
        'metadata',
        'expiresAtEpochMs',
        'emptySinceEpochMs',
        'purgeAfterEpochMs'
    ],
    appointDirector: [...ACTOR_INPUT_KEYS, 'heartbeatTtlMs'],
    startGroupEstablishment: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch'],
    planGroupLayout: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch'],
    connectGroup: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch', 'expectedLayout'],
    activateGroup: [...ACTOR_INPUT_KEYS, 'observedRate', 'degraded', 'expectedFormationEpoch', 'expectedLayout'],
    reopenGroupEstablishment: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch'],
    failGroupFormation: [...ACTOR_INPUT_KEYS, 'observedRate', 'expectedFormationEpoch', 'expectedLayout'],
    applyPlannedLayout: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch', 'expectedLayout'],
    pauseGroupTransport: ACTOR_INPUT_KEYS,
    resumeGroupTransport: ACTOR_INPUT_KEYS,
    joinGroup: [...ACTOR_INPUT_KEYS, 'inviteToken', 'joinCode'],
    acceptGroupInvite: [...ACTOR_INPUT_KEYS, 'inviteToken', 'joinCode'],
    createGroupInvite: [...ACTOR_INPUT_KEYS, 'invitationExpiresAtEpochMs'],
    revokeGroupInvite: ACTOR_INPUT_KEYS,
    grantGroupAdmission: ACTOR_INPUT_KEYS,
    declineGroupAdmission: ACTOR_INPUT_KEYS,
    removeGroupMember: ACTOR_INPUT_KEYS,
    banGroupMember: ACTOR_INPUT_KEYS,
    unbanGroupMember: ACTOR_INPUT_KEYS,
    setGroupMemberRole: [...ACTOR_INPUT_KEYS, 'role'],
    transferGroupOwnership: ACTOR_INPUT_KEYS,
    upsertMember: [
        ...ACTOR_INPUT_KEYS,
        'role',
        'status',
        'invitedByPrincipalId',
        'invitationExpiresAtEpochMs'
    ],
    rotateGroupJoinCode: [...ACTOR_INPUT_KEYS, 'joinCode', 'expiresAtEpochMs'],
    connectPresence: [
        ...ACTOR_INPUT_KEYS,
        'principalId',
        'generationId',
        'connectedAtEpochMs',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ],
    heartbeatPresence: [
        ...ACTOR_INPUT_KEYS,
        'principalId',
        'generationId',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ],
    disconnectPresence: [
        ...ACTOR_INPUT_KEYS,
        'principalId',
        'generationId',
        'generationVersion',
        'observedExpiresAtEpochMs',
        'disconnectedAtEpochMs',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ]
};

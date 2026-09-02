import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateExactKeys,
    validateGroupRef,
    validateJsonSafe,
    validateNonEmptyString,
    validateNullablePersistenceExpiry,
    validateOneOf,
    validatePositiveSafeInteger,
    validateRecord,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';
import {
    isGroupLifecycleTransitionOperation,
    isGroupTransportOperation,
    type GroupMutationCommand
} from '../group-mutation-contracts.ts';
import { ACTOR_INPUT_KEYS } from './group-mutation-request-validation.ts';
import { validateLifecycleGroupMutationCommandInput } from './validate-lifecycle-group-mutation-command-input.ts';

const GROUP_MUTATION_OPERATIONS = new Set([
    'createGroup',
    'updateGroup',
    'appointDirector',
    'planGroupLayout',
    'connectGroup',
    'startGroupFormation',
    'resetGroupFormation',
    'activateGroup',
    'reconfigureGroup',
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
    'planGroupLayout',
    'connectGroup',
    'startGroupFormation',
    'resetGroupFormation',
    'activateGroup',
    'reconfigureGroup',
    'failGroupFormation',
    'applyPlannedLayout'
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
    planGroupLayout: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch'],
    startGroupFormation: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch'],
    resetGroupFormation: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch'],
    connectGroup: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch', 'expectedLayout', 'connectTriggerGeneration'],
    activateGroup: [...ACTOR_INPUT_KEYS, 'observedRate', 'degraded', 'expectedFormationEpoch', 'expectedLayout'],
    reconfigureGroup: [...ACTOR_INPUT_KEYS, 'expectedFormationEpoch', 'landing'],
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

export function validateGroupMutationCommand(command: unknown): readonly GroupStateValidationIssue[] {
    const issues = [...validateJsonSafe(command, 'Group mutation command')];
    if (!isGroupStateRecord(command)) {
        return [...issues, ...validateRecord(command, 'Group mutation command')];
    }
    if ('commandHash' in command) {
        issues.push(toGroupStateValidationIssue('commandHash', 'Group mutation command must not contain commandHash'));
    }
    issues.push(...validateNonEmptyString(command.operation, 'Group mutation operation'));
    const operation = typeof command.operation === 'string' && GROUP_MUTATION_OPERATIONS.has(command.operation)
        ? command.operation as GroupMutationCommand['operation']
        : undefined;
    if (operation === undefined) {
        issues.push(toGroupStateValidationIssue('operation', 'Group mutation operation is invalid'));
    }
    else {
        issues.push(...validateCommandKeys(command, operation));
    }
    issues.push(...validateNonEmptyString(command.commandId, 'Group mutation commandId'));
    if (command.requestId !== null) {
        issues.push(...validateNonEmptyString(command.requestId, 'Group mutation requestId'));
    }
    issues.push(...validateGroupRef(command.aggregateRef));
    if (!isGroupStateRecord(command.input)) {
        issues.push(...validateRecord(command.input, 'Group mutation input'));
    }
    else {
        if (operation !== undefined) {
            issues.push(
                ...validateExactKeys(command.input, GROUP_MUTATION_INPUT_KEYS[operation], `Group ${operation} input`)
            );
        }
        for (const key of ['actorPrincipalId', 'actorSessionId', 'reason', 'traceId']) {
            if (command.input[key] !== null) {
                issues.push(...validateNonEmptyString(command.input[key], `Group mutation ${key}`));
            }
        }
    }
    if ('sessionId' in command) {
        issues.push(...validateNonEmptyString(command.sessionId, 'Group session id'));
    }
    if ('targetPrincipalId' in command) {
        issues.push(...validateNonEmptyString(command.targetPrincipalId, 'Group target principal id'));
    }
    if (operation !== undefined && isGroupStateRecord(command.input)) {
        if (PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation)) {
            issues.push(...validateNonEmptyString(command.input.generationId, 'Group presence generationId'));
        }
        issues.push(...validateOperationInput(operation, command.input));
    }
    return issues;
}

function validateCommandKeys(
    command: Record<string, unknown>,
    operation: GroupMutationCommand['operation']
): readonly GroupStateValidationIssue[] {
    return validateExactKeys(command, [
        'operation',
        'aggregateRef',
        'commandId',
        'requestId',
        'input',
        ...(TARGET_GROUP_MUTATION_OPERATIONS.has(operation) ? ['targetPrincipalId'] : []),
        ...(PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation) ? ['sessionId'] : [])
    ], 'Group mutation command');
}

function validateOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): readonly GroupStateValidationIssue[] {
    if (isGroupTransportOperation(operation)) {
        return [];
    }
    if (AGGREGATE_GROUP_MUTATION_OPERATIONS.has(operation)) {
        if (isGroupLifecycleTransitionOperation(operation) || operation === 'applyPlannedLayout') {
            return validateLifecycleGroupMutationCommandInput({
                operation,
                input,
                requiredInputKeys: GROUP_MUTATION_INPUT_KEYS[operation]
            });
        }
        return validateAggregateOperationInput(operation, input);
    }
    if (PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation)) {
        return validatePresenceOperationInput(operation, input);
    }
    return validateMembershipOperationInput(operation, input);
}

function validateAggregateOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): readonly GroupStateValidationIssue[] {
    switch (operation) {
        case 'createGroup':
            return [
                ...validateNullableString(input, 'slug'),
                ...validateNonEmptyString(input.displayName, 'Group displayName'),
                ...validateNullableString(input, 'description'),
                ...validateOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind'),
                ...validateOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode'),
                ...validateNullableInteger(input, 'maxMembers'),
                ...validateNullableInteger(input, 'maxSessionsPerMember'),
                ...validateRecord(input.metadata, 'Group metadata'),
                ...validateNonEmptyString(input.createdByPrincipalId, 'Group createdByPrincipalId'),
                ...validateNullableInteger(input, 'expiresAtEpochMs'),
                ...validateNullablePersistenceExpiry(input.purgeAfterEpochMs, 'Group purgeAfterEpochMs'),
                ...(input.lifecyclePolicy === undefined
                    ? []
                    : validateRecord(input.lifecyclePolicy, 'Group lifecyclePolicy'))
            ];
        case 'updateGroup':
            return [
                ...validateNullableString(input, 'slug'),
                ...validateNullableString(input, 'displayName'),
                ...validateNullableString(input, 'description'),
                ...(input.kind === null
                    ? []
                    : validateOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind')),
                ...(input.status === null
                    ? []
                    : validateOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status')),
                ...(input.joinMode === null
                    ? []
                    : validateOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode')),
                ...validateNullableInteger(input, 'maxMembers'),
                ...validateNullableInteger(input, 'maxSessionsPerMember'),
                ...(input.metadata === null ? [] : validateRecord(input.metadata, 'Group metadata')),
                ...validateNullableInteger(input, 'expiresAtEpochMs'),
                ...validateNullableInteger(input, 'emptySinceEpochMs'),
                ...validateNullablePersistenceExpiry(input.purgeAfterEpochMs, 'Group purgeAfterEpochMs')
            ];
        case 'appointDirector':
            return validatePositiveSafeInteger(input.heartbeatTtlMs, 'Group heartbeatTtlMs');
        case 'rotateGroupJoinCode':
            return [
                ...validateNullableString(input, 'joinCode'),
                ...validateNullableInteger(input, 'expiresAtEpochMs')
            ];
        default:
            return [];
    }
}

function validateMembershipOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): readonly GroupStateValidationIssue[] {
    switch (operation) {
        case 'joinGroup':
        case 'acceptGroupInvite':
            return [...validateNullableString(input, 'inviteToken'), ...validateNullableString(input, 'joinCode')];
        case 'createGroupInvite':
            return validateNullableInteger(input, 'invitationExpiresAtEpochMs');
        case 'setGroupMemberRole':
            return validateOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
        case 'upsertMember':
            // Pending membership is computed only by admission policy, never client input.
            return [
                ...(input.role === null ? [] : validateOneOf(input.role, ['owner', 'admin', 'member'], 'Group role')),
                ...validateOneOf(
                    input.status,
                    ['invited', 'active', 'left', 'removed', 'banned'],
                    'Group member status'
                ),
                ...validateNullableString(input, 'invitedByPrincipalId'),
                ...validateNullableInteger(input, 'invitationExpiresAtEpochMs')
            ];
        default:
            return [];
    }
}

function validatePresenceOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): readonly GroupStateValidationIssue[] {
    const issues = operation === 'connectPresence'
        ? [
            ...validateNonEmptyString(input.principalId, 'Group presence principalId'),
            ...validateNullableInteger(input, 'connectedAtEpochMs')
        ]
        : [...validateNullableString(input, 'principalId')];
    if (operation === 'disconnectPresence') {
        issues.push(
            ...validateNullableInteger(input, 'generationVersion'),
            ...validateNullableInteger(input, 'observedExpiresAtEpochMs'),
            ...validateNullableInteger(input, 'disconnectedAtEpochMs')
        );
    }
    return [
        ...issues,
        ...validateNullableInteger(input, 'lastHeartbeatAtEpochMs'),
        ...validateNullableInteger(input, 'expiresAtEpochMs')
    ];
}

function validateNullableString(
    input: Readonly<Record<string, unknown>>,
    key: string
): readonly GroupStateValidationIssue[] {
    return input[key] === null ? [] : validateNonEmptyString(input[key], `Group ${key}`);
}

function validateNullableInteger(
    input: Readonly<Record<string, unknown>>,
    key: string
): readonly GroupStateValidationIssue[] {
    const value = input[key];
    return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        ? []
        : [toGroupStateValidationIssue(`input.${key}`, `Group ${key} is invalid`)];
}


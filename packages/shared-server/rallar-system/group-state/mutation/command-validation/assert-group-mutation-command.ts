import type { JsonWireObject } from '../../../protocol/json-wire-identity.ts';
import {
    assertExactKeys,
    requireJsonSafe,
    requireNonEmptyString,
    requireOneOf,
    requirePositiveSafeInteger,
    requireRecord,
    validateGroupRef
} from '../../group-state-validation-primitives.ts';
import {
    isGroupLifecycleTransitionOperation,
    isGroupTransportOperation,
    type GroupMutationCommand
} from '../group-mutation-contracts.ts';
import { assertLifecycleGroupMutationCommandInput } from './assert-lifecycle-group-mutation-command-input.ts';
import { ACTOR_INPUT_KEYS } from './group-mutation-request-validation.ts';

export function assertGroupMutationCommand(
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
    assertOperationInput(operation, input);
}

function assertOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    // The valve carries no operation field at all (product decision 25), so
    // the exact-key assertion above is its whole input contract and there is
    // no family validator to route it to.
    if (isGroupTransportOperation(operation)) {
        return;
    }
    if (AGGREGATE_GROUP_MUTATION_OPERATIONS.has(operation)) {
        if (isGroupLifecycleTransitionOperation(operation) || operation === 'applyPlannedLayout') {
            assertLifecycleGroupMutationCommandInput({
                operation,
                // The enclosing command already passed requireJsonSafe before
                // this record boundary, so lifecycle validation reads JSON-only
                // input rather than propagating an untrusted record type.
                input: input as JsonWireObject,
                requiredInputKeys: GROUP_MUTATION_INPUT_KEYS[operation]
            });
            return;
        }
        assertAggregateOperationInput(operation, input);
        return;
    }
    if (PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation)) {
        assertPresenceOperationInput(operation, input);
        return;
    }
    assertMembershipOperationInput(operation, input);
}

function assertAggregateOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    switch (operation) {
        case 'createGroup':
            assertNullableString(input, 'slug');
            requireNonEmptyString(input.displayName, 'Group displayName');
            assertNullableString(input, 'description');
            requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
            requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
            assertNullableInteger(input, 'maxMembers', true);
            assertNullableInteger(input, 'maxSessionsPerMember', true);
            requireRecord(input.metadata, 'Group metadata');
            requireNonEmptyString(input.createdByPrincipalId, 'Group createdByPrincipalId');
            assertNullableInteger(input, 'expiresAtEpochMs', true);
            assertNullableInteger(input, 'purgeAfterEpochMs', true);
            if (input.lifecyclePolicy !== undefined) {
                requireRecord(input.lifecyclePolicy, 'Group lifecyclePolicy');
            }
            return;
        case 'updateGroup':
            assertNullableString(input, 'slug');
            assertNullableString(input, 'displayName');
            assertNullableString(input, 'description');
            if (input.kind !== null) {
                requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
            }
            if (input.status !== null) {
                requireOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status');
            }
            if (input.joinMode !== null) {
                requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
            }
            assertNullableInteger(input, 'maxMembers', true);
            assertNullableInteger(input, 'maxSessionsPerMember', true);
            if (input.metadata !== null) {
                requireRecord(input.metadata, 'Group metadata');
            }
            assertNullableInteger(input, 'expiresAtEpochMs', true);
            assertNullableInteger(input, 'emptySinceEpochMs', true);
            assertNullableInteger(input, 'purgeAfterEpochMs', true);
            return;
        case 'appointDirector':
            requirePositiveSafeInteger(input.heartbeatTtlMs, 'Group heartbeatTtlMs');
            return;
        case 'rotateGroupJoinCode':
            assertNullableString(input, 'joinCode');
            assertNullableInteger(input, 'expiresAtEpochMs', true);
            return;
        default:
            return;
    }
}

function assertMembershipOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    switch (operation) {
        case 'joinGroup':
        case 'acceptGroupInvite':
            assertNullableString(input, 'inviteToken');
            assertNullableString(input, 'joinCode');
            return;
        case 'createGroupInvite':
            assertNullableInteger(input, 'invitationExpiresAtEpochMs', true);
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
            assertNullableString(input, 'invitedByPrincipalId');
            assertNullableInteger(input, 'invitationExpiresAtEpochMs', true);
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

function assertPresenceOperationInput(
    operation: GroupMutationCommand['operation'],
    input: Readonly<Record<string, unknown>>
): void {
    if (operation === 'connectPresence') {
        requireNonEmptyString(input.principalId, 'Group presence principalId');
        assertNullableInteger(input, 'connectedAtEpochMs', true);
    }
    else {
        assertNullableString(input, 'principalId');
    }
    if (operation === 'disconnectPresence') {
        assertNullableInteger(input, 'generationVersion', true);
        assertNullableInteger(input, 'observedExpiresAtEpochMs', true);
        assertNullableInteger(input, 'disconnectedAtEpochMs', true);
    }
    assertNullableInteger(input, 'lastHeartbeatAtEpochMs', true);
    assertNullableInteger(input, 'expiresAtEpochMs', true);
}

function assertNullableString(input: Readonly<Record<string, unknown>>, key: string): void {
    if (input[key] !== null) {
        requireNonEmptyString(input[key], `Group ${key}`);
    }
}

function assertNullableInteger(
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
    'planGroupLayout',
    'connectGroup',
    'startGroupFormation',
    'resetGroupFormation',
    'activateGroup',
    'reconfigureGroup',
    'failGroupFormation',
    'applyPlannedLayout',
    'updateGroupActivationStatus',
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
    'applyPlannedLayout',
    'updateGroupActivationStatus'
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
    updateGroupActivationStatus: [
        ...ACTOR_INPUT_KEYS,
        'expectedFormationEpoch',
        'expectedLayout',
        'coverageRate',
        'evidenceWatermark',
        'dwellSatisfied',
        'replanQueued',
        'layoutStale'
    ],
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

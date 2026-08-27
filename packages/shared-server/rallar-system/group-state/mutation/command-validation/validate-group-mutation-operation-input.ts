import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    requireJsonSafe,
    requireNonEmptyString,
    requireOneOf,
    requirePositiveSafeInteger,
    requireRecord
} from '../../group-state-validation-primitives.ts';
import type { GroupMutationCommand } from '../group-mutation-contracts.ts';
import { requireGroupLifecyclePolicyInputShape } from './require-group-lifecycle-policy-input-shape.ts';

interface ValidateGroupMutationOperationInput {
    readonly operation: GroupMutationCommand['operation'];
    readonly input: Record<string, unknown>;
}

export function validateGroupMutationOperationInput({
    operation,
    input
}: ValidateGroupMutationOperationInput): void {
    if (isAggregateOperation(operation)) {
        validateAggregateMutationInput(operation, input);
        return;
    }
    if (isPresenceOperation(operation)) {
        return;
    }
    validateMembershipMutationInput(operation, input);
}

type AggregateOperation = Extract<
    GroupMutationCommand['operation'],
    | 'createGroup'
    | 'updateGroup'
    | 'appointDirector'
    | 'rotateGroupJoinCode'
    | 'startGroupEstablishment'
    | 'activateGroup'
    | 'reopenGroupEstablishment'
    | 'failGroupFormation'
>;

function validateAggregateMutationInput(
    operation: AggregateOperation,
    input: Record<string, unknown>
): void {
    const optionalString = (key: string) => {
        if (input[key] !== undefined) {
            requireNonEmptyString(input[key], `Group ${operation} ${key}`);
        }
    };
    const optionalPositiveInteger = (key: string) => {
        if (input[key] !== undefined) {
            requirePositiveSafeInteger(input[key], `Group ${operation} ${key}`);
        }
    };
    if (operation === 'createGroup') {
        requireNonEmptyString(input.groupId, 'Group createGroup groupId');
        optionalString('slug');
        requireNonEmptyString(input.displayName, 'Group createGroup displayName');
        optionalString('description');
        requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
        if (input.joinMode !== undefined) {
            requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
        }
        optionalPositiveInteger('maxMembers');
        optionalPositiveInteger('maxSessionsPerMember');
        if (input.metadata !== undefined) {
            requireRecord(input.metadata, 'Group metadata');
        }
        if (input.lifecyclePolicy !== undefined) {
            requireJsonSafe(input.lifecyclePolicy, 'Group lifecyclePolicy');
            requireGroupLifecyclePolicyInputShape(input.lifecyclePolicy as JsonWireValue);
        }
        requireNonEmptyString(input.createdByPrincipalId, 'Group createGroup createdByPrincipalId');
        optionalPositiveInteger('expiresAtEpochMs');
        optionalPositiveInteger('purgeAfterEpochMs');
        return;
    }
    if (operation === 'updateGroup') {
        validateGroupUpdateInput(input, optionalString, optionalPositiveInteger);
        return;
    }
    if (operation === 'appointDirector') {
        optionalPositiveInteger('heartbeatTtlMs');
        return;
    }
    if (operation === 'startGroupEstablishment' || operation === 'reopenGroupEstablishment') {
        validateExpectedFormationEpochInput(input.expectedFormationEpoch as JsonWireValue | undefined, operation);
        return;
    }
    if (operation === 'activateGroup') {
        validateActivateGroupInput(input);
        validateExpectedFormationEpochInput(input.expectedFormationEpoch as JsonWireValue | undefined, operation);
        validateExpectedLayoutInput(input.expectedLayout as JsonWireValue | undefined, operation);
        return;
    }
    if (operation === 'failGroupFormation') {
        if (!isUnitIntervalNumber(input.observedRate)) {
            throw new TypeError('Group failGroupFormation observedRate must be within [0, 1]');
        }
        validateExpectedFormationEpochInput(input.expectedFormationEpoch as JsonWireValue | undefined, operation);
        validateExpectedLayoutInput(input.expectedLayout as JsonWireValue | undefined, operation);
        return;
    }
    optionalString('joinCode');
    optionalPositiveInteger('expiresAtEpochMs');
}

function validateGroupUpdateInput(
    input: Record<string, unknown>,
    optionalString: (key: string) => void,
    optionalPositiveInteger: (key: string) => void
): void {
    optionalString('slug');
    optionalString('displayName');
    optionalString('description');
    if (input.kind !== undefined) {
        requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
    }
    if (input.status !== undefined) {
        requireOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status');
    }
    if (input.joinMode !== undefined) {
        requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
    }
    optionalPositiveInteger('maxMembers');
    optionalPositiveInteger('maxSessionsPerMember');
    if (input.metadata !== undefined) {
        requireRecord(input.metadata, 'Group metadata');
    }
    optionalPositiveInteger('expiresAtEpochMs');
    optionalPositiveInteger('emptySinceEpochMs');
    optionalPositiveInteger('purgeAfterEpochMs');
}

type MembershipOperation = Exclude<
    GroupMutationCommand['operation'],
    AggregateOperation | 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence'
>;

function validateMembershipMutationInput(
    operation: MembershipOperation,
    input: Record<string, unknown>
): void {
    const optionalString = (key: string) => {
        if (input[key] !== undefined) {
            requireNonEmptyString(input[key], `Group ${operation} ${key}`);
        }
    };
    const optionalPositiveInteger = (key: string) => {
        if (input[key] !== undefined) {
            requirePositiveSafeInteger(input[key], `Group ${operation} ${key}`);
        }
    };
    switch (operation) {
        case 'joinGroup':
        case 'acceptGroupInvite':
            optionalString('inviteToken');
            optionalString('joinCode');
            return;
        case 'createGroupInvite':
            optionalPositiveInteger('invitationExpiresAtEpochMs');
            return;
        case 'setGroupMemberRole':
            requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
            return;
        case 'transferGroupOwnership':
            requireNonEmptyString(
                input.newOwnerPrincipalId,
                'Group transferGroupOwnership newOwnerPrincipalId'
            );
            return;
        case 'upsertMember':
            if (input.role !== undefined) {
                requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
            }
            // 'pending' is deliberately absent: only the admission decision may
            // compute it, never client input (plan decision 5.1).
            requireOneOf(
                input.status,
                ['invited', 'active', 'left', 'removed', 'banned'],
                'Group member status'
            );
            optionalString('invitedByPrincipalId');
            optionalPositiveInteger('invitationExpiresAtEpochMs');
            return;
        case 'revokeGroupInvite':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'grantGroupAdmission':
        case 'declineGroupAdmission':
            return;
    }
}

function isAggregateOperation(
    operation: GroupMutationCommand['operation']
): operation is AggregateOperation {
    return [
        'createGroup',
        'updateGroup',
        'appointDirector',
        'rotateGroupJoinCode',
        'startGroupEstablishment',
        'activateGroup',
        'reopenGroupEstablishment',
        'failGroupFormation'
    ].includes(operation);
}

type PresenceOperation = 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';

function isPresenceOperation(
    operation: GroupMutationCommand['operation']
): operation is PresenceOperation {
    return ['connectPresence', 'heartbeatPresence', 'disconnectPresence'].includes(operation);
}

// This validator sees both raw requests and built commands. Requests never
// carry the criterion fields (the exact-key check excludes them), so absence,
// like null, means operator activation.
function validateActivateGroupInput(input: Record<string, unknown>): void {
    const { observedRate, degraded } = input;
    if (observedRate !== undefined && observedRate !== null && !isUnitIntervalNumber(observedRate)) {
        throw new TypeError('Group activateGroup observedRate must be within [0, 1]');
    }
    if (degraded !== undefined && degraded !== null && typeof degraded !== 'boolean') {
        throw new TypeError('Group activateGroup degraded must be boolean or null');
    }
}

function isUnitIntervalNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

// Raw requests never carry the fence keys (their exact-key rows exclude
// them), so absence, like null, means a principal command with no fence.
function validateExpectedFormationEpochInput(
    epoch: JsonWireValue | undefined,
    operation: string
): void {
    if (epoch === undefined || epoch === null) {
        return;
    }
    if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) {
        throw new TypeError(`Group ${operation} expectedFormationEpoch must be null or a non-negative integer`);
    }
}

function validateExpectedLayoutInput(
    layout: JsonWireValue | undefined,
    operation: string
): void {
    if (layout === undefined || layout === null) {
        return;
    }
    const record = requireRecord(layout, `Group ${operation} expectedLayout`);
    for (const key of ['groupRevision', 'presenceRevision', 'version']) {
        if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) {
            throw new TypeError(`Group ${operation} expectedLayout ${key} must be a non-negative integer`);
        }
    }
    requireOneOf(record.state, ['active', 'removed'], `Group ${operation} expectedLayout state`);
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'groupRevision,presenceRevision,state,version') {
        throw new TypeError(`Group ${operation} expectedLayout carries unexpected keys`);
    }
}

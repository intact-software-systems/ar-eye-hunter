import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupMutationCommand } from '../group-mutation-contracts.ts';
import {
    isGroupInputRecord,
    validateGroupInputFields,
    validateGroupInputKeys,
    type GroupInputFieldRule
} from './group-input-validation-issues.ts';
import { validateGroupLifecyclePolicyInputShape } from './validate-group-lifecycle-policy-input-shape.ts';

interface GroupMutationOperationInput {
    readonly operation: GroupMutationCommand['operation'];
    readonly input: Readonly<Record<string, unknown>>;
}

const GROUP_KIND: GroupInputFieldRule = {
    key: 'kind',
    kind: 'enum',
    allowed: ['party', 'room', 'team', 'custom'],
    label: 'Group kind'
};
const GROUP_JOIN_MODE: GroupInputFieldRule = {
    key: 'joinMode',
    kind: 'enum',
    allowed: ['invite-only', 'code', 'open'],
    label: 'Group joinMode'
};
const GROUP_METADATA: GroupInputFieldRule = { key: 'metadata', kind: 'object', label: 'Group metadata' };
const GROUP_ROLE: GroupInputFieldRule = {
    key: 'role',
    kind: 'enum',
    allowed: ['owner', 'admin', 'member'],
    label: 'Group role'
};
const INPUT_FIELDS: Partial<Record<GroupMutationCommand['operation'], readonly GroupInputFieldRule[]>> = {
    createGroup: [
        { key: 'groupId', kind: 'string', required: true },
        { key: 'slug', kind: 'string' },
        { key: 'displayName', kind: 'string', required: true },
        { key: 'description', kind: 'string' },
        { ...GROUP_KIND, required: true },
        GROUP_JOIN_MODE,
        { key: 'maxMembers', kind: 'positive-integer' },
        { key: 'maxSessionsPerMember', kind: 'positive-integer' },
        GROUP_METADATA
    ],
    updateGroup: [
        { key: 'slug', kind: 'string' },
        { key: 'displayName', kind: 'string' },
        { key: 'description', kind: 'string' },
        GROUP_KIND,
        { key: 'status', kind: 'enum', allowed: ['active', 'archived', 'deleted'], label: 'Group status' },
        GROUP_JOIN_MODE,
        { key: 'maxMembers', kind: 'positive-integer' },
        { key: 'maxSessionsPerMember', kind: 'positive-integer' },
        GROUP_METADATA,
        { key: 'expiresAtEpochMs', kind: 'positive-integer' },
        { key: 'emptySinceEpochMs', kind: 'positive-integer' },
        { key: 'purgeAfterEpochMs', kind: 'positive-integer' }
    ],
    appointDirector: [{ key: 'heartbeatTtlMs', kind: 'positive-integer' }],
    connectGroup: [{ key: 'expectedFormationEpoch', kind: 'nonnegative-integer', required: true }],
    reconfigureGroup: [{ key: 'landing', kind: 'enum', allowed: ['apply', 'hold'], nullable: true }],
    rotateGroupJoinCode: [{ key: 'joinCode', kind: 'string' }, { key: 'expiresAtEpochMs', kind: 'positive-integer' }],
    joinGroup: [{ key: 'inviteToken', kind: 'string' }, { key: 'joinCode', kind: 'string' }],
    acceptGroupInvite: [{ key: 'inviteToken', kind: 'string' }, { key: 'joinCode', kind: 'string' }],
    createGroupInvite: [{ key: 'invitationExpiresAtEpochMs', kind: 'positive-integer' }],
    setGroupMemberRole: [{ ...GROUP_ROLE, required: true }],
    transferGroupOwnership: [{ key: 'newOwnerPrincipalId', kind: 'string', required: true }],
    upsertMember: [
        GROUP_ROLE,
        {
            key: 'status',
            kind: 'enum',
            required: true,
            allowed: ['invited', 'active', 'left', 'removed', 'banned'],
            label: 'Group member status'
        },
        { key: 'invitedByPrincipalId', kind: 'string' },
        { key: 'invitationExpiresAtEpochMs', kind: 'positive-integer' }
    ]
};

export function validateGroupMutationOperationInput(
    { operation, input }: GroupMutationOperationInput
): readonly TypeError[] {
    const issues = validateGroupInputFields(input, INPUT_FIELDS[operation] ?? [], `Group ${operation}`);
    if (operation === 'connectGroup') {
        return [...issues, ...validateExpectedLayout(input.expectedLayout)];
    }
    if (operation === 'createGroup') {
        return [
            ...issues,
            ...(input.lifecyclePolicy === undefined
                ? []
                : validateGroupLifecyclePolicyInputShape(input.lifecyclePolicy)),
            ...validateGroupInputFields(input, [
                { key: 'createdByPrincipalId', kind: 'string', required: true },
                { key: 'expiresAtEpochMs', kind: 'positive-integer' },
                { key: 'purgeAfterEpochMs', kind: 'positive-integer' }
            ], 'Group createGroup')
        ];
    }
    return issues;
}

function validateExpectedLayout(value: unknown): readonly TypeError[] {
    const label = 'Group connectGroup expectedLayout';
    if (!isGroupInputRecord(value)) {
        return [new TypeError(`${label} must be an object`)];
    }
    const keys = GROUP_LAYOUT_IDENTITY_KEYS;
    const missing = keys.filter((key) => !Object.hasOwn(value, key));
    const issues = missing.map((key) => new TypeError(`${label} is missing mandatory key: ${key}`));
    return [
        ...issues,
        ...validateGroupInputKeys(value, keys, label),
        ...validateGroupInputFields(value, [
            { key: 'groupRevision', kind: 'nonnegative-integer', required: true },
            { key: 'presenceRevision', kind: 'nonnegative-integer', required: true },
            { key: 'version', kind: 'nonnegative-integer', required: true },
            { key: 'state', kind: 'enum', required: true, allowed: GROUP_LAYOUT_IDENTITY_STATES }
        ], label)
    ];
}

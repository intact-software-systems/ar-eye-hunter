import { GROUP_DIRECTORY_LISTING_METADATA_KEY } from '@shared/api/group-directory/group-directory-listing.ts';
import {
    GROUP_LAYOUT_IDENTITY_KEYS,
    GROUP_LAYOUT_IDENTITY_STATES
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { decodeGroupPublicationTopicGrants } from '@shared/api/group-publication/group-publication-grants.ts';
import { assertGroupRetentionIntent, GROUP_RETENTION_METADATA_KEY } from '@shared/api/group-retention.ts';
import { formatRallarValidation, validateRallarWsUserTopicId } from '@shared/api/rallar-validation.ts';
import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';
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
    readonly input: JsonWireObject;
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
    allowed: ['owner', 'admin', 'member', 'spectator'],
    label: 'Group role'
};
const PUBLICATION_GRANT_FIELDS: readonly GroupInputFieldRule[] = [
    { key: 'topicId', kind: 'string', required: true },
    { key: 'publish', kind: 'boolean', required: true },
    { key: 'subscribe', kind: 'boolean', required: true }
];
const TOPIC_SUBSCRIPTION_FIELDS: readonly GroupInputFieldRule[] = [
    { key: 'topicId', kind: 'string', required: true },
    { key: 'connectionGenerationId', kind: 'string', required: true }
];
const INPUT_FIELDS: Partial<Record<GroupMutationCommand['operation'], readonly GroupInputFieldRule[]>> = {
    createGroup: [
        { key: 'groupId', kind: 'string', required: true },
        { key: 'slug', kind: 'string' },
        { key: 'displayName', kind: 'string', required: true },
        { key: 'description', kind: 'string' },
        { ...GROUP_KIND, required: true },
        GROUP_JOIN_MODE,
        { key: 'directoryListing', kind: 'enum', allowed: ['listed', 'unlisted'] },
        { key: 'maxMembers', kind: 'positive-integer' },
        { key: 'maxSpectators', kind: 'nonnegative-integer' },
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
        { key: 'directoryListing', kind: 'enum', allowed: ['listed', 'unlisted'] },
        { key: 'maxMembers', kind: 'positive-integer' },
        { key: 'maxSpectators', kind: 'nonnegative-integer' },
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
    joinGroup: [{ key: 'participation', kind: 'enum', allowed: ['player', 'spectator'] }, {
        key: 'inviteToken',
        kind: 'string'
    }, { key: 'joinCode', kind: 'string' }],
    acceptGroupInvite: [{ key: 'inviteToken', kind: 'string' }, { key: 'joinCode', kind: 'string' }],
    createGroupInvite: [{ key: 'invitationExpiresAtEpochMs', kind: 'positive-integer' }],
    setGroupMemberRole: [{ ...GROUP_ROLE, required: true }],
    grantGroupPublication: PUBLICATION_GRANT_FIELDS,
    revokeGroupPublication: PUBLICATION_GRANT_FIELDS,
    subscribeGroupTopic: TOPIC_SUBSCRIPTION_FIELDS,
    unsubscribeGroupTopic: TOPIC_SUBSCRIPTION_FIELDS,
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
    const issues = [
        ...validateGroupInputFields(input, INPUT_FIELDS[operation] ?? [], `Group ${operation}`),
        ...(operation === 'createGroup' || operation === 'updateGroup'
            ? validateGroupDirectoryListingMetadata(input.metadata)
            : [])
    ];
    if (
        (operation === 'createGroup' || operation === 'updateGroup') && typeof input.maxSpectators === 'number' &&
        input.maxSpectators > 64
    ) {
        issues.push(new TypeError('Group maxSpectators must be at most 64'));
    }
    if (operation === 'connectGroup') {
        return [...issues, ...validateExpectedLayout(input.expectedLayout)];
    }
    if (operation === 'grantGroupPublication' || operation === 'revokeGroupPublication') {
        return [...issues, ...validatePublicationGrantIntent(operation, input)];
    }
    if (operation === 'subscribeGroupTopic' || operation === 'unsubscribeGroupTopic') {
        return [...issues, ...validateUserTopicIdInput(operation, input)];
    }
    if (operation === 'createGroup') {
        return [
            ...issues,
            ...validateRetentionCreationInput(input),
            ...(input.lifecyclePolicy === undefined
                ? []
                : validateGroupLifecyclePolicyInputShape(input.lifecyclePolicy)),
            ...(input.publicationGrants === undefined
                ? []
                : validateCreationPublicationGrants(input.publicationGrants)),
            ...validateGroupInputFields(input, [
                { key: 'createdByPrincipalId', kind: 'string', required: true },
                { key: 'expiresAtEpochMs', kind: 'positive-integer' },
                { key: 'purgeAfterEpochMs', kind: 'positive-integer' }
            ], 'Group createGroup')
        ];
    }
    return issues;
}

/** D492: the topic is one exact user topic, and the command names at least one permission. */
function validatePublicationGrantIntent(
    operation: 'grantGroupPublication' | 'revokeGroupPublication',
    input: JsonWireObject
): readonly TypeError[] {
    const namesNone = input.publish === false && input.subscribe === false;
    return [
        ...validateUserTopicIdInput(operation, input),
        ...(namesNone ? [new TypeError(`Group ${operation} request must name publish or subscribe`)] : [])
    ];
}

/** A present non-empty topicId names one exact user topic; its absence or type is the field rule's issue. */
function validateUserTopicIdInput(
    operation: GroupMutationCommand['operation'],
    input: JsonWireObject
): readonly TypeError[] {
    const topic = typeof input.topicId === 'string' && input.topicId.length > 0
        ? validateRallarWsUserTopicId(input.topicId)
        : null;
    return topic === null || topic.ok
        ? []
        : [
            new TypeError(
                `Group ${operation} topicId is invalid: ${topic.issues.map((issue) => issue.message).join('; ')}`
            )
        ];
}

/** D494: the creator's declared grant, each key one exact user topic naming publish, subscribe or both, at most 64. */
export function validateCreationPublicationGrants(value: JsonWireValue | undefined): readonly TypeError[] {
    return decodeGroupPublicationTopicGrants(value).fold(
        (
            issues
        ) => [new TypeError(`Group createGroup publicationGrants is invalid: ${formatRallarValidation(issues)}`)],
        () => []
    );
}

function validateRetentionCreationInput(input: JsonWireObject): readonly TypeError[] {
    const issues: TypeError[] = [];
    if (isGroupInputRecord(input.metadata) && Object.hasOwn(input.metadata, GROUP_RETENTION_METADATA_KEY)) {
        issues.push(new TypeError('Group retention metadata is server-owned; use creation retention intent'));
    }
    if (input.retention === undefined) {
        return issues;
    }
    try {
        assertGroupRetentionIntent(input.retention);
        if (
            input.retention.mode === 'temporary' &&
            (input.expiresAtEpochMs !== undefined || input.purgeAfterEpochMs !== undefined)
        ) {
            issues.push(
                new TypeError('Group temporary retention cannot be combined with absolute expiry or purge deadlines')
            );
        }
    }
    catch (error) {
        if (!(error instanceof TypeError)) {
            throw error;
        }
        issues.push(error);
    }
    return issues;
}

function validateExpectedLayout(value: JsonWireValue | undefined): readonly TypeError[] {
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

/** Metadata is an external extension map; a present platform listing setting has a closed vocabulary. */
export function validateGroupDirectoryListingMetadata(metadata: JsonWireValue | undefined): readonly TypeError[] {
    return isGroupInputRecord(metadata)
        ? validateGroupInputFields(metadata, [{
            key: GROUP_DIRECTORY_LISTING_METADATA_KEY,
            kind: 'enum',
            allowed: ['listed', 'unlisted']
        }], 'Group metadata')
        : [];
}

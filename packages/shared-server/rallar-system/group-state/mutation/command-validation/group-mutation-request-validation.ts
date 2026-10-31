import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { GroupMutationRejectedError, type GroupMutationCommand } from '../group-mutation-contracts.ts';
import {
    isGroupInputRecord,
    validateGroupInputFields,
    validateGroupInputJson,
    validateGroupInputKeys
} from './group-input-validation-issues.ts';
import { validateGroupMutationOperationInput } from './validate-group-mutation-operation-input.ts';

type PresenceOperation = 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';

/** A decoded JSON request body or a typed request a route built; both are checked field by field. */
type GroupMutationRequestCandidate = JsonWireValue | object;

export function assertGroupMutationRequest(
    operation: GroupMutationCommand['operation'],
    request: GroupMutationRequestCandidate
): void {
    let publicRequest = request;
    if (operation === 'reconfigureGroup' && isGroupInputRecord(request) && 'expectedFormationEpoch' in request) {
        const { expectedFormationEpoch, ...sparseRequest } = request;
        if (
            expectedFormationEpoch !== null &&
            (typeof expectedFormationEpoch !== 'number' || !Number.isSafeInteger(expectedFormationEpoch) ||
                expectedFormationEpoch < 0)
        ) {
            throw new TypeError('Group reconfigureGroup expectedFormationEpoch must be a non-negative safe integer');
        }
        publicRequest = sparseRequest;
    }
    const issues = validateGroupMutationRequest(operation, publicRequest);
    if (issues.length > 0) {
        throw issues[0];
    }
}

export function validateGroupMutationRequest(
    operation: GroupMutationCommand['operation'],
    request: GroupMutationRequestCandidate
): readonly Error[] {
    const label = `Group ${operation} request`;
    const jsonIssues = validateGroupInputJson(request, label);
    if (jsonIssues.length > 0) {
        return jsonIssues;
    }
    if (!isGroupInputRecord(request)) {
        return [new TypeError(`${label} must be an object`)];
    }
    const issues = [
        ...validateGroupInputKeys(request, GROUP_MUTATION_REQUEST_KEYS[operation], label),
        ...validateGroupInputFields(request, [
            { key: 'requestId', kind: 'string', required: true },
            { key: 'actorPrincipalId', kind: 'string', required: true },
            { key: 'actorSessionId', kind: 'string', required: true },
            { key: 'reason', kind: 'string' }
        ], `Group ${operation}`)
    ];
    if (operation === 'connectPresence' || operation === 'heartbeatPresence' || operation === 'disconnectPresence') {
        return [...issues, ...validateGroupPresenceMutationRequest(operation, request)];
    }
    return [...issues, ...validateGroupMutationOperationInput({ operation, input: request as JsonWireObject })];
}

export function validateGroupPresenceMutationRequest(
    operation: PresenceOperation,
    request: GroupMutationRequestCandidate
): readonly Error[] {
    const label = `Group ${operation} request`;
    const jsonIssues = validateGroupInputJson(request, label);
    if (jsonIssues.length > 0) {
        return jsonIssues;
    }
    if (!isGroupInputRecord(request)) {
        return [new TypeError(`${label} must be an object`)];
    }
    const timestampFields = [
        ...(operation === 'connectPresence' ? ['connectedAtEpochMs'] : []),
        ...(operation === 'disconnectPresence' ? ['disconnectedAtEpochMs'] : []),
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ];
    const identityFields = ['requestId', 'actorPrincipalId', 'actorSessionId', 'reason', 'principalId'];
    const generationFields = operation === 'connectPresence'
        ? ['generationId', 'connectionGenerationId']
        : ['generationId'];
    const issues = [
        ...validateGroupInputKeys(request, [...identityFields, ...generationFields, ...timestampFields], label),
        ...validateGroupInputFields(request, [
            ...generationFields.map((key) => ({ key, kind: 'string' as const, required: true })),
            ...identityFields.map((key) => ({ key, kind: 'string' as const }))
        ], `Group ${operation}`)
    ];
    const timestampIssues = validateGroupInputFields(
        request,
        timestampFields.map((key) => ({ key, kind: 'positive-integer' as const })),
        `Group ${operation}`
    )
        .map((issue) => new GroupMutationRejectedError(issue.message));
    return [...issues, ...timestampIssues, ...validatePresenceTimestampOrder(operation, request)];
}

function validatePresenceTimestampOrder(
    operation: PresenceOperation,
    request: object
): readonly GroupMutationRejectedError[] {
    const issues: GroupMutationRejectedError[] = [];
    const heartbeatAt = readPresenceTimestamp(request, 'lastHeartbeatAtEpochMs');
    const expiresAt = readPresenceTimestamp(request, 'expiresAtEpochMs');
    if (heartbeatAt === undefined) {
        return issues;
    }
    if (expiresAt !== undefined && expiresAt < heartbeatAt) {
        issues.push(
            new GroupMutationRejectedError(
                `Group ${operation} expiresAtEpochMs must not predate lastHeartbeatAtEpochMs`
            )
        );
    }
    const connectedAt = readPresenceTimestamp(request, 'connectedAtEpochMs');
    if (operation === 'connectPresence' && connectedAt !== undefined && heartbeatAt < connectedAt) {
        issues.push(
            new GroupMutationRejectedError(
                'Group connectPresence lastHeartbeatAtEpochMs must not predate connectedAtEpochMs'
            )
        );
    }
    const disconnectedAt = readPresenceTimestamp(request, 'disconnectedAtEpochMs');
    if (operation === 'disconnectPresence' && disconnectedAt !== undefined && disconnectedAt < heartbeatAt) {
        issues.push(
            new GroupMutationRejectedError(
                'Group disconnectPresence disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs'
            )
        );
    }
    return issues;
}

type PresenceTimestampKey =
    | 'connectedAtEpochMs'
    | 'disconnectedAtEpochMs'
    | 'lastHeartbeatAtEpochMs'
    | 'expiresAtEpochMs';

/** A request field read for the order check only; its type was validated beside it. */
function readPresenceTimestamp(request: object, key: PresenceTimestampKey): number | undefined {
    const timestamp: JsonWireValue | undefined = Reflect.get(request, key);
    return typeof timestamp === 'number' ? timestamp : undefined;
}

export const ACTOR_INPUT_KEYS = [
    'actorPrincipalId',
    'actorSessionId',
    'reason'
] as const;

const MUTATION_REQUEST_KEYS = [...ACTOR_INPUT_KEYS, 'requestId'] as const;

const GROUP_MUTATION_REQUEST_KEYS: Readonly<Record<GroupMutationCommand['operation'], readonly string[]>> = {
    createGroup: [
        ...MUTATION_REQUEST_KEYS,
        'groupId',
        'slug',
        'displayName',
        'description',
        'kind',
        'joinMode',
        'directoryListing',
        'retention',
        'maxMembers',
        'maxSpectators',
        'maxSessionsPerMember',
        'metadata',
        'createdByPrincipalId',
        'expiresAtEpochMs',
        'purgeAfterEpochMs',
        'lifecyclePolicy',
        'publicationGrants'
    ],
    updateGroup: [
        ...MUTATION_REQUEST_KEYS,
        'slug',
        'displayName',
        'description',
        'kind',
        'status',
        'joinMode',
        'directoryListing',
        'maxMembers',
        'maxSpectators',
        'maxSessionsPerMember',
        'metadata',
        'expiresAtEpochMs',
        'emptySinceEpochMs',
        'purgeAfterEpochMs'
    ],
    appointDirector: [...MUTATION_REQUEST_KEYS, 'heartbeatTtlMs'],
    planGroupLayout: [...MUTATION_REQUEST_KEYS],
    startGroupFormation: [...MUTATION_REQUEST_KEYS],
    resetGroupFormation: [...MUTATION_REQUEST_KEYS],
    connectGroup: [...MUTATION_REQUEST_KEYS, 'expectedFormationEpoch', 'expectedLayout'],
    activateGroup: [...MUTATION_REQUEST_KEYS],
    reconfigureGroup: [...MUTATION_REQUEST_KEYS, 'landing'],
    // Internal-only: never reaches the HTTP request validator, listed for the
    // Record's completeness. The criterion payload carries the observed rate.
    failGroupFormation: [...MUTATION_REQUEST_KEYS, 'observedRate'],
    // Internal-only, like failGroupFormation: the publication transaction
    // enqueues it and no HTTP route exists.
    applyPlannedLayout: MUTATION_REQUEST_KEYS,
    updateGroupActivationStatus: MUTATION_REQUEST_KEYS,
    // The valve carries no operation field: pausing names nothing beyond
    // the actor who decided it (product decision 25).
    pauseGroupTransport: MUTATION_REQUEST_KEYS,
    resumeGroupTransport: MUTATION_REQUEST_KEYS,
    joinGroup: [...MUTATION_REQUEST_KEYS, 'participation', 'inviteToken', 'joinCode'],
    acceptGroupInvite: MUTATION_REQUEST_KEYS,
    createGroupInvite: [...MUTATION_REQUEST_KEYS, 'invitationExpiresAtEpochMs'],
    revokeGroupInvite: MUTATION_REQUEST_KEYS,
    grantGroupAdmission: MUTATION_REQUEST_KEYS,
    declineGroupAdmission: MUTATION_REQUEST_KEYS,
    removeGroupMember: MUTATION_REQUEST_KEYS,
    banGroupMember: MUTATION_REQUEST_KEYS,
    unbanGroupMember: MUTATION_REQUEST_KEYS,
    setGroupMemberRole: [...MUTATION_REQUEST_KEYS, 'role'],
    grantGroupPublication: [...MUTATION_REQUEST_KEYS, 'topicId', 'publish', 'subscribe'],
    revokeGroupPublication: [...MUTATION_REQUEST_KEYS, 'topicId', 'publish', 'subscribe'],
    subscribeGroupTopic: [...MUTATION_REQUEST_KEYS, 'topicId', 'connectionGenerationId'],
    unsubscribeGroupTopic: [...MUTATION_REQUEST_KEYS, 'topicId', 'connectionGenerationId'],
    transferGroupOwnership: [...MUTATION_REQUEST_KEYS, 'newOwnerPrincipalId'],
    upsertMember: [
        ...MUTATION_REQUEST_KEYS,
        'role',
        'status',
        'invitedByPrincipalId',
        'invitationExpiresAtEpochMs'
    ],
    rotateGroupJoinCode: [...MUTATION_REQUEST_KEYS, 'joinCode', 'expiresAtEpochMs'],
    connectPresence: [
        ...MUTATION_REQUEST_KEYS,
        'principalId',
        'generationId',
        'connectionGenerationId',
        'connectedAtEpochMs',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ],
    heartbeatPresence: [
        ...MUTATION_REQUEST_KEYS,
        'principalId',
        'generationId',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ],
    disconnectPresence: [
        ...MUTATION_REQUEST_KEYS,
        'principalId',
        'generationId',
        'generationVersion',
        'observedExpiresAtEpochMs',
        'disconnectedAtEpochMs',
        'lastHeartbeatAtEpochMs',
        'expiresAtEpochMs'
    ]
};

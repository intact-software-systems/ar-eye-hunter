import { requireExactKeys, requireExactOptionalKeys, requireString } from '../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { GroupMutationAuthorizationError } from '../group-mutation-authority.ts';
import type {
    AuthorizedGroupMutation,
    GroupMutationAuthorityProof,
    GroupMutationDescriptor,
    GroupMutationPreparation
} from '../group-state-service-contracts.ts';
import { requireNonNegativeSafeInteger } from '../group-state-validation-primitives.ts';
import { validateGroupMutationRequest } from '../mutation/command-validation/group-mutation-request-validation.ts';
import { validateGroupMutationCommand } from '../mutation/command-validation/validate-group-mutation-command.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '../mutation/group-mutation-contracts.ts';
import { validateGroupMutationFacts } from '../mutation/state-validation/validate-group-mutation-facts.ts';

export type DecodedGroupStateInboxAuthority =
    | Readonly<{ kind: 'authorized'; mutation: AuthorizedGroupMutation; }>
    | Readonly<{ kind: 'prepared'; mutation: GroupMutationPreparation; }>;

const AUTHORIZED_MUTATION_KEYS = ['authorityProof', 'descriptor'] as const;
const PREPARED_MUTATION_KEYS = [
    'authorityProof',
    'descriptor',
    'command',
    'facts',
    'causalToken',
    'queueResourceId'
] as const;

export function decodeGroupStateInboxAuthority(
    value: JsonWireValue | undefined
): DecodedGroupStateInboxAuthority {
    const authority = requireJsonWireObject(value, 'Group AppInbox authority');
    if (hasExactKeys(authority, AUTHORIZED_MUTATION_KEYS)) {
        return {
            kind: 'authorized',
            mutation: decodeAuthorizedGroupMutation(authority)
        };
    }
    if (hasExactKeys(authority, PREPARED_MUTATION_KEYS)) {
        return {
            kind: 'prepared',
            mutation: decodeGroupMutationPreparation(authority)
        };
    }
    throw malformedAuthority('authenticated group mutation intent');
}

function decodeAuthorizedGroupMutation(value: JsonWireObject): AuthorizedGroupMutation {
    try {
        return {
            authorityProof: decodeGroupMutationAuthorityProof(value.authorityProof),
            descriptor: decodeGroupMutationDescriptor(value.descriptor)
        };
    }
    catch {
        throw malformedAuthority('authenticated group mutation intent');
    }
}

function decodeGroupMutationPreparation(value: JsonWireObject): GroupMutationPreparation {
    try {
        const authorityProof = decodeNullableGroupMutationAuthorityProof(value.authorityProof);
        const descriptor = decodeNullableGroupMutationDescriptor(value.descriptor);
        if ((authorityProof === null) !== (descriptor === null)) {
            throw new TypeError('Prepared authority proof and descriptor must both be present');
        }
        validateGroupMutationCommand(value.command);
        const facts = decodePreparedGroupMutationFacts(value.facts);
        validatePreparedAuthorityFacts(authorityProof, facts);
        requireString(value.causalToken, 'Prepared group mutation causal token');
        requireString(value.queueResourceId, 'Prepared group mutation queue resource id');
        return {
            authorityProof,
            descriptor,
            command: value.command,
            facts,
            causalToken: value.causalToken,
            queueResourceId: value.queueResourceId
        };
    }
    catch {
        throw malformedAuthority('prepared group mutation');
    }
}

function decodeNullableGroupMutationAuthorityProof(
    value: JsonWireValue | undefined
): GroupMutationAuthorityProof | null {
    return value === null ? null : decodeGroupMutationAuthorityProof(value);
}

function decodeGroupMutationAuthorityProof(
    value: JsonWireValue | undefined
): GroupMutationAuthorityProof {
    const proof = requireJsonWireObject(value, 'Group mutation authority proof');
    requireExactKeys(
        proof,
        [
            'version',
            'principalId',
            'sessionId',
            'sessionIssuedAtEpochMs',
            'sessionExpiresAtEpochMs',
            'commandMac'
        ],
        'Group mutation authority proof'
    );
    if (proof.version !== 1) {
        throw new TypeError('Group mutation authority proof version is invalid');
    }
    requireString(proof.principalId, 'Group mutation authority principal id');
    requireString(proof.sessionId, 'Group mutation authority session id');
    requireNonNegativeSafeInteger(
        proof.sessionIssuedAtEpochMs,
        'Group mutation authority issued timestamp'
    );
    requireNonNegativeSafeInteger(
        proof.sessionExpiresAtEpochMs,
        'Group mutation authority expiry timestamp'
    );
    if (proof.sessionExpiresAtEpochMs <= proof.sessionIssuedAtEpochMs) {
        throw new TypeError('Group mutation authority expiry must follow issuance');
    }
    requireString(proof.commandMac, 'Group mutation authority command MAC');
    if (!/^[0-9a-f]{64}$/.test(proof.commandMac)) {
        throw new TypeError('Group mutation authority command MAC is invalid');
    }
    return {
        version: 1,
        principalId: proof.principalId,
        sessionId: proof.sessionId,
        sessionIssuedAtEpochMs: proof.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: proof.sessionExpiresAtEpochMs,
        commandMac: proof.commandMac
    };
}

function decodeNullableGroupMutationDescriptor(
    value: JsonWireValue | undefined
): GroupMutationDescriptor | null {
    return value === null ? null : decodeGroupMutationDescriptor(value);
}

function decodeGroupMutationDescriptor(
    value: JsonWireValue | undefined
): GroupMutationDescriptor {
    const descriptor = requireJsonWireObject(value, 'Group mutation descriptor');
    requireExactKeys(
        descriptor,
        ['operation', 'scope', 'groupId', 'targetPrincipalId', 'sessionId', 'request'],
        'Group mutation descriptor'
    );
    const operation = decodeGroupMutationOperation(descriptor.operation);
    const scope = requireJsonWireObject(descriptor.scope, 'Group mutation descriptor scope');
    requireExactKeys(
        scope,
        ['applicationId', 'workspaceId'],
        'Group mutation descriptor scope'
    );
    requireString(scope.applicationId, 'Group mutation descriptor application id');
    requireString(scope.workspaceId, 'Group mutation descriptor workspace id');
    requireString(descriptor.groupId, 'Group mutation descriptor group id');
    const targetPrincipalId = decodeNullableString(
        descriptor.targetPrincipalId,
        'Group mutation descriptor target principal id'
    );
    const sessionId = decodeNullableString(
        descriptor.sessionId,
        'Group mutation descriptor session id'
    );
    validateGroupMutationRequest(operation, descriptor.request);
    return {
        operation,
        scope: {
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId
        },
        groupId: descriptor.groupId,
        targetPrincipalId,
        sessionId,
        request: descriptor.request as GroupMutationDescriptor['request']
    };
}

function decodePreparedGroupMutationFacts(
    value: JsonWireValue | undefined
): Omit<GroupMutationFacts, 'attemptCount'> {
    const facts = requireJsonWireObject(value, 'Prepared group mutation facts');
    requireExactOptionalKeys({
        value: facts,
        required: [
            'nowEpochMs',
            'expireAtEpochMs',
            'serviceId',
            'eventId',
            'commandHash',
            'resolvedJoinCode',
            'joinCodeVerifier',
            'internalAuthority',
            'authenticatedAuthority'
        ],
        optional: ['capacity'],
        label: 'Prepared group mutation facts'
    });
    const withAttemptCount = { ...facts, attemptCount: 1 };
    const decodedFacts = withAttemptCount as GroupMutationFacts;
    validateGroupMutationFacts(decodedFacts);
    return {
        nowEpochMs: decodedFacts.nowEpochMs,
        expireAtEpochMs: decodedFacts.expireAtEpochMs,
        serviceId: decodedFacts.serviceId,
        eventId: decodedFacts.eventId,
        commandHash: decodedFacts.commandHash,
        resolvedJoinCode: decodedFacts.resolvedJoinCode,
        joinCodeVerifier: decodedFacts.joinCodeVerifier,
        internalAuthority: decodedFacts.internalAuthority,
        ...(decodedFacts.capacity === undefined
            ? {}
            : { capacity: decodedFacts.capacity }),
        authenticatedAuthority: decodedFacts.authenticatedAuthority
    };
}

function decodeGroupMutationOperation(
    value: JsonWireValue | undefined
): GroupMutationCommand['operation'] {
    switch (value) {
        case 'createGroup':
        case 'updateGroup':
        case 'appointDirector':
        case 'startGroupEstablishment':
        case 'planGroupLayout':
        case 'connectGroup':
        case 'startGroupFormation':
        case 'pauseGroupTransport':
        case 'resumeGroupTransport':
        case 'activateGroup':
        case 'reopenGroupEstablishment':
        case 'failGroupFormation':
        case 'applyPlannedLayout':
        case 'joinGroup':
        case 'acceptGroupInvite':
        case 'createGroupInvite':
        case 'revokeGroupInvite':
        case 'grantGroupAdmission':
        case 'declineGroupAdmission':
        case 'rotateGroupJoinCode':
        case 'removeGroupMember':
        case 'banGroupMember':
        case 'unbanGroupMember':
        case 'setGroupMemberRole':
        case 'transferGroupOwnership':
        case 'upsertMember':
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
            return value;
        default:
            throw new TypeError('Group mutation descriptor operation is invalid');
    }
}

function validatePreparedAuthorityFacts(
    authorityProof: GroupMutationAuthorityProof | null,
    facts: Omit<GroupMutationFacts, 'attemptCount'>
): void {
    if (authorityProof === null) {
        if (facts.internalAuthority === 'none' || facts.authenticatedAuthority !== null) {
            throw new TypeError('Prepared internal group authority facts are invalid');
        }
        return;
    }
    if (
        facts.internalAuthority !== 'none' ||
        facts.authenticatedAuthority?.principalId !== authorityProof.principalId ||
        facts.authenticatedAuthority.sessionId !== authorityProof.sessionId
    ) {
        throw new TypeError('Prepared authenticated group authority facts are invalid');
    }
}

function decodeNullableString(
    value: JsonWireValue | undefined,
    label: string
): string | null {
    if (value === null) {
        return null;
    }
    requireString(value, label);
    return value;
}

function requireJsonWireObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (
        value === null || value === undefined || typeof value !== 'object' ||
        isJsonWireArray(value)
    ) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonWireArray(value: JsonWireValue): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}

function hasExactKeys(value: JsonWireObject, keys: readonly string[]): boolean {
    return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function malformedAuthority(label: string): GroupMutationAuthorizationError {
    return new GroupMutationAuthorizationError(`App inbox ${label} is malformed.`);
}

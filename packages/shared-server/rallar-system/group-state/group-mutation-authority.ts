import type { StateScope } from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';

import type { GroupPolicyCapacityConfig } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import type { IssuedAuthSession } from '../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import { authSessionProofSecret } from '../auth/sessions/auth-session-proof-secret.ts';
import { computeSha256CanonicalJson, serializeCanonicalJson } from '../protocol/canonical-json.ts';
import { computeMutationCommandDigest, decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    toAggregateMutationCommand,
    toMembershipMutationCommand,
    toPublicationMutationCommand,
    toTopicSubscriptionMutationCommand
} from './group-mutation-command.ts';
import { toPresenceMutationCommand } from './group-presence-mutation-command.ts';
import {
    type AuthorizedGroupMutation,
    type GroupMutationAuthority,
    type GroupMutationAuthorityProof,
    type GroupMutationDescriptor,
    type GroupMutationIngress,
    type GroupStateMutationCommand
} from './group-state-service-contracts.ts';
import { assertGroupMutationCommand } from './mutation/command-validation/assert-group-mutation-command.ts';
import { type GroupMutationCommand, type GroupMutationIngressFacts } from './mutation/group-mutation-contracts.ts';
import { hmacSha256Hex } from './mutation/group-state-crypto.ts';
import type { GroupQuickJoinIngress } from './quick-join/group-quick-join-contracts.ts';
import { toScopedGroupMutationCommandId } from './scoped-group-mutation-command-id.ts';
import { toLifecycleMutationCommand } from './to-lifecycle-mutation-command.ts';
import { toTransportMutationCommand } from './to-transport-mutation-command.ts';

export interface GroupMutationAuthorityDependencies {
    readonly authSessions: Pick<AuthSessionPersistence, 'findBySessionId'>;
    readonly now: () => number;
    readonly randomId: () => string;
    readonly serviceId: string;
    /** How long a command's idempotency record and derived outbox rows stay after its ingress. */
    readonly finishedRetentionMs: number;
    readonly capacity?: GroupPolicyCapacityConfig;
}

/**
 * One event per execution: the ingress instant tells a request executed again after its retention window from the
 * execution its idempotency record and AppInbox fact recorded; every attempt of one execution reuses the same facts.
 */
export function toGroupMutationEventId(commandHash: string, ingressAtEpochMs: number): string {
    return `group-event:${computeSha256CanonicalJson({ commandHash, ingressAtEpochMs })}`;
}

const LIVE_SESSION_DENIAL = 'Authenticated session is missing, expired, revoked, or mismatched.';

interface CaptureAuthorizedGroupMutationIngressInput {
    readonly dependencies: GroupMutationAuthorityDependencies;
    readonly descriptor: GroupMutationDescriptor;
    readonly authority: GroupMutationAuthority;
    readonly useScopedCommandId: boolean;
}

export class GroupMutationAuthorizationError extends Error {
    readonly status = 403;
    readonly code = 'group-mutation-authority-denied';

    constructor(message: string) {
        super(`Forbidden: ${message}`);
        this.name = 'GroupMutationAuthorizationError';
    }
}

export async function captureGroupMutationIngress(
    dependencies: GroupMutationAuthorityDependencies,
    descriptor: GroupMutationDescriptor,
    authority: IssuedAuthSession
): Promise<GroupMutationIngress> {
    return await captureAuthorizedGroupMutationIngress({
        dependencies,
        descriptor,
        authority,
        useScopedCommandId: false
    });
}

export async function captureAppInboxGroupMutationIngress(
    dependencies: GroupMutationAuthorityDependencies,
    descriptor: GroupMutationDescriptor,
    authority: GroupMutationAuthority
): Promise<GroupMutationIngress> {
    return await captureAuthorizedGroupMutationIngress({
        dependencies,
        descriptor,
        authority,
        useScopedCommandId: true
    });
}

async function captureAuthorizedGroupMutationIngress(
    input: CaptureAuthorizedGroupMutationIngressInput
): Promise<GroupMutationIngress> {
    const { dependencies, descriptor, authority, useScopedCommandId } = input;
    const authorized = isGroupMutationAuthorityProof(authority)
        ? reuseGroupMutationAuthorityProof(descriptor, authority)
        : await authorizeGroupMutation(dependencies, descriptor, authority);
    const materialized = materializeAuthenticatedGroupMutationCommand({
        descriptor: authorized.descriptor,
        authorityProof: authorized.authorityProof,
        randomId: dependencies.randomId,
        useScopedCommandId
    });
    const { command } = materialized;
    const commandHash = computeMutationCommandDigest(
        decodeJsonWireValue(materialized.semanticCommand, 'Group semantic mutation command')
    );
    const resolvedJoinCode = resolveCommandJoinCode(command, commandHash);
    const nowEpochMs = dependencies.now();
    const facts: GroupMutationIngressFacts = {
        nowEpochMs,
        expireAtEpochMs: nowEpochMs + dependencies.finishedRetentionMs,
        serviceId: dependencies.serviceId,
        eventId: toGroupMutationEventId(commandHash, nowEpochMs),
        commandHash,
        resolvedJoinCode,
        joinCodeVerifier: await toJoinCodeVerifier(resolvedJoinCode),
        internalAuthority: 'none',
        capacity: dependencies.capacity ?? { defaultMaxMembers: null },
        authenticatedAuthority: {
            principalId: authorized.authorityProof.principalId,
            sessionId: authorized.authorityProof.sessionId
        }
    };
    const causalToken = computeSha256CanonicalJson({ command, facts });
    const queueResourceId = `g-${
        computeSha256CanonicalJson({
            requestId: command.requestId,
            authoritySession: {
                sessionId: authorized.authorityProof.sessionId,
                issuedAtEpochMs: authorized.authorityProof.sessionIssuedAtEpochMs,
                expiresAtEpochMs: authorized.authorityProof.sessionExpiresAtEpochMs
            },
            commandMac: authorized.authorityProof.commandMac,
            causalToken
        }).slice(0, 34)
    }`;
    return {
        ...authorized,
        command,
        facts,
        causalToken,
        queueResourceId
    };
}

/**
 * The authority is the session the route's bearer lookup read and verified by
 * its token digest; the lane re-checks its liveness at execution, through
 * verifyLiveGroupMutationSession.
 */
export async function authorizeGroupMutation(
    dependencies: Pick<GroupMutationAuthorityDependencies, 'now'>,
    descriptor: GroupMutationDescriptor,
    authority: IssuedAuthSession
): Promise<AuthorizedGroupMutation> {
    if (authority.expiresAtEpochMs <= dependencies.now()) {
        throw new GroupMutationAuthorizationError(LIVE_SESSION_DENIAL);
    }
    const trustedDescriptor = toTrustedMutationDescriptor(descriptor, {
        principalId: authority.clientId,
        sessionId: authority.sessionId
    });
    assertAuthenticatedGroupMutationDescriptor(trustedDescriptor);
    return {
        authorityProof: await createGroupMutationAuthorityProof(authority, trustedDescriptor),
        descriptor: trustedDescriptor
    };
}

/**
 * The route verified the credential and minted this proof before the queue
 * entry was written; the lane trusts it and re-checks only session liveness
 * at execution, through verifyLiveGroupMutationSession.
 */
function reuseGroupMutationAuthorityProof(
    descriptor: GroupMutationDescriptor,
    authorityProof: GroupMutationAuthorityProof
): AuthorizedGroupMutation {
    const trustedDescriptor = toTrustedMutationDescriptor(descriptor, authorityProof);
    assertAuthenticatedGroupMutationDescriptor(trustedDescriptor);
    return { authorityProof, descriptor: trustedDescriptor };
}

/** The attempt re-reads its session and checks it at the attempt's instant. */
export async function readAndVerifyLiveGroupMutationSession(
    dependencies: Pick<GroupMutationAuthorityDependencies, 'authSessions'>,
    ingress: GroupStateMutationCommand
): Promise<void> {
    const proof = requireGroupMutationAuthorityProof(ingress);
    const session = await dependencies.authSessions.findBySessionId(proof.sessionId);
    verifyLiveGroupMutationSession(proof, session, ingress.facts.attemptAtEpochMs);
}

export function requireGroupMutationAuthorityProof(ingress: GroupStateMutationCommand): GroupMutationAuthorityProof {
    if (ingress.authorityProof === null || ingress.descriptor === null) {
        throw new GroupMutationAuthorizationError('Authenticated group mutation authority is missing.');
    }
    return ingress.authorityProof;
}

/** The stored session must still be exactly the one the route verified, and unexpired at execution. */
export function verifyLiveGroupMutationSession(
    proof: GroupMutationAuthorityProof,
    session: PersistedAuthSession | undefined,
    nowEpochMs: number
): void {
    if (
        !session ||
        session.clientId !== proof.principalId ||
        session.sessionId !== proof.sessionId ||
        session.issuedAtEpochMs !== proof.sessionIssuedAtEpochMs ||
        session.expiresAtEpochMs !== proof.sessionExpiresAtEpochMs ||
        session.expiresAtEpochMs <= nowEpochMs
    ) {
        throw new GroupMutationAuthorizationError(LIVE_SESSION_DENIAL);
    }
}

interface MaterializeAuthenticatedGroupMutationInput {
    readonly descriptor: GroupMutationDescriptor;
    readonly authorityProof: GroupMutationAuthorityProof;
    readonly randomId: () => string;
    readonly useScopedCommandId: boolean;
}

interface MaterializedAuthenticatedGroupMutation {
    readonly command: GroupMutationCommand;
    readonly semanticCommand: GroupMutationCommand;
}

function materializeAuthenticatedGroupMutationCommand(
    { descriptor, authorityProof, randomId, useScopedCommandId }: MaterializeAuthenticatedGroupMutationInput
): MaterializedAuthenticatedGroupMutation {
    const semanticCommand = toDescriptorCommand(descriptor, randomId);
    return {
        semanticCommand,
        command: useScopedCommandId
            ? {
                ...semanticCommand,
                commandId: toScopedGroupMutationCommandId(descriptor, authorityProof.principalId)
            }
            : semanticCommand
    };
}

export interface MutationDescriptorInput {
    readonly operation: GroupMutationDescriptor['operation'];
    readonly scope: StateScope;
    readonly groupId: string;
    readonly request: GroupMutationDescriptor['request'];
    readonly targetPrincipalId?: string | null;
    readonly sessionId?: string | null;
}

export function mutationDescriptor(input: MutationDescriptorInput): GroupMutationDescriptor {
    // Typed inbox builders establish operation/payload identity; ingress validates fields before compute.
    return {
        operation: input.operation,
        scope: input.scope,
        groupId: input.groupId,
        targetPrincipalId: input.targetPrincipalId ?? null,
        sessionId: input.sessionId ?? null,
        request: input.request
    } as GroupMutationDescriptor;
}

export function toDescriptorCommand(
    descriptor: GroupMutationDescriptor,
    randomId: () => string
): GroupMutationCommand {
    switch (descriptor.operation) {
        case 'createGroup':
        case 'updateGroup':
        case 'appointDirector':
        case 'rotateGroupJoinCode':
            return toAggregateMutationCommand(descriptor, randomId);
        case 'planGroupLayout':
        case 'connectGroup':
        case 'startGroupFormation':
        case 'resetGroupFormation':
        case 'activateGroup':
        case 'reconfigureGroup':
        case 'failGroupFormation':
            return toLifecycleMutationCommand(descriptor, randomId);
        case 'applyPlannedLayout':
            throw new TypeError('applyPlannedLayout has no authenticated route');
        case 'pauseGroupTransport':
        case 'resumeGroupTransport':
            return toTransportMutationCommand(descriptor.operation, descriptor, randomId);
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
            return toPresenceMutationCommand(descriptor, randomId);
        case 'grantGroupPublication':
        case 'revokeGroupPublication':
            return toPublicationMutationCommand(descriptor, randomId);
        case 'subscribeGroupTopic':
        case 'unsubscribeGroupTopic':
            return toTopicSubscriptionMutationCommand(descriptor, randomId);
        default:
            return toMembershipMutationCommand(descriptor, randomId);
    }
}

function toTrustedMutationDescriptor(
    descriptor: GroupMutationDescriptor,
    authority: Pick<GroupMutationAuthorityProof, 'principalId' | 'sessionId'>
): GroupMutationDescriptor {
    const request = descriptor.request;
    if (
        request.actorPrincipalId !== undefined &&
        request.actorPrincipalId !== authority.principalId
    ) {
        throw new GroupMutationAuthorizationError(
            'Request actor principal does not match authenticated principal.'
        );
    }
    if (request.actorSessionId !== undefined && request.actorSessionId !== authority.sessionId) {
        throw new GroupMutationAuthorizationError(
            'Request actor session does not match authenticated session.'
        );
    }
    if (
        descriptor.operation === 'createGroup' &&
        (!('createdByPrincipalId' in request) || request.createdByPrincipalId !== authority.principalId)
    ) {
        throw new GroupMutationAuthorizationError(
            'Group creator does not match authenticated principal.'
        );
    }
    if (
        descriptor.operation === 'connectPresence' ||
        descriptor.operation === 'heartbeatPresence' ||
        descriptor.operation === 'disconnectPresence'
    ) {
        if (descriptor.sessionId !== authority.sessionId) {
            throw new GroupMutationAuthorizationError(
                'Presence session does not match authenticated session.'
            );
        }
        if (
            'principalId' in request && request.principalId !== undefined &&
            request.principalId !== authority.principalId
        ) {
            throw new GroupMutationAuthorizationError(
                'Presence principal does not match authenticated principal.'
            );
        }
    }
    return {
        ...descriptor,
        request: {
            ...request,
            actorPrincipalId: authority.principalId,
            actorSessionId: authority.sessionId
        }
    } as GroupMutationDescriptor;
}

export async function createGroupMutationAuthorityProof(
    session: IssuedAuthSession | PersistedAuthSession,
    descriptor: GroupMutationDescriptor | Omit<GroupQuickJoinIngress, 'authorityProof'>
): Promise<GroupMutationAuthorityProof> {
    return {
        version: 1,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        commandMac: await hmacSha256Hex(
            await authSessionProofSecret(session),
            serializeCanonicalJson({ purpose: 'rallar-group-mutation-authority', version: 1, descriptor })
        )
    };
}

function isGroupMutationAuthorityProof(
    authority: GroupMutationAuthority
): authority is GroupMutationAuthorityProof {
    return 'version' in authority && authority.version === 1 && 'commandMac' in authority;
}

function assertAuthenticatedGroupMutationDescriptor(descriptor: GroupMutationDescriptor): void {
    const requestId = descriptor.request.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
        throw new NonRetryableException('Authenticated app inbox mutation requestId is required.');
    }
    assertGroupMutationCommand(toDescriptorCommand(descriptor, () => {
        throw new NonRetryableException('Authenticated group mutation requestId is required.');
    }));
}

function resolveCommandJoinCode(command: GroupMutationCommand, commandHash: string): string | null {
    return command.operation === 'rotateGroupJoinCode'
        ? (command.input.joinCode ?? commandHash.slice('sha256:'.length, 19).toUpperCase())
        : command.operation === 'joinGroup' || command.operation === 'acceptGroupInvite'
        ? command.input.joinCode
        : null;
}

async function toJoinCodeVerifier(joinCode: string | null): Promise<string | null> {
    if (!joinCode) {
        return null;
    }
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(joinCode.trim().toUpperCase())
    );
    return Array.from(new Uint8Array(digest))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

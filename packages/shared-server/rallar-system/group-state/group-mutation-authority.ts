import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';

import { type AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { GroupPolicyCapacityConfig } from '@shared-server/rallar-system/group-state/policy/group-membership-admission-policy.ts';
import type { IssuedAuthSession } from '../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import { authSessionProofSecret } from '../auth/sessions/auth-session-proof-secret.ts';
import { hashMutationCommand, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { toAggregateMutationCommand, toMembershipMutationCommand } from './group-mutation-command.ts';
import { toPresenceMutationCommand } from './group-presence-mutation-command.ts';
import {
    GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
    type AuthorizedGroupMutation,
    type GroupMutationAuthority,
    type GroupMutationAuthorityProof,
    type GroupMutationDescriptor,
    type GroupMutationPreparation,
    type GroupStateMutationCommand
} from './group-state-service-contracts.ts';
import { validateGroupMutationCommand } from './mutation/command-validation/validate-group-mutation-command.ts';
import { type GroupMutationCommand, type GroupMutationFacts } from './mutation/group-mutation-contracts.ts';
import {
    canonicalJson,
    constantTimeHexEqual,
    constantTimeSecretEqual,
    hmacSha256Hex,
    sha256CanonicalJson
} from './mutation/group-state-crypto.ts';
import { isScopedGroupMutationCommandId, toScopedGroupMutationCommandId } from './scoped-group-mutation-command-id.ts';
import { toLifecycleMutationCommand } from './to-lifecycle-mutation-command.ts';

export interface GroupMutationAuthorityDependencies {
    readonly authSessionRepository: Pick<AuthSessionRepository, 'findBySessionId'>;
    readonly now: () => number;
    readonly randomId: () => string;
    readonly serviceId: string;
    readonly capacity?: GroupPolicyCapacityConfig;
    readonly readCausalRevision: (ref: GroupRef) => Promise<GroupStateCausalRevision | undefined>;
}

interface VerifiedGroupMutationAuthority {
    readonly session: PersistedAuthSession;
    readonly descriptor: GroupMutationDescriptor;
}

interface VerifyGroupMutationAuthorityInput {
    readonly repository: Pick<AuthSessionRepository, 'findBySessionId'>;
    readonly descriptor: GroupMutationDescriptor;
    readonly authority: GroupMutationAuthority;
    readonly nowEpochMs: number;
}

interface PrepareAuthorizedGroupMutationInput {
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

export async function prepareGroupMutation(
    dependencies: GroupMutationAuthorityDependencies,
    descriptor: GroupMutationDescriptor,
    authority: GroupMutationAuthority
): Promise<GroupMutationPreparation> {
    return await prepareAuthorizedGroupMutation({
        dependencies,
        descriptor,
        authority,
        useScopedCommandId: false
    });
}

export async function prepareAppInboxGroupMutation(
    dependencies: GroupMutationAuthorityDependencies,
    descriptor: GroupMutationDescriptor,
    authority: GroupMutationAuthority
): Promise<GroupMutationPreparation> {
    return await prepareAuthorizedGroupMutation({
        dependencies,
        descriptor,
        authority,
        useScopedCommandId: true
    });
}

async function prepareAuthorizedGroupMutation(
    input: PrepareAuthorizedGroupMutationInput
): Promise<GroupMutationPreparation> {
    const { dependencies, descriptor, authority, useScopedCommandId } = input;
    const authorized = await authorizeGroupMutation(dependencies, descriptor, authority);
    const materialized = await materializeAuthenticatedGroupMutationCommand(
        authorized.descriptor,
        authorized.authorityProof,
        dependencies.randomId,
        useScopedCommandId
    );
    const { command } = materialized;
    const commandHash = await hashMutationCommand(materialized.semanticCommand as JsonWireValue);
    const resolvedJoinCode = resolveCommandJoinCode(command, commandHash);
    const facts: Omit<GroupMutationFacts, 'attemptCount'> = {
        nowEpochMs: dependencies.now(),
        expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
        serviceId: dependencies.serviceId,
        eventId: `group-event:${commandHash.slice('sha256:'.length)}`,
        commandHash,
        resolvedJoinCode,
        joinCodeVerifier: await toJoinCodeVerifier(resolvedJoinCode),
        internalAuthority: 'none',
        ...(dependencies.capacity ? { capacity: dependencies.capacity } : {}),
        authenticatedAuthority: {
            principalId: authorized.authorityProof.principalId,
            sessionId: authorized.authorityProof.sessionId
        }
    };
    const preparationCausalRevision = (await dependencies.readCausalRevision(command.aggregateRef)) ?? null;
    const causalToken = await sha256CanonicalJson({ command, facts, preparationCausalRevision });
    const queueResourceId = `g-${
        (
            await sha256CanonicalJson({
                requestId: command.requestId,
                authoritySession: {
                    sessionId: authorized.authorityProof.sessionId,
                    issuedAtEpochMs: authorized.authorityProof.sessionIssuedAtEpochMs,
                    expiresAtEpochMs: authorized.authorityProof.sessionExpiresAtEpochMs
                },
                commandMac: authorized.authorityProof.commandMac,
                causalToken
            })
        ).slice(0, 34)
    }`;
    return {
        ...authorized,
        command,
        facts,
        causalToken,
        queueResourceId
    };
}

export async function authorizeGroupMutation(
    dependencies: Pick<GroupMutationAuthorityDependencies, 'authSessionRepository' | 'now'>,
    descriptor: GroupMutationDescriptor,
    authority: GroupMutationAuthority
): Promise<AuthorizedGroupMutation> {
    const verified = await verifyGroupMutationAuthority({
        repository: dependencies.authSessionRepository,
        descriptor,
        authority,
        nowEpochMs: dependencies.now()
    });
    requireGroupMutationRequestId(verified.descriptor);
    const command = toDescriptorCommand(verified.descriptor, () => {
        throw new NonRetryableException('Authenticated group mutation requestId is required.');
    });
    validateGroupMutationCommand(command);
    return {
        authorityProof: await createGroupMutationAuthorityProof(verified.session, verified.descriptor),
        descriptor: verified.descriptor
    };
}

export async function verifyPreparedGroupMutationAuthority(
    dependencies: Pick<GroupMutationAuthorityDependencies, 'authSessionRepository' | 'now' | 'randomId'>,
    prepared: GroupStateMutationCommand
): Promise<void> {
    if (prepared.authorityProof === null || prepared.descriptor === null) {
        throw new GroupMutationAuthorizationError('Authenticated group mutation authority is missing.');
    }
    const verified = await verifyGroupMutationAuthority({
        repository: dependencies.authSessionRepository,
        descriptor: prepared.descriptor,
        authority: prepared.authorityProof,
        nowEpochMs: dependencies.now()
    });
    if (canonicalJson(verified.descriptor) !== canonicalJson(prepared.descriptor)) {
        throw new GroupMutationAuthorizationError(
            'Authenticated mutation descriptor changed before execution.'
        );
    }
    const materialized = await materializeAuthenticatedGroupMutationCommand(
        verified.descriptor,
        prepared.authorityProof,
        dependencies.randomId,
        isScopedGroupMutationCommandId(prepared.command.commandId)
    );
    const { command } = materialized;
    const commandHash = await hashMutationCommand(materialized.semanticCommand as JsonWireValue);
    if (
        canonicalJson(command) !== canonicalJson(prepared.command) ||
        commandHash !== prepared.facts.commandHash ||
        prepared.facts.authenticatedAuthority?.principalId !== verified.session.clientId ||
        prepared.facts.authenticatedAuthority?.sessionId !== verified.session.sessionId
    ) {
        throw new GroupMutationAuthorizationError(
            'Durable group mutation facts differ from authenticated command.'
        );
    }
}

async function materializeAuthenticatedGroupMutationCommand(
    descriptor: GroupMutationDescriptor,
    authorityProof: GroupMutationAuthorityProof,
    randomId: () => string,
    useScopedCommandId: boolean
): Promise<Readonly<{ command: GroupMutationCommand; semanticCommand: GroupMutationCommand; }>> {
    const semanticCommand = toDescriptorCommand(descriptor, randomId);
    return {
        semanticCommand,
        command: useScopedCommandId
            ? {
                ...semanticCommand,
                commandId: await toScopedGroupMutationCommandId(descriptor, authorityProof.principalId)
            }
            : semanticCommand
    };
}

export function mutationDescriptor(
    operation: GroupMutationDescriptor['operation'],
    scope: StateScope,
    groupId: string,
    request: GroupMutationDescriptor['request'],
    targetPrincipalId: string | null = null,
    sessionId: string | null = null
): GroupMutationDescriptor {
    return { operation, scope, groupId, targetPrincipalId, sessionId, request };
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
        case 'startGroupEstablishment':
        case 'activateGroup':
        case 'reopenGroupEstablishment':
        case 'failGroupFormation':
            return toLifecycleMutationCommand(descriptor, randomId);
        case 'connectPresence':
        case 'heartbeatPresence':
        case 'disconnectPresence':
            return toPresenceMutationCommand(descriptor, randomId);
        default:
            return toMembershipMutationCommand(descriptor, randomId);
    }
}

async function verifyGroupMutationAuthority(
    input: VerifyGroupMutationAuthorityInput
): Promise<VerifiedGroupMutationAuthority> {
    const { authority, descriptor, nowEpochMs, repository } = input;
    const claimed = isGroupMutationAuthorityProof(authority)
        ? {
            clientId: authority.principalId,
            sessionId: authority.sessionId,
            issuedAtEpochMs: authority.sessionIssuedAtEpochMs,
            expiresAtEpochMs: authority.sessionExpiresAtEpochMs
        }
        : authority;
    const session = await repository.findBySessionId(claimed.sessionId);
    if (
        !session ||
        session.clientId !== claimed.clientId ||
        session.sessionId !== claimed.sessionId ||
        session.issuedAtEpochMs !== claimed.issuedAtEpochMs ||
        session.expiresAtEpochMs !== claimed.expiresAtEpochMs ||
        session.expiresAtEpochMs <= nowEpochMs
    ) {
        throw new GroupMutationAuthorizationError(
            'Authenticated session is missing, expired, revoked, or mismatched.'
        );
    }
    if (
        !isGroupMutationAuthorityProof(authority) &&
        !(await constantTimeSecretEqual(
            session.accessTokenDigest,
            await authSessionProofSecret(authority)
        ))
    ) {
        throw new GroupMutationAuthorizationError('Authenticated session credential is invalid.');
    }
    const trustedDescriptor = toTrustedMutationDescriptor(descriptor, {
        principalId: session.clientId,
        sessionId: session.sessionId
    });
    if (isGroupMutationAuthorityProof(authority)) {
        const expected = await createGroupMutationAuthorityProof(session, trustedDescriptor);
        if (!constantTimeHexEqual(expected.commandMac, authority.commandMac)) {
            throw new GroupMutationAuthorizationError(
                'Authenticated mutation proof does not match the command.'
            );
        }
    }
    return { session, descriptor: trustedDescriptor };
}

function toTrustedMutationDescriptor(
    descriptor: GroupMutationDescriptor,
    authority: Readonly<{ principalId: string; sessionId: string; }>
): GroupMutationDescriptor {
    const request = descriptor.request as
        & GroupMutationDescriptor['request']
        & Readonly<{
            actorPrincipalId?: string;
            actorSessionId?: string;
            createdByPrincipalId?: string;
            principalId?: string;
        }>;
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
        request.createdByPrincipalId !== authority.principalId
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
        if (request.principalId !== undefined && request.principalId !== authority.principalId) {
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
    };
}

async function createGroupMutationAuthorityProof(
    session: IssuedAuthSession | PersistedAuthSession,
    descriptor: GroupMutationDescriptor
): Promise<GroupMutationAuthorityProof> {
    return {
        version: 1,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        commandMac: await hmacSha256Hex(
            await authSessionProofSecret(session),
            canonicalJson({ purpose: 'rallar-group-mutation-authority', version: 1, descriptor })
        )
    };
}

function isGroupMutationAuthorityProof(
    authority: GroupMutationAuthority
): authority is GroupMutationAuthorityProof {
    return 'version' in authority && authority.version === 1 && 'commandMac' in authority;
}

function requireGroupMutationRequestId(descriptor: GroupMutationDescriptor): void {
    const requestId = descriptor.request.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
        throw new NonRetryableException('Authenticated app inbox mutation requestId is required.');
    }
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

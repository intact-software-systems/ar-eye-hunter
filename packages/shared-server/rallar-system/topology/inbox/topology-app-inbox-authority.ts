import { type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { hashCanonicalCommand } from '../../app-inbox/hash-canonical-command.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import { authSessionProofSecret } from '../../auth/sessions/auth-session-proof-secret.ts';
import { GroupMutationAuthorizationError } from '../../group-state/group-mutation-authority.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import {
    isTopologyRecord,
    readAuthenticatedTopologyCommand,
    readDurableTopologyAppInboxCommand,
    readTopologyCommandForValidatedSession,
    requireExactTopologyKeys
} from './topology-app-inbox-command.ts';
import type { TopologyAppInboxAuthority, TopologyAppInboxCommand } from './topology-app-inbox-contracts.ts';
import {
    createTopologyMutationAuthorityProof,
    type TopologyMutationAuthorityProof
} from './topology-mutation-authority-proof.ts';

export interface CreateAuthenticatedTopologyEnqueueInput<V> {
    readonly enqueue: AppInboxEnqueueInput<V>;
    readonly claimedAuthority: IssuedAuthSession;
    readonly groupStateService: Pick<GroupStateService, 'readIssuedAuthSession'>;
    readonly nowEpochMs: () => number;
}

export interface VerifyTopologyAppInboxAuthorityInput {
    readonly authority: TopologyAppInboxAuthority;
    readonly groupStateService: Pick<GroupStateService, 'readIssuedAuthSession'>;
    readonly nowEpochMs: () => number;
}

export interface ValidateCurrentTopologySessionInput {
    readonly principalId: string;
    readonly claimedAuthority: IssuedAuthSession;
    readonly groupStateService: Pick<GroupStateService, 'readIssuedAuthSession'>;
    readonly nowEpochMs: () => number;
}

export async function createAuthenticatedTopologyEnqueue<V>(
    input: CreateAuthenticatedTopologyEnqueueInput<V>
): Promise<AppInboxEnqueueInput<V>> {
    const command = await readAuthenticatedTopologyCommand(input.enqueue, input.claimedAuthority);
    const currentSession = await validateCurrentTopologySession({
        principalId: command.actor.principalId,
        claimedAuthority: input.claimedAuthority,
        groupStateService: input.groupStateService,
        nowEpochMs: input.nowEpochMs
    });
    return await createAuthenticatedTopologyEnqueueFromValidatedSession({
        enqueue: input.enqueue,
        currentSession
    });
}

export async function createAuthenticatedTopologyEnqueueFromValidatedSession<V>(
    input: Readonly<{
        enqueue: AppInboxEnqueueInput<V>;
        currentSession: PersistedAuthSession;
    }>
): Promise<AppInboxEnqueueInput<V>> {
    const command = await readTopologyCommandForValidatedSession(input.enqueue, {
        principalId: input.currentSession.clientId,
        sessionId: input.currentSession.sessionId
    });
    const proof = await createTopologyMutationAuthorityProof(
        input.currentSession,
        command.commandHash
    );
    const authority: TopologyAppInboxAuthority = command.operation === 'reconfigureTopology'
        ? { kind: 'topology-reconfigure', proof, command }
        : { kind: 'topology-config', proof, command };
    return { ...input.enqueue, authority };
}

export function readTopologyAppInboxAuthority(value: unknown): TopologyAppInboxAuthority {
    try {
        if (!isTopologyRecord(value)) {
            throw new TypeError('authority is not a record');
        }
        requireExactTopologyKeys(value, ['kind', 'proof', 'command']);
        if (value.kind !== 'topology-config' && value.kind !== 'topology-reconfigure') {
            throw new TypeError('authority kind is invalid');
        }
        readTopologyMutationAuthorityProof(value.proof);
        readDurableTopologyAppInboxCommand(value.command);
        return value as TopologyAppInboxAuthority;
    }
    catch {
        throw new GroupMutationAuthorizationError('Topology AppInbox durable authority is malformed.');
    }
}

export async function verifyTopologyAppInboxAuthority(
    input: VerifyTopologyAppInboxAuthorityInput
): Promise<void> {
    const session = await input.groupStateService.readIssuedAuthSession(
        input.authority.proof.sessionId
    );
    if (!isCurrentTopologyAuthoritySession(input, session)) {
        throw new GroupMutationAuthorizationError(
            'Topology mutation authority is missing, expired, revoked, or mismatched.'
        );
    }
    const expected = await createTopologyMutationAuthorityProof(
        session,
        input.authority.proof.commandHash
    );
    if (!constantTimeTopologyProofEqual(expected.commandMac, input.authority.proof.commandMac)) {
        throw new GroupMutationAuthorizationError(
            'Topology mutation authority proof does not match the command.'
        );
    }
    const command = input.authority.command;
    if (
        (await hashCanonicalCommand({
            actor: command.actor,
            groupRef: command.groupRef,
            requestId: command.requestId,
            operation: command.operation,
            payload: command.payload
        })) !== command.commandHash
    ) {
        throw new GroupMutationAuthorizationError('Topology durable command hash is invalid.');
    }
}

export function readTopologyMutationAuthorityProof(value: unknown): void {
    if (!isTopologyRecord(value)) {
        throw new TypeError('authority proof is invalid');
    }
    requireExactTopologyKeys(value, [
        'version',
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'commandHash',
        'commandMac'
    ]);
    if (
        value.version !== 1 ||
        typeof value.principalId !== 'string' ||
        typeof value.sessionId !== 'string' ||
        !Number.isSafeInteger(value.sessionIssuedAtEpochMs) ||
        !Number.isSafeInteger(value.sessionExpiresAtEpochMs) ||
        typeof value.commandHash !== 'string' ||
        typeof value.commandMac !== 'string'
    ) {
        throw new TypeError('authority proof fields are invalid');
    }
}

export function constantTimeTopologyProofEqual(left: string, right: string): boolean {
    let difference = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}

export async function validateCurrentTopologySession(
    input: ValidateCurrentTopologySessionInput
): Promise<PersistedAuthSession> {
    const session = await input.groupStateService.readIssuedAuthSession(
        input.claimedAuthority.sessionId
    );
    if (
        !session ||
        session.clientId !== input.principalId ||
        session.clientId !== input.claimedAuthority.clientId ||
        session.sessionId !== input.claimedAuthority.sessionId ||
        session.issuedAtEpochMs !== input.claimedAuthority.issuedAtEpochMs ||
        session.expiresAtEpochMs !== input.claimedAuthority.expiresAtEpochMs ||
        session.accessTokenDigest !== (await authSessionProofSecret(input.claimedAuthority)) ||
        session.expiresAtEpochMs <= input.nowEpochMs()
    ) {
        throw new GroupMutationAuthorizationError(
            'Topology mutation session is missing, expired, revoked, or mismatched.'
        );
    }
    return session;
}

function isCurrentTopologyAuthoritySession(
    input: VerifyTopologyAppInboxAuthorityInput,
    session: PersistedAuthSession | undefined
): session is PersistedAuthSession {
    return Boolean(
        session &&
            session.clientId === input.authority.proof.principalId &&
            session.sessionId === input.authority.proof.sessionId &&
            session.issuedAtEpochMs === input.authority.proof.sessionIssuedAtEpochMs &&
            session.expiresAtEpochMs === input.authority.proof.sessionExpiresAtEpochMs &&
            session.expiresAtEpochMs > input.nowEpochMs() &&
            input.authority.command.actor.principalId === input.authority.proof.principalId &&
            input.authority.command.commandHash === input.authority.proof.commandHash
    );
}

export type { TopologyMutationAuthorityProof };

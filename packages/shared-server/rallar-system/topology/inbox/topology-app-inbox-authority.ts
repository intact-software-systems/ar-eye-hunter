import { type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import { authSessionProofSecret } from '../../auth/sessions/auth-session-proof-secret.ts';
import { GroupMutationAuthorizationError } from '../../group-state/group-mutation-authority.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import {
    decodeJsonWireValue,
    hashMutationCommand,
    type JsonWireObject,
    type JsonWireValue
} from '../../protocol/json-wire-identity.ts';
import {
    readAuthenticatedTopologyCommand,
    readDurableTopologyAppInboxCommand,
    readTopologyCommandForValidatedSession
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

export function decodeTopologyAppInboxAuthority(value: unknown): TopologyAppInboxAuthority {
    try {
        const authority = requireTopologyAuthorityObject(
            decodeJsonWireValue(value, 'Topology AppInbox authority'),
            'Topology AppInbox authority'
        );
        requireExactTopologyAuthorityKeys(
            authority,
            ['kind', 'proof', 'command'],
            'Topology AppInbox authority'
        );
        if (authority.kind !== 'topology-config' && authority.kind !== 'topology-reconfigure') {
            throw new TypeError('authority kind is invalid');
        }
        const proof = decodeTopologyMutationAuthorityProof(authority.proof);
        const command = readDurableTopologyAppInboxCommand(authority.command);
        if (authority.kind === 'topology-config') {
            return { kind: authority.kind, proof, command };
        }
        return { kind: authority.kind, proof, command };
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
        (await hashMutationCommand({
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

export function decodeTopologyMutationAuthorityProof(
    value: unknown
): TopologyMutationAuthorityProof {
    const proof = requireTopologyAuthorityObject(
        decodeJsonWireValue(value, 'Topology mutation authority proof'),
        'Topology mutation authority proof'
    );
    requireExactTopologyAuthorityKeys(proof, [
        'version',
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'commandHash',
        'commandMac'
    ], 'Topology mutation authority proof');
    if (proof.version !== 1) {
        throw new TypeError('authority proof fields are invalid');
    }
    return {
        version: proof.version,
        principalId: readTopologyAuthorityString(proof.principalId, 'principalId'),
        sessionId: readTopologyAuthorityString(proof.sessionId, 'sessionId'),
        sessionIssuedAtEpochMs: readTopologyAuthorityEpoch(
            proof.sessionIssuedAtEpochMs,
            'sessionIssuedAtEpochMs'
        ),
        sessionExpiresAtEpochMs: readTopologyAuthorityEpoch(
            proof.sessionExpiresAtEpochMs,
            'sessionExpiresAtEpochMs'
        ),
        commandHash: readTopologyAuthorityString(proof.commandHash, 'commandHash'),
        commandMac: readTopologyAuthorityString(proof.commandMac, 'commandMac')
    };
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

function requireTopologyAuthorityObject(
    value: JsonWireValue | undefined,
    label: string
): JsonWireObject {
    if (!isTopologyAuthorityObject(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isTopologyAuthorityObject(
    value: JsonWireValue | undefined
): value is JsonWireObject {
    return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactTopologyAuthorityKeys(
    value: JsonWireObject,
    expected: readonly string[],
    label: string
): void {
    const actual = Object.keys(value).toSorted();
    const required = [...expected].toSorted();
    if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

function readTopologyAuthorityString(
    value: JsonWireValue | undefined,
    label: string
): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`Topology mutation authority proof ${label} is invalid`);
    }
    return value;
}

function readTopologyAuthorityEpoch(
    value: JsonWireValue | undefined,
    label: string
): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`Topology mutation authority proof ${label} is invalid`);
    }
    return value;
}

export type { TopologyMutationAuthorityProof };

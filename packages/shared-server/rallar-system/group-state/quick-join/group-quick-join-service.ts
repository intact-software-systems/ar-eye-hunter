import type { GroupRef } from '@shared/api/group-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AuthSessionPersistence } from '../../auth/persistence/auth-session-persistence.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import {
    computeMutationCommandDigest,
    encodeJsonWireValue,
    type JsonWireValue
} from '../../protocol/json-wire-identity.ts';
import {
    createGroupMutationAuthorityProof,
    GroupMutationAuthorizationError,
    verifyLiveGroupMutationSession
} from '../group-mutation-authority.ts';
import { GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS } from '../group-state-service-contracts.ts';
import { constantTimeHexEqual } from '../mutation/group-state-crypto.ts';
import { readGroupMutationWithSnapshot } from '../mutation/read/read-group-mutation.ts';
import { toGroupMutationAttemptFacts } from '../mutation/to-group-mutation-attempt-facts.ts';
import { writeGroupMutation } from '../mutation/write/write-group-mutation.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import type { GroupPolicyCapacityConfig } from '../policy/group-membership-admission-policy.ts';
import { computeGroupQuickJoin, matchesGroupQuickJoin, validateGroupQuickJoin } from './compute-group-quick-join.ts';
import {
    decodeGroupQuickJoinCommand,
    decodeGroupQuickJoinIngress,
    decodeQuickJoinGroupRequest
} from './group-quick-join-codec.ts';
import type {
    GroupQuickJoinCandidate,
    GroupQuickJoinCommand,
    GroupQuickJoinComputed,
    GroupQuickJoinIngress,
    GroupQuickJoinInput,
    GroupQuickJoinRead
} from './group-quick-join-contracts.ts';

export namespace GroupQuickJoinService {
    export interface Dependencies {
        readonly repository: GroupStateRepository;
        readonly authSessions: Pick<AuthSessionPersistence, 'findBySessionId'>;
    }

    export interface Config {
        readonly capacity: GroupPolicyCapacityConfig;
        readonly serviceId: string;
        readonly now: () => number;
    }
}

export class GroupQuickJoinService {
    private readonly dependencies: GroupQuickJoinService.Dependencies;
    private readonly config: GroupQuickJoinService.Config;

    constructor(
        dependencies: GroupQuickJoinService.Dependencies,
        config: GroupQuickJoinService.Config
    ) {
        this.dependencies = dependencies;
        this.config = config;
    }

    authorize(input: GroupQuickJoinInput, session: IssuedAuthSession): GroupQuickJoinCommand {
        if (session.expiresAtEpochMs <= this.config.now()) {
            throw new GroupMutationAuthorizationError('Quick Join requires a live authenticated session');
        }
        const request = decodeQuickJoinGroupRequest(input.request);
        return decodeGroupQuickJoinCommand({
            scope: input.scope,
            requestId: request.requestId,
            actorPrincipalId: session.clientId,
            actorSessionId: session.sessionId,
            kind: request.kind ?? null,
            q: request.q ?? null,
            includeEmpty: request.includeEmpty ?? false
        });
    }

    async capture(command: GroupQuickJoinCommand, session: IssuedAuthSession): Promise<GroupQuickJoinIngress> {
        const commandHash = computeMutationCommandDigest(encodeJsonWireValue({
            ...command,
            actorSessionId: null
        }, 'Quick Join semantic command'));
        const payload: Omit<GroupQuickJoinIngress, 'authorityProof'> = {
            command,
            facts: {
                commandHash,
                nowEpochMs: this.config.now(),
                expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
                serviceId: this.config.serviceId,
                eventId: `quick-join-event:${commandHash.slice('sha256:'.length)}`,
                resolvedJoinCode: null,
                joinCodeVerifier: null,
                internalAuthority: 'none',
                capacity: this.config.capacity,
                authenticatedAuthority: {
                    principalId: command.actorPrincipalId,
                    sessionId: command.actorSessionId
                }
            }
        };
        return { ...payload, authorityProof: await createGroupMutationAuthorityProof(session, payload) };
    }

    async read(value: JsonWireValue | undefined, attemptCount: number): Promise<GroupQuickJoinRead> {
        const ingress = decodeGroupQuickJoinIngress(value);
        const facts = toGroupMutationAttemptFacts(ingress.facts, attemptCount, this.config.now());
        await this.verifyAuthority(ingress, facts.attemptAtEpochMs);
        const snapshots = await this.dependencies.repository.listSnapshots(ingress.command.scope);
        const candidates: GroupQuickJoinCandidate[] = [];
        for (const snapshot of snapshots.filter((candidate) => matchesGroupQuickJoin(candidate, ingress.command))) {
            const command = toSelectedJoinCommand(ingress, snapshot.group);
            const read = await readGroupMutationWithSnapshot(this.dependencies.repository, command, null);
            candidates.push({ command, read: read.read, currentSnapshot: read.currentSnapshot });
        }
        return { command: ingress.command, facts, candidates };
    }

    compute(read: GroupQuickJoinRead): GroupQuickJoinComputed {
        return computeGroupQuickJoin(read);
    }

    validate(read: GroupQuickJoinRead, computed: GroupQuickJoinComputed): void {
        const issue = validateGroupQuickJoin(read, computed)[0];
        if (issue) {
            throw issue.cause;
        }
    }

    async write(transaction: PSqlSql, computed: GroupQuickJoinComputed): Promise<void> {
        if (computed.mutation !== null) {
            await writeGroupMutation(transaction, computed.mutation);
        }
    }

    private async verifyAuthority(ingress: GroupQuickJoinIngress, atEpochMs: number): Promise<void> {
        const session = await this.dependencies.authSessions.findBySessionId(ingress.command.actorSessionId);
        verifyLiveGroupMutationSession(ingress.authorityProof, session, atEpochMs);
        if (!session) {
            throw new GroupMutationAuthorizationError('Quick Join session is missing');
        }
        const expected = await createGroupMutationAuthorityProof(session, {
            command: ingress.command,
            facts: ingress.facts
        });
        if (!constantTimeHexEqual(expected.commandMac, ingress.authorityProof.commandMac)) {
            throw new GroupMutationAuthorizationError('Quick Join command proof is invalid');
        }
    }
}

function toSelectedJoinCommand(
    ingress: GroupQuickJoinIngress,
    groupRef: GroupRef
): GroupQuickJoinCandidate['command'] {
    const { command, facts } = ingress;
    return {
        operation: 'joinGroup',
        aggregateRef: { ...command.scope, groupId: groupRef.groupId },
        targetPrincipalId: command.actorPrincipalId,
        commandId: `quick-join:${facts.commandHash}`,
        requestId: command.requestId,
        input: {
            inviteToken: null,
            joinCode: null,
            actorPrincipalId: command.actorPrincipalId,
            actorSessionId: command.actorSessionId,
            reason: null,
            traceId: null
        }
    };
}

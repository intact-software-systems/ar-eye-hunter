import type { GroupRef } from '@shared/api/group-types.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { AppInboxCommandAttempt } from '../../app-inbox/app-inbox-contracts.ts';
import type { AuthSessionPersistence } from '../../auth/persistence/auth-session-persistence.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import {
    computeMutationCommandDigest,
    encodeJsonWireValue,
    type JsonWireValue
} from '../../protocol/json-wire-identity.ts';
import {
    createGroupMutationAuthorityProof,
    GroupMutationAuthorizationError,
    toGroupMutationEventId,
    verifyLiveGroupMutationSession
} from '../group-mutation-authority.ts';
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
        /**
         * How long a command's idempotency record and the outbox rows derived from it stay after its ingress; the
         * AppInbox finish gives the command's fact and result the same window.
         */
        readonly finishedRetentionMs: number;
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
        const nowEpochMs = this.config.now();
        const payload: Omit<GroupQuickJoinIngress, 'authorityProof'> = {
            command,
            facts: {
                commandHash,
                nowEpochMs,
                expireAtEpochMs: nowEpochMs + this.config.finishedRetentionMs,
                serviceId: this.config.serviceId,
                eventId: toGroupMutationEventId(commandHash, nowEpochMs),
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

    async read(value: JsonWireValue | undefined, attempt: AppInboxCommandAttempt): Promise<GroupQuickJoinRead> {
        const ingress = decodeGroupQuickJoinIngress(value);
        const facts = toGroupMutationAttemptFacts({
            ingressFacts: ingress.facts,
            attemptCount: attempt.attemptCount,
            laneNowEpochMs: this.config.now(),
            traceId: attempt.traceId
        });
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

    validate(read: GroupQuickJoinRead, computed: GroupQuickJoinComputed): readonly ComputedDataValidationIssue[] {
        return validateGroupQuickJoin(read, computed);
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

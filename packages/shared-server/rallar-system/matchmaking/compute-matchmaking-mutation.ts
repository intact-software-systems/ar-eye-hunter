import type { MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import type { MatchmakingMutationResult, MatchmakingRefusal } from '@shared/api/matchmaking/matchmaking-request.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    writeRuntimeStateConditionalBatch,
    type RuntimeStateConditionalBatch
} from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { writeAppOutboxInserts, type AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../computed-data-validation.ts';
import {
    GroupMutationRejectedError,
    type GroupMutationComputedWrite
} from '../group-state/mutation/group-mutation-contracts.ts';
import { computeNewGroupCohortAdmission } from '../group-state/mutation/membership/compute-new-group-cohort-admission.ts';
import { writeGroupMutation } from '../group-state/mutation/write/write-group-mutation.ts';
import { GroupPolicyDeniedError } from '../group-state/policy/group-policy-result.ts';
import { computeMatchmakingPublication } from './compute-matchmaking-publication.ts';
import { computeMatchmakingStorage } from './compute-matchmaking-storage.ts';
import { computeMatchmaking } from './compute-matchmaking.ts';
import type { MatchmakingCommand } from './matchmaking-command.ts';
import { computeMatchmakingDeadlines } from './matchmaking-deadline.ts';
import {
    areMatchmakingPartiesCurrent,
    computeMatchmakingPartyGuards,
    computeMatchmakingPartyStart
} from './matchmaking-party-authority.ts';
import type { MatchmakingPartyStart } from './matchmaking-party-search.ts';
import type { MatchmakingActor, MatchmakingIntent, MatchmakingTransition } from './matchmaking-pool.ts';
import type { MatchmakingRepository } from './matchmaking-repository.ts';
import type { MatchmakingService } from './matchmaking-service.ts';

export interface MatchmakingMutation {
    readonly read: MatchmakingService.Read;
    readonly transition: MatchmakingTransition | null;
    readonly storage: RuntimeStateConditionalBatch | null;
    readonly outbox: readonly AppOutboxInsert[];
    readonly admissions: readonly GroupMutationComputedWrite[];
    readonly result: MatchmakingMutationResult;
}

export interface MatchmakingExpiryRead {
    readonly pool: MatchmakingRepository.Read;
    readonly policy: MatchmakingPolicy;
    readonly nowEpochMs: number;
    readonly serviceId: string;
    readonly traceId: string;
    readonly finishedRetentionMs: number;
}

export interface MatchmakingExpiry {
    readonly storage: RuntimeStateConditionalBatch | null;
    readonly outbox: readonly AppOutboxInsert[];
}

export function computeMatchmakingExpiry(read: MatchmakingExpiryRead): MatchmakingExpiry {
    const transition = computeMatchmaking({
        partySearches: read.pool.partySearches,
        pool: read.pool.pool,
        policy: read.policy,
        nowEpochMs: read.nowEpochMs,
        command: { action: 'expire' }
    });
    if (transition.finished.length === 0) {
        return { storage: null, outbox: [] };
    }
    const storage = computeMatchmakingStorage({
        read: read.pool,
        transition,
        finishedRetentionMs: read.finishedRetentionMs
    });
    const publication = computeMatchmakingPublication({
        before: read.pool.pool,
        previousRevision: read.pool.entry?.revision ?? 0,
        transition,
        publication: {
            serviceId: read.serviceId,
            traceId: read.traceId,
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: read.finishedRetentionMs
        }
    });
    return {
        storage: {
            ...storage,
            batch: computeRuntimeStateGuardedBatchWrite({
                ...storage.batch,
                effects: [...storage.batch.effects, ...publication.provenance]
            })
        },
        outbox: publication.outbox
    };
}

export function computeMatchmakingMutation(read: MatchmakingService.Read): MatchmakingMutation {
    const { command } = read;
    if (!isCurrentActor(read, command)) {
        return refused(read, 'unauthorized');
    }
    if (read.finished !== null) {
        return refused(read, 'search-ended');
    }
    if (command.capturedAtEpochMs === null || command.policy === null || command.serviceId === null) {
        throw new TypeError('Matchmaking execution requires winning ingress facts');
    }
    const partyInput = { command, pool: read.pool, authority: read.partyAuthority, nowEpochMs: read.nowEpochMs };
    if (command.request.action === 'start' && read.pool.partyAccounts[command.principalId]!.account.partyId !== null) {
        return refused(read, 'party-required');
    }
    if (!areMatchmakingPartiesCurrent(partyInput)) {
        return refused(read, 'party-changed');
    }
    const partyStart = command.request.action === 'start-party' ? computeMatchmakingPartyStart(partyInput) : null;
    if (partyStart?.left !== undefined) {
        return refused(read, partyStart.left);
    }
    const proposed = computeMatchmaking({
        partySearches: read.pool.partySearches,
        pool: read.pool.pool,
        policy: command.policy,
        nowEpochMs: read.nowEpochMs,
        command: toMatchmakingIntent(command, command.capturedAtEpochMs, partyStart?.right ?? null)
    });
    const admissions = proposed.admission === null ? [] : computeAdmission(read, proposed);
    const transition = proposed.admission !== null && admissions.length === 0 ? failedAdmission(proposed) : proposed;
    return computeAcceptedMatchmakingMutation({ read, transition, admissions, serviceId: command.serviceId });
}

interface AcceptedMatchmakingMutationInput {
    readonly read: MatchmakingService.Read;
    readonly transition: MatchmakingTransition;
    readonly admissions: readonly GroupMutationComputedWrite[];
    readonly serviceId: string;
}

function computeAcceptedMatchmakingMutation(input: AcceptedMatchmakingMutationInput): MatchmakingMutation {
    const { read, transition, admissions, serviceId } = input;
    const { command } = read;
    const publication = computeMatchmakingPublication({
        before: read.pool.pool,
        previousRevision: read.pool.entry?.revision ?? 0,
        transition,
        publication: {
            serviceId,
            traceId: read.attempt.traceId,
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: read.finishedRetentionMs
        }
    });
    const storage = computeAuthorizedMatchmakingStorage(read, transition, publication.provenance);
    return {
        read,
        transition,
        storage,
        admissions,
        outbox: [
            ...publication.outbox,
            ...computeMatchmakingDeadlines({
                before: read.pool.pool,
                after: transition.pool,
                createdAtEpochMs: read.nowEpochMs,
                retentionMs: read.finishedRetentionMs,
                serviceId,
                traceId: read.attempt.traceId
            })
        ],
        result: {
            scope: command.scope,
            principalId: command.principalId,
            requestId: command.requestId,
            status: transition.rejection === null ? 'applied' : 'refused',
            searchId: transition.searchId,
            code: transition.rejection
        }
    };
}

function toMatchmakingIntent(
    command: MatchmakingCommand,
    capturedAtEpochMs: number,
    party: MatchmakingPartyStart | null
): MatchmakingIntent {
    const actor = {
        principalId: command.principalId,
        sessionId: command.sessionId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs,
        capturedAtEpochMs
    };
    if (command.request.action === 'start-party') {
        if (party === null) {
            throw new TypeError('Party search intent requires its admitted roster');
        }
        return { ...command.request, ...actor, party };
    }
    return { ...command.request, ...actor };
}

function computeAuthorizedMatchmakingStorage(
    read: MatchmakingService.Read,
    transition: MatchmakingTransition,
    provenance: readonly RuntimeStateGuardedBatchEffect[]
): RuntimeStateConditionalBatch {
    const prepared = computeMatchmakingStorage({
        read: read.pool,
        transition,
        finishedRetentionMs: read.finishedRetentionMs
    });
    const authority = read.sessions.map((session): RuntimeStateGuardedBatchEffect => ({
        effectId: `auth:${session.value.sessionId}`,
        operation: 'update',
        namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
        key: session.entry.key,
        value: session.entry.value,
        expireAtTimestamp: session.entry.expireAtTimestamp,
        expectedRevision: session.entry.revision
    }));
    return {
        creation: prepared.creation,
        inserts: prepared.inserts,
        batch: computeRuntimeStateGuardedBatchWrite({
            ...prepared.batch,
            effects: [
                ...prepared.batch.effects,
                ...authority,
                ...computeMatchmakingPartyGuards(read.partyAuthority),
                ...provenance
            ]
        })
    };
}

export function validateMatchmakingMutation(
    read: MatchmakingService.Read,
    computed: MatchmakingMutation
): readonly ComputedDataValidationIssue[] {
    return validateComputedProjection(computeMatchmakingMutation(read), computed, 'Matchmaking mutation');
}

export async function writeMatchmakingMutation(transaction: PSqlSql, computed: MatchmakingMutation): Promise<void> {
    if (computed.storage === null) {
        return;
    }
    await writeRuntimeStateConditionalBatch(transaction, computed.storage);
    await writeAppOutboxInserts(transaction, computed.outbox);
    for (const admission of computed.admissions) {
        await writeGroupMutation(transaction, admission);
    }
}

function isCurrentActor(read: MatchmakingService.Read, actor: MatchmakingActor): boolean {
    const session = read.sessions.find((stored) => stored.value.sessionId === actor.sessionId)?.value;
    return session !== undefined && session.clientId === actor.principalId &&
        session.issuedAtEpochMs === actor.sessionIssuedAtEpochMs &&
        session.expiresAtEpochMs === actor.sessionExpiresAtEpochMs &&
        session.expiresAtEpochMs > read.nowEpochMs;
}

function computeAdmission(
    read: MatchmakingService.Read,
    transition: MatchmakingTransition
): readonly GroupMutationComputedWrite[] {
    if (transition.admission === null || read.admission === null) {
        throw new TypeError('Final confirmation requires complete group admission reads');
    }
    if (!transition.admission.participants.every((actor) => isCurrentActor(read, actor))) {
        return [];
    }
    const creation = read.admission.creation.read;
    if (
        creation.group !== null || creation.expiredGroupEntry !== null || creation.retiredGroup !== null ||
        creation.idempotency !== null
    ) {
        return [];
    }
    try {
        const admitted = computeNewGroupCohortAdmission(read.admission);
        if (admitted.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        return admitted.status === 'admitted' ? admitted.mutations : [];
    }
    catch (error) {
        if (error instanceof GroupMutationRejectedError || error instanceof GroupPolicyDeniedError) {
            return [];
        }
        throw error;
    }
}

function failedAdmission(transition: MatchmakingTransition): MatchmakingTransition {
    return {
        ...transition,
        admission: null,
        finished: transition.finished.map((search) =>
            search.reason !== 'matched' ? search : {
                ...search,
                reason: 'admission-denied',
                roomRef: null,
                leaderPrincipalId: null
            }
        )
    };
}

function refused(read: MatchmakingService.Read, code: MatchmakingRefusal): MatchmakingMutation {
    const { command } = read;
    return {
        read,
        transition: null,
        storage: null,
        admissions: [],
        outbox: [],
        result: {
            scope: command.scope,
            principalId: command.principalId,
            requestId: command.requestId,
            status: 'refused',
            searchId: command.request.searchId,
            code
        }
    };
}

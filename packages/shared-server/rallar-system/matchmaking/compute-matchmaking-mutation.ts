import type { MatchmakingMutationResult, MatchmakingRefusal } from '@shared/api/matchmaking/matchmaking-request.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchWrite
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { writeAppOutboxInserts, type AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../computed-data-validation.ts';
import {
    GroupMutationRejectedError,
    type GroupMutationComputedWrite
} from '../group-state/mutation/group-mutation-contracts.ts';
import { computeNewGroupCohortAdmission } from '../group-state/mutation/membership/compute-group-cohort-admission.ts';
import { writeGroupMutation } from '../group-state/mutation/write/write-group-mutation.ts';
import { GroupPolicyDeniedError } from '../group-state/policy/group-policy-result.ts';
import { computeMatchmaking } from './compute-matchmaking.ts';
import { computeMatchmakingDeadlines } from './matchmaking-deadline.ts';
import type { MatchmakingActor, MatchmakingTransition } from './matchmaking-pool.ts';
import { computeMatchmakingStorage, writeMatchmakingStorage } from './matchmaking-repository.ts';
import type { MatchmakingService } from './matchmaking-service.ts';

export interface MatchmakingMutation {
    readonly read: MatchmakingService.Read;
    readonly transition: MatchmakingTransition | null;
    readonly storage: RuntimeStateGuardedBatchWrite | null;
    readonly deadlines: readonly AppOutboxInsert[];
    readonly admissions: readonly GroupMutationComputedWrite[];
    readonly result: MatchmakingMutationResult;
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
    const proposed = computeMatchmaking({
        pool: read.pool.pool,
        policy: command.policy,
        nowEpochMs: read.nowEpochMs,
        command: {
            ...command.request,
            principalId: command.principalId,
            sessionId: command.sessionId,
            sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
            sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs,
            capturedAtEpochMs: command.capturedAtEpochMs
        }
    });
    const admissions = proposed.admission === null ? [] : computeAdmission(read, proposed);
    const transition = proposed.admission !== null && admissions.length === 0 ? failedAdmission(proposed) : proposed;
    const storage = computeAuthorizedMatchmakingStorage(read, transition);
    return {
        read,
        transition,
        storage,
        admissions,
        deadlines: computeMatchmakingDeadlines({
            before: read.pool.pool,
            after: transition.pool,
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: read.finishedRetentionMs,
            serviceId: command.serviceId,
            traceId: read.attempt.traceId
        }),
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

function computeAuthorizedMatchmakingStorage(
    read: MatchmakingService.Read,
    transition: MatchmakingTransition
): RuntimeStateGuardedBatchWrite {
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
    return computeRuntimeStateGuardedBatchWrite({ ...prepared, effects: [...prepared.effects, ...authority] });
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
    await writeMatchmakingStorage(transaction, computed.storage);
    await writeAppOutboxInserts(transaction, computed.deadlines);
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
        deadlines: [],
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

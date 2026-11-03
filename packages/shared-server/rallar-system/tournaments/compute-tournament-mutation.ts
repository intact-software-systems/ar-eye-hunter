import type { TournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { Tournament } from '@shared/api/tournaments/tournament-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeTournament, createTournament } from '@shared/tournaments/compute-tournament.ts';
import type { TournamentCommand } from '@shared/tournaments/tournament-command.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateConditionalBatch } from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '../auth/persistence/auth-storage-keys.ts';
import {
    GroupMutationRejectedError,
    type GroupMutationComputedWrite
} from '../group-state/mutation/group-mutation-contracts.ts';
import {
    computeNewGroupCohortAdmission
} from '../group-state/mutation/membership/compute-new-group-cohort-admission.ts';
import { GroupPolicyDeniedError } from '../group-state/policy/group-policy-result.ts';
import type { TournamentGameProfile } from './tournament-game-profile.ts';
import type { TournamentRepository } from './tournament-repository.ts';
import { computeTournamentStorage } from './tournament-repository.ts';
import type { TournamentService } from './tournament-service.ts';
import { computeTournamentLifecycleSignals } from './tournament-signals.ts';

export function computeTournamentMutation(read: TournamentService.Read): TournamentService.Computed {
    const { command } = read;
    if (command.materialized === null) {
        throw new TypeError('Tournament execution lacks captured facts');
    }
    if (command.request.type !== 'reconcile' && (command.actor === null || !isCurrentActor(read, command.actor))) {
        return refused(read, 'unauthorized');
    }
    const profile = command.materialized.profile;
    if (profile === null) {
        return refused(read, 'unsupported-game');
    }
    if (command.request.type === 'create') {
        return computeTournamentCreation(read, profile);
    }
    const before = read.bracket.record;
    if (before === null) {
        return refused(read, 'tournament-not-found');
    }
    if (before.tournament.rulesId !== profile.rulesId) {
        return refused(read, 'unsupported-rules');
    }
    const decision = computeTournament({
        state: before.tournament,
        command: toDomainCommand(command),
        actorPrincipalId: command.actor?.principalId ?? null,
        nowEpochMs: read.nowEpochMs,
        results: read.bracket.attempts.flatMap((attempt) => attempt.result === null ? [] : [attempt.result])
    });
    const checkIns = computeCheckInConsent(read, decision.state, decision.refusal === null);
    const record = { tournament: decision.state, checkIns };
    let admissions: readonly GroupMutationComputedWrite[] = [];
    if (command.request.type === 'start' && decision.refusal === null) {
        const request = command.request;
        if (
            !checkIns.filter((consent) => consent.slot === request.slot && consent.attemptId === request.attemptId)
                .every((consent) => isCurrentActor(read, consent.actor))
        ) {
            return refused(read, 'check-in-session-expired');
        }
        const admitted = computeTournamentAdmission(read);
        if (admitted === null) {
            return refused(read, 'admission-denied');
        }
        admissions = admitted;
    }
    return {
        result: result(read, decision.refusal),
        admissions,
        outbox: computeTournamentLifecycleSignals(read, record.tournament),
        storage: jsonEquals(before, record) ? null : authorizedStorage(read, record)
    };
}

function computeTournamentCreation(
    read: TournamentService.Read,
    profile: TournamentGameProfile
): TournamentService.Computed {
    const { command } = read;
    if (command.request.type !== 'create' || command.actor === null || command.materialized === null) {
        throw new TypeError('Tournament creation lacks authority');
    }
    if (read.bracket.record !== null) {
        return refused(read, 'tournament-exists');
    }
    const tournament = createTournament({
        ref: command.ref,
        title: command.request.title,
        organizerPrincipalId: command.actor.principalId,
        rulesId: profile.rulesId,
        createdAtEpochMs: command.materialized.capturedAtEpochMs,
        noShowGraceMs: profile.noShowGraceMs
    });
    return {
        result: result(read, null),
        admissions: [],
        outbox: [],
        storage: authorizedStorage(read, { tournament, checkIns: [] })
    };
}

function toDomainCommand(command: TournamentService.Command): TournamentCommand {
    const request = command.request;
    if (request.type === 'create') {
        throw new TypeError('Tournament creation is not an existing-bracket command');
    }
    if (request.type === 'schedule') {
        if (!command.materialized?.schedule) {
            throw new TypeError('Tournament scheduling lacks winning identities');
        }
        return { ...request, ...command.materialized.schedule };
    }
    return request;
}

function isCurrentActor(read: TournamentService.Read, actor: TournamentRepository.Actor): boolean {
    const session = read.sessions.find((session) => session.value.sessionId === actor.sessionId)?.value;
    return session !== undefined && session.clientId === actor.principalId &&
        session.issuedAtEpochMs === actor.issuedAtEpochMs && session.expiresAtEpochMs > read.nowEpochMs;
}

function authorizedStorage(
    read: TournamentService.Read,
    record: TournamentRepository.Record
): RuntimeStateConditionalBatch {
    const prepared = computeTournamentStorage(read.bracket, record);
    return {
        ...prepared,
        batch: computeRuntimeStateGuardedBatchWrite({
            guard: prepared.batch.guard,
            effects: [
                ...prepared.batch.effects,
                ...read.sessions.map((session) => ({
                    effectId: `session:${session.value.sessionId}`,
                    operation: 'update' as const,
                    namespace: AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                    key: session.entry.key,
                    value: session.entry.value,
                    expectedRevision: session.entry.revision,
                    expireAtTimestamp: session.entry.expireAtTimestamp
                }))
            ]
        })
    };
}

function computeTournamentAdmission(read: TournamentService.Read): readonly GroupMutationComputedWrite[] | null {
    if (read.admission === null) {
        return null;
    }
    const creation = read.admission.creation.read;
    if (
        creation.group !== null || creation.expiredGroupEntry !== null || creation.retiredGroup !== null ||
        creation.idempotency !== null
    ) {
        return null;
    }
    try {
        const admission = computeNewGroupCohortAdmission(read.admission);
        if (admission.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        return admission.status === 'admitted' ? admission.mutations : null;
    }
    catch (error) {
        if (error instanceof GroupMutationRejectedError || error instanceof GroupPolicyDeniedError) {
            return null;
        }
        throw error;
    }
}

function refused(read: TournamentService.Read, code: string): TournamentService.Computed {
    return { result: result(read, code), storage: null, admissions: [], outbox: [] };
}
function result(read: TournamentService.Read, code: string | null): TournamentMutationResult {
    return {
        ref: read.command.ref,
        requestId: read.command.requestId,
        status: code === null ? 'applied' : 'refused',
        code
    };
}

function computeCheckInConsent(
    read: TournamentService.Read,
    after: Tournament,
    accepted: boolean
): readonly TournamentRepository.CheckIn[] {
    const { command } = read;
    const checkIns = read.bracket.record!.checkIns.filter((consent) =>
        after.matches.some((match) =>
            match.slot === consent.slot && match.attempt?.binding.attemptId === consent.attemptId
        )
    );
    if (command.request.type === 'check-in' && accepted && command.actor !== null) {
        const request = command.request;
        const retained = checkIns.filter((consent) =>
            consent.slot !== request.slot || consent.actor.principalId !== command.actor!.principalId
        );
        checkIns.splice(0, checkIns.length, ...retained, {
            slot: request.slot,
            attemptId: request.attemptId,
            actor: command.actor
        });
    }
    return checkIns;
}

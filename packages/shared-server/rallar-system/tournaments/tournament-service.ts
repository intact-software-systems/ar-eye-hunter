import type { TournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { TournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import {
    writeRuntimeStateConditionalBatch,
    type RuntimeStateConditionalBatch
} from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { AppInboxCommandAttempt } from '../app-inbox/app-inbox-contracts.ts';
import { writeAppOutboxInserts, type AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../computed-data-validation.ts';
import type { GroupMutationComputedWrite } from '../group-state/mutation/group-mutation-contracts.ts';
import type { NewGroupCohortAdmissionInput } from '../group-state/mutation/membership/compute-new-group-cohort-admission.ts';
import { readNewGroupCohortAdmission } from '../group-state/mutation/membership/read-new-group-cohort-admission.ts';
import { writeGroupMutation } from '../group-state/mutation/write/write-group-mutation.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { computeTournamentMutation } from './compute-tournament-mutation.ts';
import { decodeTournamentCommand } from './decode-tournament-command.ts';
import { decodeTournamentGameProfiles, type TournamentGameProfile } from './tournament-game-profile.ts';
import type { TournamentRepository } from './tournament-repository.ts';
import { TOURNAMENT_SIGNAL_RETENTION_MS } from './tournament-signal.ts';

export namespace TournamentService {
    export interface ScheduleIdentity {
        readonly attemptId: string;
        readonly roomId: string;
        readonly gameId: string;
    }
    export interface Materialized {
        readonly capturedAtEpochMs: number;
        readonly profile: TournamentGameProfile | null;
        readonly schedule: ScheduleIdentity | null;
    }
    export interface Command {
        readonly ref: TournamentRef;
        readonly requestId: string;
        readonly actor: TournamentRepository.Actor | null;
        readonly request: TournamentRequest | { readonly type: 'reconcile'; };
        readonly materialized: Materialized | null;
    }
    export interface Dependencies {
        readonly repository: TournamentRepository;
        readonly sessions: Pick<AuthSessionPersistence, 'findSessionBySessionIdEntry'>;
        readonly groups: GroupStateRepository;
    }
    export interface Config {
        readonly profiles: readonly TournamentGameProfile[];
        readonly nowEpochMs: () => number;
        readonly createId: () => string;
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
    }
    export interface Read {
        readonly command: Command;
        readonly nowEpochMs: number;
        readonly bracket: TournamentRepository.Read;
        readonly sessions: readonly RuntimeStateEntryValue<PersistedAuthSession>[];
        readonly admission: NewGroupCohortAdmissionInput | null;
        readonly serviceId: string;
        readonly traceId: string;
        readonly signalRetentionMs: number;
    }
    export interface Computed {
        readonly result: TournamentMutationResult;
        readonly storage: RuntimeStateConditionalBatch | null;
        readonly admissions: readonly GroupMutationComputedWrite[];
        readonly outbox: readonly AppOutboxInsert[];
    }
}

/** One tournament mutation attempt. AppInbox owns command replay, transactions and conflict retry. */
export class TournamentService {
    private readonly dependencies: TournamentService.Dependencies;
    private readonly config: TournamentService.Config;
    constructor(dependencies: TournamentService.Dependencies, config: TournamentService.Config) {
        this.dependencies = dependencies;
        this.config = { ...config, profiles: decodeTournamentGameProfiles(config.profiles) };
    }
    materialize(input: TournamentService.Command): TournamentService.Command {
        const command = decodeTournamentCommand(input);
        const profile =
            this.config.profiles.find((profile) =>
                profile.scope.applicationId === command.ref.applicationId &&
                profile.scope.workspaceId === command.ref.workspaceId
            ) ?? null;
        const roomId = command.request.type === 'schedule' ? this.config.createId() : null;
        return {
            ...command,
            materialized: {
                capturedAtEpochMs: this.config.nowEpochMs(),
                profile,
                schedule: roomId === null ? null : { attemptId: this.config.createId(), roomId, gameId: roomId }
            }
        };
    }
    async read(input: TournamentService.Command, attempt: AppInboxCommandAttempt): Promise<TournamentService.Read> {
        const command = decodeTournamentCommand(input);
        if (command.materialized === null) {
            throw new TypeError('Tournament attempt lacks winning ingress facts');
        }
        const bracket = await this.dependencies.repository.read(command.ref);
        const request = command.request;
        const checkIns = request.type === 'start'
            ? (bracket.record?.checkIns ?? []).filter((consent) =>
                consent.slot === request.slot && consent.attemptId === request.attemptId
            )
            : [];
        const ids = [
            ...new Set([
                ...(command.actor === null ? [] : [command.actor.sessionId]),
                ...checkIns.map((consent) => consent.actor.sessionId)
            ])
        ].sort();
        const sessions =
            (await Promise.all(ids.map((id) => this.dependencies.sessions.findSessionBySessionIdEntry(id)))).filter(
                (session) => session !== undefined
            );
        // Native owners use monotonic state clocks; accepted result facts advance this attempt's clock too.
        const nowEpochMs = Math.max(
            this.config.nowEpochMs(),
            command.materialized.capturedAtEpochMs,
            ...bracket.attempts.map((attempt) => attempt.result?.finishedAtEpochMs ?? 0)
        );
        const admission = await this.readAdmission(command, bracket, nowEpochMs, attempt);
        return {
            command,
            bracket,
            sessions,
            admission,
            nowEpochMs,
            serviceId: this.config.serviceId,
            traceId: attempt.traceId,
            signalRetentionMs: TOURNAMENT_SIGNAL_RETENTION_MS
        };
    }
    compute(read: TournamentService.Read): TournamentService.Computed {
        return computeTournamentMutation(read);
    }
    validate(
        read: TournamentService.Read,
        computed: TournamentService.Computed
    ): readonly ComputedDataValidationIssue[] {
        return validateComputedProjection(computeTournamentMutation(read), computed, 'tournament');
    }
    async write(transaction: PSqlSql, computed: TournamentService.Computed): Promise<void> {
        if (computed.storage === null) {
            return;
        }
        await writeRuntimeStateConditionalBatch(transaction, computed.storage);
        for (const admission of computed.admissions) {
            await writeGroupMutation(transaction, admission);
        }
        await writeAppOutboxInserts(transaction, computed.outbox);
    }
    private async readAdmission(
        command: TournamentService.Command,
        bracket: TournamentRepository.Read,
        nowEpochMs: number,
        attempt: AppInboxCommandAttempt
    ): Promise<NewGroupCohortAdmissionInput | null> {
        if (command.request.type !== 'start' || bracket.record === null || command.materialized === null) {
            return null;
        }
        const request = command.request;
        const match = bracket.record.tournament.matches.find((match) =>
            match.slot === request.slot && match.attempt?.binding.attemptId === request.attemptId
        );
        if (!match?.attempt || match.attempt.checkedInPrincipalIds.length !== 2 || match.status !== 'scheduled') {
            return null;
        }
        const binding = match.attempt.binding;
        const participants = binding.principalIds.map((principalId) => {
            const consent = bracket.record!.checkIns.find((consent) =>
                consent.slot === binding.slot && consent.attemptId === binding.attemptId &&
                consent.actor.principalId === principalId
            );
            if (!consent) {
                throw new TypeError('Tournament admission lacks exact check-in consent');
            }
            return {
                principalId,
                sessionId: consent.actor.sessionId,
                requestId: `tournament:${binding.attemptId}:${principalId}`
            };
        });
        return await readNewGroupCohortAdmission({
            groups: this.dependencies.groups,
            roomRef: binding.roomRef,
            displayName: bracket.record.tournament.title,
            participants,
            maxSpectators: 16,
            reconnectGraceMs: 900000,
            capturedAtEpochMs: command.materialized.capturedAtEpochMs,
            serviceId: this.config.serviceId,
            nowEpochMs,
            attemptCount: attempt.attemptCount,
            traceId: attempt.traceId,
            finishedRetentionMs: this.config.finishedRetentionMs
        });
    }
}

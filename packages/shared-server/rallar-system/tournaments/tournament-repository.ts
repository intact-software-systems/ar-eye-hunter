import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import { decodeTournament } from '@shared/api/tournaments/decode-tournament.ts';
import type { Tournament, TournamentMatch, TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateInsert } from '../../runtime-state/postgres/insert-runtime-state.ts';
import type { RuntimeStateConditionalBatch } from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import {
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeJsonWireText } from '../protocol/json-wire-identity.ts';
import { TOURNAMENT_ATTEMPTS_NAMESPACE, TournamentResultRepository } from './tournament-result-repository.ts';

export const TOURNAMENTS_NAMESPACE = 'tournaments:brackets';

export namespace TournamentRepository {
    /** Private captured check-in authority; public views expose only principal IDs. */
    export interface Actor {
        readonly principalId: string;
        readonly sessionId: string;
        readonly issuedAtEpochMs: number;
    }
    export interface CheckIn {
        readonly slot: TournamentMatch['slot'];
        readonly attemptId: string;
        readonly actor: Actor;
    }
    export interface Record {
        readonly tournament: Tournament;
        readonly checkIns: readonly CheckIn[];
    }
    export interface Read {
        readonly ref: TournamentRef;
        readonly entry: RuntimeStateEntry | null;
        readonly record: Record | null;
        readonly attempts: readonly TournamentResultRepository.Read[];
    }
}

/** The bracket CAS owns registration, private check-in consent and granting/revoking exact game attempts. */
export class TournamentRepository {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>;
    private readonly results: TournamentResultRepository;
    constructor(runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>) {
        this.runtime = runtime;
        this.results = new TournamentResultRepository(runtime);
    }
    async readRecord(value: TournamentRef): Promise<Pick<TournamentRepository.Read, 'ref' | 'entry' | 'record'>> {
        const ref = decodeTournamentRef(value);
        const entry = await this.runtime.findEntry(TOURNAMENTS_NAMESPACE, tournamentStorageKey(ref));
        if (entry === undefined) {
            return { ref, entry: null, record: null };
        }
        if (entry.key !== tournamentStorageKey(ref) || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
            throw new TypeError('Tournament storage identity or lifetime differs');
        }
        const record = decodeTournamentRecord(decodeJsonWireText(entry.value));
        if (!jsonEquals(record.tournament.ref, ref)) {
            throw new TypeError('Tournament differs from its scoped storage key');
        }
        return { ref, entry, record };
    }
    async read(value: TournamentRef): Promise<TournamentRepository.Read> {
        const { ref, entry, record } = await this.readRecord(value);
        if (record === null) {
            return { ref, entry, record, attempts: [] };
        }
        const attempts = await Promise.all(
            record.tournament.matches.flatMap((match) =>
                match.attempt === null ? [] : [this.results.read(match.attempt.binding)]
            )
        );
        if (attempts.some((attempt) => attempt.attemptEntry === null)) {
            throw new TypeError('Tournament has lost a private attempt');
        }
        return { ref, entry, record, attempts };
    }
}

export function tournamentStorageKey(ref: TournamentRef): string {
    return `${groupStateScopeStorageKey(ref)}:tournament=${encodeURIComponent(ref.tournamentId)}`;
}

export function decodeTournamentActor(value: unknown): TournamentRepository.Actor {
    const actor = requireRecord(value, 'Tournament actor');
    requireExactKeys(actor, ['principalId', 'sessionId', 'issuedAtEpochMs'], 'Tournament actor');
    requireEpoch(actor.issuedAtEpochMs, 'Tournament session issuance');
    return {
        principalId: assertValidRallarRouteId(actor.principalId),
        sessionId: assertValidRallarRouteId(actor.sessionId),
        issuedAtEpochMs: actor.issuedAtEpochMs
    };
}

export function decodeTournamentRecord(value: unknown): TournamentRepository.Record {
    const record = requireRecord(value, 'Tournament record');
    requireExactKeys(record, ['tournament', 'checkIns'], 'Tournament record');
    const tournament = decodeTournament(record.tournament);
    if (!Array.isArray(record.checkIns) || record.checkIns.length > 6) {
        throw new TypeError('Tournament private check-ins are invalid');
    }
    const checkIns = record.checkIns.map(decodeCheckIn);
    const expected = tournament.matches.flatMap((match) =>
        match.attempt?.checkedInPrincipalIds.map((principalId) =>
            JSON.stringify([match.slot, match.attempt!.binding.attemptId, principalId])
        ) ?? []
    );
    const actual = checkIns.map((checkIn) =>
        JSON.stringify([checkIn.slot, checkIn.attemptId, checkIn.actor.principalId])
    );
    if (!jsonEquals([...expected].sort(), actual.sort())) {
        throw new TypeError('Private tournament consent differs from public check-ins');
    }
    return { tournament, checkIns };
}

function decodeCheckIn(value: unknown): TournamentRepository.CheckIn {
    const checkIn = requireRecord(value, 'Tournament check-in');
    requireExactKeys(checkIn, ['slot', 'attemptId', 'actor'], 'Tournament check-in');
    return {
        slot: requireOneOf(checkIn.slot, ['semifinal-1', 'semifinal-2', 'final'], 'Tournament slot'),
        attemptId: assertValidRallarRouteId(checkIn.attemptId),
        actor: decodeTournamentActor(checkIn.actor)
    };
}

/** Prepared before transaction entry; room admission and AppInbox completion join this exact write transaction. */
export function computeTournamentStorage(
    read: TournamentRepository.Read,
    value: TournamentRepository.Record
): RuntimeStateConditionalBatch {
    const record = decodeTournamentRecord(value);
    if (!jsonEquals(record.tournament.ref, read.ref)) {
        throw new TypeError('Tournament write changes its scoped identity');
    }
    const key = tournamentStorageKey(read.ref);
    const serialized = JSON.stringify(record);
    const expireAtIsoTimestamp = new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString();
    const changes = computeAttemptChanges(read, record.tournament);
    return {
        creation: read.entry === null
            ? { namespace: TOURNAMENTS_NAMESPACE, key, value: serialized, expireAtIsoTimestamp }
            : null,
        batch: computeRuntimeStateGuardedBatchWrite({
            guard: {
                operation: 'update',
                namespace: TOURNAMENTS_NAMESPACE,
                key,
                value: serialized,
                expectedRevision: read.entry?.revision ?? 0,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            },
            effects: changes.effects
        }),
        inserts: changes.inserts
    };
}

interface TournamentAttemptChanges {
    readonly effects: readonly RuntimeStateGuardedBatchEffect[];
    readonly inserts: readonly RuntimeStateInsert[];
}

function computeAttemptChanges(read: TournamentRepository.Read, after: Tournament): TournamentAttemptChanges {
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    const inserts: RuntimeStateInsert[] = [];
    for (const current of read.attempts) {
        const desired = computeTournamentAttemptState(current, after);
        if (current.attempt?.status === 'finished' || jsonEquals(current.attempt, desired)) {
            continue;
        }
        if (current.attemptEntry === null) {
            throw new TypeError('Tournament attempt update lacks its predecessor');
        }
        effects.push({
            effectId: `attempt:${current.binding.attemptId}`,
            operation: 'update',
            namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
            key: current.attemptEntry.key,
            value: JSON.stringify(desired),
            expectedRevision: current.attemptEntry.revision,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
    }
    for (const match of after.matches) {
        if (
            match.attempt === null ||
            read.attempts.some((current) => jsonEquals(current.binding, match.attempt!.binding))
        ) {
            continue;
        }
        inserts.push({
            namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
            key: groupStateGroupStorageKey(match.attempt.binding.roomRef),
            value: JSON.stringify(toPrivateTournamentAttempt(after, match)),
            expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
        });
    }
    return { effects, inserts };
}

/** One lifecycle decision shared by the private write and its durable notification. */
export function computeTournamentAttemptState(
    current: TournamentResultRepository.Read,
    after: Tournament
): TournamentResultRepository.Attempt {
    if (current.attempt === null) {
        throw new TypeError('Tournament attempt transition lacks its predecessor');
    }
    if (current.attempt.status === 'finished') {
        return current.attempt;
    }
    const match = after.matches.find((match) =>
        match.slot === current.binding.slot && match.attempt?.binding.attemptId === current.binding.attemptId
    );
    return match === undefined
        ? { ...current.attempt, status: 'cancelled' }
        : toPrivateTournamentAttempt(after, match);
}

function toPrivateTournamentAttempt(
    tournament: Tournament,
    match: TournamentMatch
): TournamentResultRepository.Attempt {
    if (match.attempt === null) {
        throw new TypeError('Tournament private authority requires a bound attempt');
    }
    const cancelled = tournament.status === 'cancelled' || ['unresolved', 'cancelled'].includes(match.status) ||
        match.resolution !== null && match.resolution.reason !== 'score';
    const status = cancelled ? 'cancelled' : match.status === 'playing'
        ? 'playing'
        : match.status === 'tied' || match.resolution?.reason === 'score'
        ? 'finished'
        : 'scheduled';
    return { binding: match.attempt.binding, status, startedAtEpochMs: match.attempt.startedAtEpochMs };
}

import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeTournamentMatchBinding } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentMatchBinding, TournamentMatchResult } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateConditionalBatch } from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { assertRuntimeStateReadBatchResult } from '../../runtime-state/read-batch/assert-runtime-state-read-batch-result.ts';
import type { RuntimeStateReadBatchSelector } from '../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import { groupStateGroupStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeJsonWireText, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodeTournamentResult, tournamentResultKey } from './tournament-result.ts';

export const TOURNAMENT_ATTEMPTS_NAMESPACE = 'tournaments:attempts';
export const TOURNAMENT_RESULTS_NAMESPACE = 'tournaments:results';

export namespace TournamentResultRepository {
    /** The tournament owner grants/revokes this attempt; the game finalizer consumes its exact revision. */
    export interface Attempt {
        readonly binding: TournamentMatchBinding;
        readonly status: 'scheduled' | 'playing' | 'finished' | 'cancelled';
        readonly startedAtEpochMs: number | null;
    }

    export interface Read {
        readonly binding: TournamentMatchBinding;
        readonly attemptEntry: RuntimeStateEntry | null;
        readonly attempt: Attempt | null;
        readonly result: TournamentMatchResult | null;
    }

    export type Publication =
        | { readonly kind: 'publish'; readonly storage: RuntimeStateConditionalBatch; }
        | { readonly kind: 'replay'; readonly result: TournamentMatchResult; }
        | { readonly kind: 'refused'; readonly reason: 'inactive-attempt'; };
}

/** Private rows: no AppData publication or client mutation surface can manufacture a trusted result. */
export class TournamentResultRepository {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>;

    constructor(runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>) {
        this.runtime = runtime;
    }

    async readRoom(ref: GroupRef): Promise<TournamentResultRepository.Read | null> {
        const key = groupStateGroupStorageKey(ref);
        const entry = await this.runtime.findEntry(TOURNAMENT_ATTEMPTS_NAMESPACE, key);
        if (entry === undefined) {
            return null;
        }
        const stored = requireRecord(readStoredValue(entry, key), 'Tournament room attempt');
        const binding = decodeTournamentMatchBinding(stored.binding);
        if (!jsonEquals(binding.roomRef, ref)) {
            throw new TypeError('Tournament attempt room differs from its storage slot');
        }
        return await this.read(binding);
    }

    async read(expected: TournamentMatchBinding): Promise<TournamentResultRepository.Read> {
        const binding = decodeTournamentMatchBinding(expected);
        const key = tournamentResultKey(binding);
        const selectors: RuntimeStateReadBatchSelector[] = [
            {
                selectorId: 'attempt',
                kind: 'key',
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: groupStateGroupStorageKey(binding.roomRef)
            },
            { selectorId: 'result', kind: 'key', namespace: TOURNAMENT_RESULTS_NAMESPACE, key }
        ];
        const selections = assertRuntimeStateReadBatchResult(
            selectors,
            await this.runtime.readRuntimeStateBatch(selectors)
        );
        const attemptEntry = selections[0].entries[0] ?? null;
        const resultEntry = selections[1].entries[0] ?? null;
        const attempt = attemptEntry === null
            ? null
            : decodeTournamentAttempt(
                readStoredValue(attemptEntry, groupStateGroupStorageKey(binding.roomRef)),
                binding
            );
        const result = resultEntry === null ? null : decodeTournamentResult(readStoredValue(resultEntry, key), binding);
        if ((attempt?.status === 'finished') !== (result !== null)) {
            throw new TypeError('Tournament finished attempt and result must exist together');
        }
        if (result !== null && result.startedAtEpochMs !== attempt?.startedAtEpochMs) {
            throw new TypeError('Tournament result start differs from the authorized attempt');
        }
        return { binding, attemptEntry, attempt, result };
    }
}

/** Write this batch in the SAME AppInbox transaction as the game's final state and exact command outcome. */
export function computeTournamentResultPublication(
    read: TournamentResultRepository.Read,
    proposed: TournamentMatchResult
): TournamentResultRepository.Publication {
    const result = decodeTournamentResult(proposed, read.binding);
    if (read.result !== null) {
        if (!jsonEquals(read.result, result)) {
            throw new TypeError('Tournament result is immutable');
        }
        return { kind: 'replay', result: read.result };
    }
    if (read.attempt?.status !== 'playing' || read.attemptEntry === null) {
        return { kind: 'refused', reason: 'inactive-attempt' };
    }
    if (result.startedAtEpochMs !== read.attempt.startedAtEpochMs) {
        throw new TypeError('Tournament result start differs from the authorized attempt');
    }
    const key = tournamentResultKey(read.binding);
    return {
        kind: 'publish',
        storage: {
            creation: null,
            batch: computeRuntimeStateGuardedBatchWrite({
                guard: {
                    operation: 'update',
                    namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                    key: groupStateGroupStorageKey(read.binding.roomRef),
                    expectedRevision: read.attemptEntry.revision,
                    value: JSON.stringify({ ...read.attempt, status: 'finished' }),
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                },
                effects: []
            }),
            inserts: [{
                namespace: TOURNAMENT_RESULTS_NAMESPACE,
                key,
                value: JSON.stringify(result),
                expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
            }]
        }
    };
}

export function decodeTournamentAttempt(
    value: unknown,
    binding: TournamentMatchBinding
): TournamentResultRepository.Attempt {
    const attempt = requireRecord(value, 'Tournament attempt');
    requireExactKeys(attempt, ['binding', 'status', 'startedAtEpochMs'], 'Tournament attempt');
    const storedBinding = decodeTournamentMatchBinding(attempt.binding);
    if (!jsonEquals(storedBinding, binding)) {
        throw new TypeError('Tournament attempt binding differs');
    }
    const status = requireOneOf(
        attempt.status,
        ['scheduled', 'playing', 'finished', 'cancelled'],
        'Tournament attempt status'
    );
    const startedAtEpochMs = attempt.startedAtEpochMs;
    if (startedAtEpochMs !== null) {
        requireEpoch(startedAtEpochMs, 'Tournament attempt start');
    }
    if (
        (status === 'scheduled' && startedAtEpochMs !== null) ||
        ((status === 'playing' || status === 'finished') && startedAtEpochMs === null)
    ) {
        throw new TypeError('Tournament attempt start does not match its status');
    }
    return { binding: storedBinding, status, startedAtEpochMs };
}

function readStoredValue(entry: RuntimeStateEntry, key: string): JsonWireValue {
    if (entry.key !== key || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw new TypeError('Tournament storage identity or lifetime differs');
    }
    return decodeJsonWireText(entry.value, 'Tournament stored value');
}

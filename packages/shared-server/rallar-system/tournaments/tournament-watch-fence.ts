import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type {
    RuntimeStateGuardedBatchExactUpdate,
    RuntimeStateGuardedBatchInsert
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import { toTournamentStorageKey } from './tournament-storage-key.ts';

export const TOURNAMENT_WATCH_FENCES_NAMESPACE = 'view-watch:tournament-absence';

export interface TournamentWatchFence {
    readonly ref: TournamentRef;
    readonly entry: RuntimeStateEntry | null;
    readonly phase: 'absent' | 'created' | null;
}

export interface TournamentWatchFenceInput {
    readonly read: TournamentWatchFence;
    readonly expiresAtEpochMs: number;
    readonly incarnation: string;
    readonly phase: 'absent' | 'created';
}

export function decodeTournamentWatchFence(
    ref: TournamentRef,
    entry: RuntimeStateEntry | undefined
): TournamentWatchFence {
    if (entry === undefined) {
        return { ref, entry: null, phase: null };
    }
    const record = requireRecord(JSON.parse(entry.value), 'Tournament watch fence');
    requireExactKeys(record, ['ref', 'expiresAtEpochMs', 'incarnation', 'phase'], 'Tournament watch fence');
    requireEpoch(record.expiresAtEpochMs, 'Tournament watch fence expiry');
    requireString(record.incarnation, 'Tournament watch fence incarnation');
    const phase = requireOneOf(record.phase, ['absent', 'created'], 'Tournament watch fence phase');
    if (
        !jsonEquals(decodeTournamentRef(record.ref), ref) || entry.key !== toTournamentStorageKey(ref) ||
        entry.expireAtTimestamp !== record.expiresAtEpochMs ||
        (phase === 'created'
            ? record.expiresAtEpochMs !== NEVER_EXPIRE_AT_TIMESTAMP
            : record.expiresAtEpochMs >= NEVER_EXPIRE_AT_TIMESTAMP)
    ) {
        throw new TypeError('Tournament watch fence differs from its resource or phase lifetime');
    }
    return { ref, entry, phase };
}

/** Missing resources expire with auth. Creation retains its fence with the durable bracket, which remains readable after completion. */
export function computeTournamentWatchFence(
    input: TournamentWatchFenceInput
): RuntimeStateGuardedBatchInsert | RuntimeStateGuardedBatchExactUpdate {
    const { read, incarnation, phase } = input;
    requireString(incarnation, 'Tournament watch fence incarnation');
    requireEpoch(input.expiresAtEpochMs, 'Tournament watch authority expiry');
    if (read.phase === 'created') {
        throw new TypeError('An absent bracket cannot have a created-resource watch fence');
    }
    const expiry = phase === 'created'
        ? NEVER_EXPIRE_AT_TIMESTAMP
        : Math.max(read.entry?.expireAtTimestamp ?? 0, input.expiresAtEpochMs);
    if (phase === 'absent' && expiry >= NEVER_EXPIRE_AT_TIMESTAMP) {
        throw new TypeError('Missing-resource watch requires bounded auth expiry');
    }
    const common = {
        namespace: TOURNAMENT_WATCH_FENCES_NAMESPACE,
        key: toTournamentStorageKey(read.ref),
        value: JSON.stringify({ ref: read.ref, expiresAtEpochMs: expiry, incarnation, phase }),
        expireAtTimestamp: expiry
    };
    return read.entry === null ? { ...common, operation: 'insert' } : {
        ...common,
        operation: 'update-exact',
        expectedRevision: read.entry.revision,
        expectedValue: read.entry.value
    };
}

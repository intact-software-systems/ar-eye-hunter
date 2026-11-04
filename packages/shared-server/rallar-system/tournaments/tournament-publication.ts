import { requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateConditionalBatch } from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import { decodeJsonWireText } from '../protocol/json-wire-identity.ts';
import type { TournamentService } from './tournament-service.ts';
import { toTournamentStorageKey } from './tournament-storage-key.ts';

export const TOURNAMENT_PUBLICATIONS_NAMESPACE = 'tournaments:publications';

export interface TournamentPublication {
    readonly ref: TournamentRef;
    readonly listing: 'listed' | 'unlisted';
}

export interface TournamentPublicationRead {
    readonly entry: RuntimeStateEntry | null;
    readonly record: TournamentPublication | null;
}

export function decodeTournamentPublicationEntry(entry: RuntimeStateEntry, ref: TournamentRef): TournamentPublication {
    const record = requireRecord(decodeJsonWireText(entry.value), 'Tournament publication');
    requireExactKeys(record, ['ref', 'listing'], 'Tournament publication');
    const publication = {
        ref: decodeTournamentRef(record.ref),
        listing: requireOneOf(record.listing, ['listed', 'unlisted'], 'Tournament listing')
    };
    if (
        entry.key !== toTournamentStorageKey(ref) || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP ||
        !jsonEquals(publication.ref, ref)
    ) {
        throw new TypeError('Tournament publication differs from its canonical slot');
    }
    return publication;
}

export function computeTournamentPublicationEffect(
    read: TournamentPublicationRead,
    record: TournamentPublication
): RuntimeStateGuardedBatchEffect {
    const value = JSON.stringify(record);
    const key = toTournamentStorageKey(record.ref);
    const common = {
        effectId: 'publication',
        namespace: TOURNAMENT_PUBLICATIONS_NAMESPACE,
        key,
        value,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
    return read.entry === null
        ? { ...common, operation: 'insert' }
        : { ...common, operation: 'update', expectedRevision: read.entry.revision };
}

export interface TournamentPublicationDecision {
    readonly refusal: string | null;
    readonly storage: RuntimeStateConditionalBatch | null;
}

/** Publication is independent of participation, guarded by the bracket, actor session and prior listing. */
export function computeTournamentPublication(
    read: TournamentService.Read,
    authorizedStorage: RuntimeStateConditionalBatch
): TournamentPublicationDecision {
    const { command, publication } = read;
    const record = read.bracket.record;
    if (record === null || publication === null) {
        throw new TypeError('Tournament publication lacks its observed state');
    }
    if (command.actor?.principalId !== record.tournament.organizerPrincipalId) {
        return { refusal: 'organizer-required', storage: null };
    }
    if (command.request.type === 'publish' && ['complete', 'cancelled'].includes(record.tournament.status)) {
        return { refusal: 'tournament-finished', storage: null };
    }
    const listing = command.request.type === 'publish' ? 'listed' : 'unlisted';
    return {
        refusal: null,
        storage: {
            ...authorizedStorage,
            batch: computeRuntimeStateGuardedBatchWrite({
                guard: authorizedStorage.batch.guard,
                effects: [
                    ...authorizedStorage.batch.effects,
                    computeTournamentPublicationEffect(publication, { ref: command.ref, listing })
                ]
            })
        }
    };
}

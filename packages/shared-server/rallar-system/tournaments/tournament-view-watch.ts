import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import type {
    ViewWatchAuthorityFacts,
    ViewWatchAuthorization,
    ViewWatchAuthorizer
} from '../view-watch/compute-view-watch.ts';
import type { ViewWatchResource } from '../view-watch/view-watch-repository.ts';
import { decodeTournamentEntry, TOURNAMENTS_NAMESPACE } from './tournament-repository.ts';
import { toTournamentStorageKey } from './tournament-storage-key.ts';
import {
    computeTournamentWatchFence,
    decodeTournamentWatchFence,
    TOURNAMENT_WATCH_FENCES_NAMESPACE
} from './tournament-watch-fence.ts';

/** Missing brackets are readable; their bounded auth-lifetime fence serializes registration with creation. */
export class TournamentViewWatch implements ViewWatchAuthorizer {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'readRuntimeStateBatch'>;
    constructor(runtime: Pick<RuntimeStateRepositoryLike, 'readRuntimeStateBatch'>) {
        this.runtime = runtime;
    }

    async read(resource: ViewWatchResource, facts: ViewWatchAuthorityFacts): Promise<ViewWatchAuthorization> {
        if (resource.family !== 'tournament') {
            throw new TypeError('Tournament watch received another family');
        }
        const ref = decodeTournamentRef({
            applicationId: resource.applicationId,
            workspaceId: resource.workspaceId,
            tournamentId: resource.resourceId
        });
        const key = toTournamentStorageKey(ref);
        const rows = await this.runtime.readRuntimeStateBatch([
            { selectorId: 'bracket', kind: 'key', namespace: TOURNAMENTS_NAMESPACE, key },
            { selectorId: 'fence', kind: 'key', namespace: TOURNAMENT_WATCH_FENCES_NAMESPACE, key }
        ]);
        if (
            rows.length !== 2 ||
            rows.some((row, index) =>
                row.selectorId !== ['bracket', 'fence'][index] || row.entries.length > 1 ||
                row.entries.some((entry) => entry.key !== key)
            )
        ) {
            throw new TypeError('Tournament watch read differs from its exact authority slots');
        }
        const bracket = rows[0].entries[0];
        const fence = decodeTournamentWatchFence(ref, rows[1].entries[0]);
        if (bracket === undefined) {
            return {
                resource,
                guard: computeTournamentWatchFence({
                    read: fence,
                    expiresAtEpochMs: facts.expiresAtEpochMs,
                    incarnation: facts.changeId,
                    phase: 'absent'
                })
            };
        }
        decodeTournamentEntry(bracket, ref);
        return {
            resource,
            guard: {
                operation: 'update',
                namespace: TOURNAMENTS_NAMESPACE,
                key,
                value: bracket.value,
                expectedRevision: bracket.revision,
                expireAtTimestamp: bracket.expireAtTimestamp
            }
        };
    }
}

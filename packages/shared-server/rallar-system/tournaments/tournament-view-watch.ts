import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentRef } from '@shared/api/tournaments/tournament-types.ts';
import type { RuntimeStateGuardedBatchDelete } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { readRuntimeStateKeySelections } from '../../runtime-state/read-batch/read-runtime-state-key-selections.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
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
    TOURNAMENT_WATCH_FENCES_NAMESPACE,
    type TournamentWatchFence
} from './tournament-watch-fence.ts';

interface TournamentWatchAuthority {
    readonly ref: TournamentRef;
    readonly key: string;
    readonly bracket: RuntimeStateEntry | undefined;
    readonly fence: TournamentWatchFence;
}

/** Missing brackets are readable; their bounded auth-lifetime fence serializes registration with creation. */
export class TournamentViewWatch implements ViewWatchAuthorizer {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'readRuntimeStateBatch'>;
    constructor(runtime: Pick<RuntimeStateRepositoryLike, 'readRuntimeStateBatch'>) {
        this.runtime = runtime;
    }

    async read(resource: ViewWatchResource, facts: ViewWatchAuthorityFacts): Promise<ViewWatchAuthorization> {
        const { ref, key, bracket, fence } = await this.readAuthority(resource);
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

    /** An absence fence exists only for interest in a missing bracket; a created bracket keeps its fence. */
    async readRelease(resource: ViewWatchResource): Promise<RuntimeStateGuardedBatchDelete | null> {
        const { bracket, fence } = await this.readAuthority(resource);
        return bracket !== undefined || fence.entry === null || fence.phase !== 'absent' ? null : {
            operation: 'delete',
            namespace: TOURNAMENT_WATCH_FENCES_NAMESPACE,
            key: fence.entry.key,
            expectedRevision: fence.entry.revision
        };
    }

    private async readAuthority(resource: ViewWatchResource): Promise<TournamentWatchAuthority> {
        if (resource.family !== 'tournament') {
            throw new TypeError('Tournament watch received another family');
        }
        const ref = decodeTournamentRef({
            applicationId: resource.applicationId,
            workspaceId: resource.workspaceId,
            tournamentId: resource.resourceId
        });
        const key = toTournamentStorageKey(ref);
        const [bracket, fence] = await readRuntimeStateKeySelections(this.runtime, [
            { selectorId: 'bracket', kind: 'key', namespace: TOURNAMENTS_NAMESPACE, key },
            { selectorId: 'fence', kind: 'key', namespace: TOURNAMENT_WATCH_FENCES_NAMESPACE, key }
        ]);
        return { ref, key, bracket, fence: decodeTournamentWatchFence(ref, fence) };
    }
}

import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication,
    type ViewInvalidationPublicationInput
} from '../websocket/outbox/compute-view-invalidation-publication.ts';
import type { MatchmakingPool, MatchmakingTransition } from './matchmaking-pool.ts';

export interface MatchmakingPublicationInput {
    readonly before: MatchmakingPool;
    readonly previousRevision: number;
    readonly transition: MatchmakingTransition;
    readonly publication: Pick<
        ViewInvalidationPublicationInput,
        'serviceId' | 'traceId' | 'createdAtEpochMs' | 'retentionMs'
    >;
}

export function computeMatchmakingPublication(input: MatchmakingPublicationInput): ViewInvalidationPublication {
    const before = accountViews(input.before);
    const after = accountViews(input.transition.pool);
    const principalIds = [...new Set([...before.keys(), ...after.keys()])]
        .filter((principalId) => !jsonEquals(before.get(principalId), after.get(principalId)));
    return computeViewInvalidationPublication({
        ...input.publication,
        resource: 'matchmaking',
        scope: input.before.scope,
        principalIds,
        changeId: computeSha256CanonicalJson({
            scope: input.before.scope,
            previousRevision: input.previousRevision,
            pool: input.transition.pool,
            finished: input.transition.finished
        })
    });
}

function accountViews(pool: MatchmakingPool): ReadonlyMap<string, object> {
    const views = new Map<string, object>();
    for (const search of pool.searching) {
        views.set(search.principalId, search);
    }
    for (const proposal of pool.proposals) {
        for (const participant of proposal.participants) {
            views.set(participant.principalId, proposal);
        }
    }
    return views;
}

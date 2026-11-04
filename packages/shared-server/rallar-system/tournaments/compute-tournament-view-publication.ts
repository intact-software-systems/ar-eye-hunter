import type { Tournament } from '@shared/api/tournaments/tournament-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import {
    computeViewInvalidationPublication,
    type ViewInvalidationPublication
} from '../websocket/outbox/compute-view-invalidation-publication.ts';
import { toTournamentCatalogEntry } from './catalog/tournament-catalog-reader.ts';
import { decodeTournamentRecord } from './tournament-repository.ts';
import type { TournamentService } from './tournament-service.ts';
import { computeTournamentWatchFence } from './tournament-watch-fence.ts';

/** Captured watchers and all catalog principals share the bracket CAS; payloads contain only redacted view hints. */
export function computeTournamentViewPublication(
    read: TournamentService.Read,
    computed: TournamentService.Computed
): TournamentService.Computed {
    if (computed.storage === null) {
        return computed;
    }
    const storage = computed.storage;
    if (storage.batch.guard.operation !== 'update') {
        throw new TypeError('Tournament view publication requires its bracket update');
    }
    const after = decodeTournamentRecord(JSON.parse(storage.batch.guard.value)).tournament;
    const before = read.bracket.record?.tournament ?? null;
    const beforeListing = read.publication.record?.listing ?? 'unlisted';
    const listing = read.command.request.type === 'publish'
        ? 'listed'
        : read.command.request.type === 'unlist'
        ? 'unlisted'
        : beforeListing;
    const principals = [...new Set([...(before === null ? [] : participants(before)), ...participants(after)])].sort();
    const catalogChanged = !jsonEquals(
        before === null ? null : toTournamentCatalogEntry(before),
        toTournamentCatalogEntry(after)
    );
    const bracketChanged = !jsonEquals(before, after) || beforeListing !== listing;
    const publications: ViewInvalidationPublication[] = [];
    if (catalogChanged) {
        publications.push(publish(read, 'tournament-catalog', principals));
    }
    if (bracketChanged) {
        publications.push(publish(read, 'tournament', [...principals, ...read.watchers]));
    }
    const beforePublic = before !== null && beforeListing === 'listed' &&
        ['registration', 'active'].includes(before.status);
    const afterPublic = listing === 'listed' && ['registration', 'active'].includes(after.status);
    if ((beforePublic || afterPublic) && (catalogChanged || beforePublic !== afterPublic)) {
        publications.push(publish(read, 'tournament-catalog', null));
    }
    const effects = [...storage.batch.effects];
    const creationFence = before === null ? computeCreationWatchFence(read) : null;
    if (creationFence !== null) {
        effects.push(creationFence);
    }
    return {
        ...computed,
        storage: {
            ...storage,
            batch: computeRuntimeStateGuardedBatchWrite({
                guard: storage.batch.guard,
                effects: [...effects, ...publications.flatMap((publication) => publication.provenance)]
            })
        },
        outbox: [...computed.outbox, ...publications.flatMap((publication) => publication.outbox)]
    };
}

function participants(tournament: Tournament): readonly string[] {
    return [tournament.organizerPrincipalId, ...tournament.entrants.map((entrant) => entrant.principalId)];
}

function publish(
    read: TournamentService.Read,
    resource: 'tournament' | 'tournament-catalog',
    principalIds: readonly string[] | null
): ViewInvalidationPublication {
    const facts = {
        scope: { applicationId: read.command.ref.applicationId, workspaceId: read.command.ref.workspaceId },
        changeId: computeSha256CanonicalJson({
            ref: read.command.ref,
            requestId: read.command.requestId,
            revision: read.bracket.entry?.revision ?? null
        }),
        createdAtEpochMs: read.nowEpochMs,
        retentionMs: read.signalRetentionMs,
        serviceId: read.serviceId,
        traceId: principalIds === null ? computeSha256CanonicalJson(read.traceId) : read.traceId
    };
    return principalIds === null
        ? computeViewInvalidationPublication({ ...facts, resource: 'tournament-catalog', principalIds: null })
        : computeViewInvalidationPublication({ ...facts, resource, principalIds });
}

function computeCreationWatchFence(read: TournamentService.Read): RuntimeStateGuardedBatchEffect {
    const authority = read.sessions.find((session) => session.value.sessionId === read.command.actor?.sessionId);
    if (read.watchFence === null || authority === undefined) {
        throw new TypeError('Tournament creation lacks its watch fence and issued authority');
    }
    return {
        effectId: 'creation-watch-fence',
        ...computeTournamentWatchFence({
            read: read.watchFence,
            expiresAtEpochMs: authority.value.expiresAtEpochMs,
            incarnation: computeSha256CanonicalJson({ command: read.command, phase: 'created' }),
            phase: 'created'
        })
    };
}

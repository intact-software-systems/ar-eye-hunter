import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import type { ClientStateService } from './client-state-service.ts';

export type CachedClientStateServiceCache = Readonly<{
    findOrLoadByRef(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    observe(snapshot: ClientSnapshot): StateSnapshotObservation;
}>;

export type CachedClientStateService = ClientStateService & Readonly<{
    observeSnapshot(snapshot: ClientSnapshot): Promise<ClientSnapshot>;
}>;

export function createCachedClientStateService(options: Readonly<{
    durable: ClientStateService;
    cache: CachedClientStateServiceCache;
}>): CachedClientStateService {
    const observeSnapshot = async (
        snapshot: ClientSnapshot,
    ): Promise<ClientSnapshot> => {
        options.cache.observe(snapshot);
        return snapshot;
    };
    const service: CachedClientStateService = {
        ...options.durable,
        observeSnapshot,
        listSnapshots: async (scope) => {
            const snapshots = await options.durable.listSnapshots(scope);
            return await Promise.all(snapshots.map(observeSnapshot));
        },
        readSnapshot: async (ref) =>
            await options.cache.findOrLoadByRef(ref),
    };

    return service;
}

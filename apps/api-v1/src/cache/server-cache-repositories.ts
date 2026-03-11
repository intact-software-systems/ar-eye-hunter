import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';
import { configureSharedGraphRepositories } from '@shared-graph/repository/configure-shared-graph-repositories.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';

const MINUTE_MS = 60_000;

export function initialiseServerCacheRepositories(): void {
    configureSharedStateRepositories({
        clientSnapshots: { ttlMs: 2 * MINUTE_MS },
        groupSnapshots: { ttlMs: 2 * MINUTE_MS },
    });
    configureRttRepository({ ttlMs: MINUTE_MS });

    configureSharedGraphRepositories({
        graphs: { ttlMs: 2 * MINUTE_MS },
        vivaldi: { ttlMs: 5 * MINUTE_MS },
    });
}

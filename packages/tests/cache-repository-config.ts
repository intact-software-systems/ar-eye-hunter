import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';
import { configureOverlayRepository } from '@shared/repository/overlays-repository.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';
import { configureSharedGraphRepositories } from '@shared-graph/repository/configure-shared-graph-repositories.ts';

const MINUTE_MS = 60_000;

export function configureTestCacheRepositories(
    manager: RepositoryManager = defaultRepositoryManager,
): void {
    configureSharedStateRepositories(
        {
            clientSnapshots: { ttlMs: MINUTE_MS },
            groupSnapshots: { ttlMs: MINUTE_MS },
        },
        manager,
    );

    configureOverlayRepository({ ttlMs: MINUTE_MS }, manager);
    configureRttRepository({ ttlMs: MINUTE_MS }, manager);

    configureSharedGraphRepositories(
        {
            graphs: { ttlMs: MINUTE_MS },
            vivaldi: { ttlMs: MINUTE_MS },
        },
        manager,
    );
}

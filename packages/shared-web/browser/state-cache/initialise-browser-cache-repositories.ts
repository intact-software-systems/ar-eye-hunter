import { configureSharedGraphRepositories } from '@shared-graph/repository/configure-shared-graph-repositories.ts';
import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';
import { configureOverlayRepository } from '@shared/repository/overlays-repository.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';

const MINUTE_MS = 60_000;

/** Configures the browser-local repositories used by the state-cache lifecycle. */
export function initialiseBrowserCacheRepositories(): void {
    configureOverlayRepository({ ttlMs: MINUTE_MS });
    configureRttRepository({ ttlMs: 30_000 });

    configureSharedStateRepositories({
        clientSnapshots: { ttlMs: MINUTE_MS },
        groupSnapshots: { ttlMs: MINUTE_MS }
    });

    configureSharedGraphRepositories({
        graphs: { ttlMs: MINUTE_MS },
        vivaldi: { ttlMs: 5 * MINUTE_MS }
    });
}

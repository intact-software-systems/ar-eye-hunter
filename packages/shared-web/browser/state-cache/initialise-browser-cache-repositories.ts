import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';
import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';

const MINUTE_MS = 60_000;

/** Configures the browser-local repositories used by the state-cache lifecycle. */
export function initialiseBrowserCacheRepositories(): void {
    configureOverlayRepositories({
        plannedOverlays: { ttlMs: MINUTE_MS },
        acceptedOverlays: { ttlMs: MINUTE_MS }
    });
    configureRttRepository({ ttlMs: 30_000 });

    configureSharedStateRepositories({
        clientSnapshots: { ttlMs: MINUTE_MS },
        groupSnapshots: { ttlMs: MINUTE_MS }
    });
}

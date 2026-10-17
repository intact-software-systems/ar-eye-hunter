import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';
import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';

import { rebindOverlaySlotSubscriptions } from './overlay-slot-subscriptions.ts';

const MINUTE_MS = 60_000;

/** How long a client or group snapshot stays readable without a state-sync write or a heartbeat renewing it. */
export const BROWSER_STATE_CACHE_TTL_MS = MINUTE_MS;

/** Configures the browser-local repositories used by the state-cache lifecycle. */
export function initialiseBrowserCacheRepositories(): void {
    configureOverlayRepositories({
        plannedOverlays: { ttlMs: MINUTE_MS },
        acceptedOverlays: { ttlMs: undefined }
    });
    rebindOverlaySlotSubscriptions();
    configureRttRepository({ ttlMs: 30_000 });

    configureSharedStateRepositories({
        clientSnapshots: { ttlMs: BROWSER_STATE_CACHE_TTL_MS },
        groupSnapshots: { ttlMs: BROWSER_STATE_CACHE_TTL_MS }
    });
}

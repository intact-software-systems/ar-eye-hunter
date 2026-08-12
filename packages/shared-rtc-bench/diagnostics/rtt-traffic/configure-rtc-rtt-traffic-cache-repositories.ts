import { configureOverlayRepository } from '@shared/repository/overlays-repository.ts';
// prettier-ignore
import { initialiseRallarServerCacheRepositories } from
  '@shared-server/rallar-system/cache-repositories.ts';

const MINUTE_MS = 60_000;

export function configureRtcRttTrafficCacheRepositories(): void {
  initialiseRallarServerCacheRepositories({
    clientSnapshotsTtlMs: MINUTE_MS,
    groupSnapshotsTtlMs: MINUTE_MS,
    rttTtlMs: MINUTE_MS,
    graphsTtlMs: MINUTE_MS,
    vivaldiTtlMs: MINUTE_MS,
    deleteExpiredIntervalMs: MINUTE_MS,
  });
  configureOverlayRepository({ ttlMs: MINUTE_MS });
}

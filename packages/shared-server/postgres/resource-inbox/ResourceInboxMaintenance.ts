import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';

export const RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS = 15_000;

export async function initResourceInboxExpiryEviction(
    repository: Readonly<{ deleteExpired(): Promise<number>; }>,
    intervalMs: number = RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS
): Promise<void> {
    await tryRunInIntervals(
        async () => {
            const removed = await repository.deleteExpired();
            if (removed > 0) {
                console.log(`Evicted expired resource_inbox rows: ${removed}`);
            }
        },
        intervalMs
    );
}

import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import type { RallarMiddlewareRuntime } from '../middleware/RallarMiddleware.ts';
import type { GroupStateMaintenanceService } from './group-state-service.ts';

export const DEFAULT_PRESENCE_EXPIRY_RECONCILIATION_INTERVAL_MSECS = 60_000;

export type PresenceExpiryReconciliationOptions = Readonly<{
    intervalMsecs?: number;
    now?: () => number;
}>;

export async function initPresenceExpiryReconciliation(
    runtime: Pick<
        RallarMiddlewareRuntime,
        'appClientInboxService'
    > & Readonly<{ groupStateMaintenanceService: GroupStateMaintenanceService }>,
    options: PresenceExpiryReconciliationOptions = {},
): Promise<void> {
    const now = options.now ?? (() => Date.now());

    await tryRunInIntervals(
        () => {
            enqueuePresenceExpiryReconciliation(runtime, now());
        },
        options.intervalMsecs ?? DEFAULT_PRESENCE_EXPIRY_RECONCILIATION_INTERVAL_MSECS,
    );
}

export function enqueuePresenceExpiryReconciliation(
    runtime: Pick<
        RallarMiddlewareRuntime,
        'appClientInboxService'
    > & Readonly<{ groupStateMaintenanceService: GroupStateMaintenanceService }>,
    atEpochMs: number,
): void {
    runtime.appClientInboxService.processExpiredSessionsNoWaiting(atEpochMs);
    void runtime.groupStateMaintenanceService.expireExpiredPresenceSessions(atEpochMs)
        .catch((error) => {
            console.error('Failed to reconcile expired group presence sessions:', error);
        });
}

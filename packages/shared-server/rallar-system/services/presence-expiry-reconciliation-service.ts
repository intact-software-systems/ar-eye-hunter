import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import type { RallarMiddlewareRuntime } from '../middleware/RallarMiddleware.ts';

export const DEFAULT_PRESENCE_EXPIRY_RECONCILIATION_INTERVAL_MSECS = 60_000;

export type PresenceExpiryReconciliationOptions = Readonly<{
    intervalMsecs?: number;
    now?: () => number;
}>;

export async function initPresenceExpiryReconciliation(
    runtime: Pick<
        RallarMiddlewareRuntime,
        'appClientInboxService' | 'appGroupInboxService'
    >,
    options: PresenceExpiryReconciliationOptions = {},
): Promise<void> {
    const now = options.now ?? (() => Date.now());

    await tryRunInIntervals(
        () => enqueuePresenceExpiryReconciliation(runtime, now()),
        options.intervalMsecs ?? DEFAULT_PRESENCE_EXPIRY_RECONCILIATION_INTERVAL_MSECS,
    );
}

export async function enqueuePresenceExpiryReconciliation(
    runtime: Pick<
        RallarMiddlewareRuntime,
        'appClientInboxService' | 'appGroupInboxService'
    >,
    atEpochMs: number,
): Promise<void> {
    await Promise.all([
        runtime.appClientInboxService.enqueueExpiredSessions(atEpochMs),
        runtime.appGroupInboxService.enqueueExpiredPresenceSessions(atEpochMs),
    ]);
}

import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import { tryRunInIntervals } from '@shared/resilience/try-with-policy.ts';

export const DEFAULT_PRESENCE_EXPIRY_RECONCILIATION_INTERVAL_MSECS = 60_000;

export interface PresenceExpiryReconciliationOptions {
    readonly intervalMsecs?: number;
    readonly now?: () => number;
}

export async function initPresenceExpiryReconciliation(
    runtime: Pick<RallarMiddlewareRuntime, 'appClientInboxService' | 'groupStateInboxService'>,
    options: PresenceExpiryReconciliationOptions = {}
): Promise<void> {
    const now = options.now ?? (() => Date.now());

    await tryRunInIntervals({
        handler: () => enqueuePresenceExpiryReconciliation(runtime, now()),
        intervalMsecs: options.intervalMsecs ?? DEFAULT_PRESENCE_EXPIRY_RECONCILIATION_INTERVAL_MSECS,
        retryIntervalMsecs: 10_000,
        maxAttempts: Number.MAX_VALUE
    });
}

export async function enqueuePresenceExpiryReconciliation(
    runtime: Pick<RallarMiddlewareRuntime, 'appClientInboxService' | 'groupStateInboxService'>,
    atEpochMs: number
): Promise<void> {
    await Promise.all([
        runtime.appClientInboxService.enqueueExpiredSessions(atEpochMs),
        runtime.groupStateInboxService.enqueueExpiredPresenceSessions(atEpochMs)
    ]);
}

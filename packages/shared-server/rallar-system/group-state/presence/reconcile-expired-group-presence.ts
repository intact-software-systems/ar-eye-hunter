import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';
import { toError } from '@shared/resilience/to-error.ts';

export const DEFAULT_PRESENCE_EXPIRY_RECONCILIATION_INTERVAL_MSECS = 60_000;

export interface PresenceExpiryServices {
    readonly appClientInboxService: Pick<RallarMiddlewareRuntime['appClientInboxService'], 'enqueueExpiredSessions'>;
    readonly groupStateInboxService: Pick<
        RallarMiddlewareRuntime['groupStateInboxService'],
        'enqueueExpiredPresenceSessions'
    >;
}

export interface PresenceExpiryReconciliationInput {
    readonly runtime: PresenceExpiryServices;
    readonly timers: Timers;
    readonly intervalMs: number;
    readonly nowEpochMs: () => number;
    readonly onFailure: (error: Error) => void;
}

/** Stop owns the in-flight enqueue as well as the next scheduled reconciliation. */
export function startPresenceExpiryReconciliation(input: PresenceExpiryReconciliationInput): () => Promise<void> {
    let pending: Promise<void> = Promise.resolve();
    const stop = startRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: 'now',
        retryBackoff: { baseMs: 10000, maxMs: 20000 },
        run: () => {
            pending = enqueuePresenceExpiryReconciliation(input.runtime, input.nowEpochMs()).catch((error) => {
                const failure = toError(error);
                input.onFailure(failure);
                throw failure;
            });
            return pending;
        }
    });
    return async () => {
        stop();
        await pending.catch(() => undefined);
    };
}

export async function enqueuePresenceExpiryReconciliation(
    runtime: PresenceExpiryServices,
    atEpochMs: number
): Promise<void> {
    const outcomes = await Promise.allSettled([
        runtime.appClientInboxService.enqueueExpiredSessions(atEpochMs),
        runtime.groupStateInboxService.enqueueExpiredPresenceSessions(atEpochMs)
    ]);
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) =>
        toError(outcome.reason)
    );
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, 'Presence expiry enqueues failed');
    }
}

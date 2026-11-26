import type { ApiV1DatabaseNotificationPort } from '../../../../src/db/api-v1-database-lifecycle.ts';

export interface CreateDelayedDatabaseNotificationPortInput {
    readonly notification: ApiV1DatabaseNotificationPort;
    /** What one round trip to the database costs on top of the port's own time; 0 adds nothing. */
    readonly delayMs: number;
    readonly sleep: (delayMs: number) => Promise<void>;
}

/**
 * A notification port that models network latency to the database for a NOTIFY. The API publishes one through this
 * port over the raw client, never through `PSqlSql`, so the delayed handle cannot delay it: here a publish is one
 * round trip and first waits `delayMs`. A subscription is the wrapped port's own and is not delayed, and neither is
 * the delivery of a notification to it. At 0 ms the port given is returned as it is.
 */
export function createDelayedDatabaseNotificationPort(
    input: CreateDelayedDatabaseNotificationPortInput
): ApiV1DatabaseNotificationPort {
    const { notification, delayMs, sleep } = input;
    if (delayMs === 0) {
        return notification;
    }
    return {
        notify: async (channel, message) => {
            await sleep(delayMs);
            await notification.notify(channel, message);
        },
        listen: async (channel, onMessage, onSubscribed) => await notification.listen(channel, onMessage, onSubscribed)
    };
}

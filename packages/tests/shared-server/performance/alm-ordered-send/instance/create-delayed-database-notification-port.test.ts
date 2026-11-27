import { describe, expect, it } from 'vitest';

import { createDelayedDatabaseNotificationPort } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/instance/create-delayed-database-notification-port.ts';
import type { ApiV1DatabaseNotificationPort } from '../../../../../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';

/** What the recording port was asked to subscribe: the callbacks it was handed, as it was handed them. */
interface RecordedSubscription {
    readonly channel: string;
    readonly onMessage: (payload: string) => void | Promise<void>;
    readonly onSubscribed: (() => void) | undefined;
}

interface RecordingNotificationPort extends ApiV1DatabaseNotificationPort {
    readonly published: { readonly channel: string; readonly message: object; }[];
    readonly subscriptions: RecordedSubscription[];
}

const DELAY_MS = 5;

/** Logs each call as it reaches the port. Its methods need their receiver, as a port over a client may. */
function createRecordingNotificationPort(log: string[], notifyFailure?: Error): RecordingNotificationPort {
    return {
        published: [],
        subscriptions: [],
        async notify(this: RecordingNotificationPort, channel, message) {
            log.push(`notify ${channel}`);
            if (notifyFailure !== undefined) {
                throw notifyFailure;
            }
            this.published.push({ channel, message });
        },
        async listen(this: RecordingNotificationPort, channel, onMessage, onSubscribed) {
            log.push(`listen ${channel}`);
            this.subscriptions.push({ channel, onMessage, onSubscribed });
        }
    };
}

function createRecordingSleep(log: string[]): (delayMs: number) => Promise<void> {
    return async (delayMs) => {
        log.push(`sleep ${delayMs}`);
    };
}

describe('createDelayedDatabaseNotificationPort', () => {
    it('waits the delay, then publishes the notification it was given', async () => {
        const log: string[] = [];
        const notification = createRecordingNotificationPort(log);
        const delayed = createDelayedDatabaseNotificationPort({
            notification,
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });
        const message = { kind: 'wake', queue: 'outbox' };

        await delayed.notify('cell-run-1', message);

        expect(log).toEqual(['sleep 5', 'notify cell-run-1']);
        expect(notification.published).toEqual([{ channel: 'cell-run-1', message }]);
        expect(notification.published[0].message).toBe(message);
    });

    it('subscribes through the port it wraps, undelayed, with the callbacks it was handed', async () => {
        const log: string[] = [];
        const notification = createRecordingNotificationPort(log);
        const delayed = createDelayedDatabaseNotificationPort({
            notification,
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });
        const onMessage = (): void => undefined;
        const onSubscribed = (): void => undefined;

        await delayed.listen('cell-run-1', onMessage, onSubscribed);
        await delayed.listen('cell-run-2', onMessage);

        expect(log).toEqual(['listen cell-run-1', 'listen cell-run-2']);
        expect(notification.subscriptions).toEqual([
            { channel: 'cell-run-1', onMessage, onSubscribed },
            { channel: 'cell-run-2', onMessage, onSubscribed: undefined }
        ]);
    });

    it('returns the port it was given when the delay is 0 ms', () => {
        const log: string[] = [];
        const notification = createRecordingNotificationPort(log);

        expect(createDelayedDatabaseNotificationPort({ notification, delayMs: 0, sleep: createRecordingSleep(log) }))
            .toBe(notification);
    });

    it('delays a failing publish, then rejects with the same error', async () => {
        const log: string[] = [];
        const failure = new Error('the connection closed');
        const delayed = createDelayedDatabaseNotificationPort({
            notification: createRecordingNotificationPort(log, failure),
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });

        await expect(delayed.notify('cell-run-1', { kind: 'wake' })).rejects.toBe(failure);

        expect(log).toEqual(['sleep 5', 'notify cell-run-1']);
    });
});

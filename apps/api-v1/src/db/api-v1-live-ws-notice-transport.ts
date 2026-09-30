import {
    decodeLiveWsNotice,
    type LiveWsNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';

import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';
import { createPostgresLiveWsNoticeTransport } from './create-postgres-live-ws-notice-transport.ts';
import type { LocalQueuePubSubBus } from './local-queue-pubsub-bridge.ts';

export interface CreateApiV1LiveWsNoticeTransportInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly publisherId: string;
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly localBus: LocalQueuePubSubBus;
    readonly nowMs: () => number;
}

export function createApiV1LiveWsNoticeTransport(
    input: CreateApiV1LiveWsNoticeTransportInput
): LiveWsNoticeTransport {
    switch (input.mode) {
        case 'postgres':
            if (input.notification === null) {
                throw new TypeError('PostgreSQL live WS notices require the database notification port.');
            }
            return createPostgresLiveWsNoticeTransport(input.notification, input.nowMs);
        case 'local':
            return createLocalLiveWsNoticeTransport(input);
        case 'disabled':
            return { publish: async () => {}, subscribe: async () => {} };
    }
}

function createLocalLiveWsNoticeTransport(
    input: CreateApiV1LiveWsNoticeTransportInput
): LiveWsNoticeTransport {
    return {
        publish: async (notice) => {
            const decoded = decodeLiveWsNotice(notice, notice.channel, input.nowMs());
            if (!decoded) {
                throw new TypeError('Local live WS notice is invalid, expired, or oversized.');
            }
            for (const subscriber of input.localBus.liveNoticeSubscribersByChannel.get(notice.channel) ?? []) {
                if (subscriber.ignoredPublisherId !== notice.publisherId) {
                    await subscriber.onNotice(decoded);
                }
            }
        },
        subscribe: (channel, onNotice) => {
            let subscribers = input.localBus.liveNoticeSubscribersByChannel.get(channel);
            if (!subscribers) {
                subscribers = new Set();
                input.localBus.liveNoticeSubscribersByChannel.set(channel, subscribers);
            }
            subscribers.add({ ignoredPublisherId: input.publisherId, onNotice });
            return Promise.resolve();
        }
    };
}

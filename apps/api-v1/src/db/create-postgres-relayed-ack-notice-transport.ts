import { MAX_LIVE_WS_NOTICE_BYTES } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import {
    decodeRelayedAckNotice,
    type RelayedAckNoticeChannel,
    type RelayedAckNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';

import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

export interface CreateApiV1RelayedAckNoticesInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly channel: string;
    readonly publisherId: string;
}

/** Only PostgreSQL pub/sub joins API processes; one process holds every receipt aggregate it could relay to. */
export function createApiV1RelayedAckNotices(
    input: CreateApiV1RelayedAckNoticesInput
): RelayedAckNoticeChannel | undefined {
    if (input.mode !== 'postgres') {
        return undefined;
    }
    if (input.notification === null) {
        throw new TypeError(
            'PostgreSQL relayed acknowledgement notices require the database notification port.'
        );
    }
    return {
        transport: createPostgresRelayedAckNoticeTransport(input.notification),
        channel: input.channel,
        publisherId: input.publisherId
    };
}

export function createPostgresRelayedAckNoticeTransport(
    notification: ApiV1DatabaseNotificationPort
): RelayedAckNoticeTransport {
    return {
        publish: async (notice) => {
            await notification.notify(notice.channel, notice);
        },
        subscribe: async (channel, onNotice) => {
            await notification.listen(channel, async (payload) => {
                const notice = readRelayedAckNotice(payload, channel);
                if (notice) {
                    await onNotice(notice);
                }
            });
        }
    };
}

function readRelayedAckNotice(
    payload: string,
    channel: string
): ReturnType<typeof decodeRelayedAckNotice> {
    if (new TextEncoder().encode(payload).length >= MAX_LIVE_WS_NOTICE_BYTES) {
        return undefined;
    }
    try {
        return decodeRelayedAckNotice(JSON.parse(payload), channel);
    }
    catch {
        return undefined;
    }
}

import {
    decodeRelayedAckNotice,
    type RelayedAckNoticeChannel,
    type RelayedAckNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';

import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';
import { createPostgresNoticeTransport } from './create-postgres-notice-transport.ts';

/** Its own channel, so neither the QueueBox key listener nor the live notice subscriber parses a relayed ACK. */
export const API_V1_RELAYED_ACK_CHANNEL = 'ws-relayed-ack';

export interface CreateApiV1RelayedAckNoticesInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly notification: ApiV1DatabaseNotificationPort | null;
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
        channel: API_V1_RELAYED_ACK_CHANNEL,
        publisherId: input.publisherId
    };
}

export function createPostgresRelayedAckNoticeTransport(
    notification: ApiV1DatabaseNotificationPort
): RelayedAckNoticeTransport {
    return createPostgresNoticeTransport({ notification, decode: decodeRelayedAckNotice });
}

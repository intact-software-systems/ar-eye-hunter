import {
    decodeAppInboxCompletionNotice,
    type AppInboxCompletionNoticeChannel,
    type AppInboxCompletionNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/app-inbox-completion-notice.ts';
import { MAX_LIVE_WS_NOTICE_BYTES } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';

import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

/** Its own channel, so the WS notice subscribers never parse a completion notice. */
export const API_V1_APP_INBOX_COMPLETION_CHANNEL = 'app-inbox-completion';

export interface CreateApiV1AppInboxCompletionNoticesInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly publisherId: string;
}

/** Only PostgreSQL pub/sub joins API processes; one process holds every waiter its completions could wake. */
export function createApiV1AppInboxCompletionNotices(
    input: CreateApiV1AppInboxCompletionNoticesInput
): AppInboxCompletionNoticeChannel | undefined {
    if (input.mode !== 'postgres') {
        return undefined;
    }
    if (input.notification === null) {
        throw new TypeError('PostgreSQL AppInbox completion notices require the database notification port.');
    }
    return {
        transport: createPostgresAppInboxCompletionNoticeTransport(input.notification),
        channel: API_V1_APP_INBOX_COMPLETION_CHANNEL,
        publisherId: input.publisherId
    };
}

export function createPostgresAppInboxCompletionNoticeTransport(
    notification: ApiV1DatabaseNotificationPort
): AppInboxCompletionNoticeTransport {
    return {
        publish: async (notice) => {
            await notification.notify(notice.channel, notice);
        },
        subscribe: async (channel, onNotice) => {
            await notification.listen(channel, async (payload) => {
                const notice = readAppInboxCompletionNotice(payload, channel);
                if (notice) {
                    await onNotice(notice);
                }
            });
        }
    };
}

function readAppInboxCompletionNotice(
    payload: string,
    channel: string
): ReturnType<typeof decodeAppInboxCompletionNotice> {
    if (new TextEncoder().encode(payload).length >= MAX_LIVE_WS_NOTICE_BYTES) {
        return undefined;
    }
    try {
        return decodeAppInboxCompletionNotice(JSON.parse(payload), channel);
    }
    catch {
        return undefined;
    }
}

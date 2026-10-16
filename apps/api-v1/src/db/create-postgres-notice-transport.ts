import { MAX_LIVE_WS_NOTICE_BYTES } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';

import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

export interface PostgresNoticeTransport<Notice> {
    publish(notice: Notice): Promise<void>;
    subscribe(channel: string, onNotice: (notice: Notice) => Promise<void> | void): Promise<void>;
}

/** The notice on the expected channel; anything else sharing the channel decodes to undefined. */
export type PostgresNoticeDecoder<Notice> = (value: unknown, channel: string) => Notice | undefined;

export interface CreatePostgresNoticeTransportInput<Notice> {
    readonly notification: ApiV1DatabaseNotificationPort;
    readonly decode: PostgresNoticeDecoder<Notice>;
}

/** A payload at the notification byte limit, unparseable, or not this kind of notice is dropped unread. */
export function createPostgresNoticeTransport<Notice extends Readonly<{ channel: string; }>>(
    input: CreatePostgresNoticeTransportInput<Notice>
): PostgresNoticeTransport<Notice> {
    return {
        publish: async (notice) => {
            await input.notification.notify(notice.channel, notice);
        },
        subscribe: async (channel, onNotice) => {
            await input.notification.listen(channel, async (payload) => {
                const notice = readPostgresNotice(input.decode, payload, channel);
                if (notice) {
                    await onNotice(notice);
                }
            });
        }
    };
}

function readPostgresNotice<Notice>(
    decode: PostgresNoticeDecoder<Notice>,
    payload: string,
    channel: string
): Notice | undefined {
    if (new TextEncoder().encode(payload).length >= MAX_LIVE_WS_NOTICE_BYTES) {
        return undefined;
    }
    try {
        return decode(JSON.parse(payload), channel);
    }
    catch {
        return undefined;
    }
}

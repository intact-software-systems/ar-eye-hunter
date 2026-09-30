import {
    decodeLiveWsNotice,
    MAX_LIVE_WS_NOTICE_BYTES,
    type LiveWsNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';

export function createPostgresLiveWsNoticeTransport(
    notification: ApiV1DatabaseNotificationPort,
    nowMs: () => number
): LiveWsNoticeTransport {
    return {
        publish: async (notice) => {
            if (!decodeLiveWsNotice(notice, notice.channel, nowMs())) {
                throw new TypeError('PostgreSQL live WS notice is invalid, expired, or oversized.');
            }
            await notification.notify(notice.channel, notice);
        },
        subscribe: async (channel, onNotice) => {
            await notification.listen(channel, async (payload) => {
                if (new TextEncoder().encode(payload).length >= MAX_LIVE_WS_NOTICE_BYTES) {
                    return;
                }
                let value: JsonWireValue;
                try {
                    value = decodeJsonWireValue(JSON.parse(payload), 'PostgreSQL live WS notice');
                }
                catch {
                    return;
                }
                const notice = decodeLiveWsNotice(value, channel, nowMs());
                if (notice) {
                    await onNotice(notice);
                }
            });
        }
    };
}

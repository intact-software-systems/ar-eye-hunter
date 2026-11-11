import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    decodeLiveWsNotice,
    MAX_LIVE_WS_NOTICE_BYTES,
    type LiveWsNotice,
    type LiveWsNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';
import { ThrottledFlush } from '@shared/resilience/timing/throttled-flush.ts';
import type { ApiV1DatabaseNotificationPort } from './api-v1-database-lifecycle.ts';
import { fragmentPostgresNativeFrame, PostgresNativeFrameFragments } from './postgres-native-frame-fragments.ts';

export interface ManagedLiveWsNoticeTransport extends LiveWsNoticeTransport {
    stop(): Promise<void>;
}

export function createPostgresLiveWsNoticeTransport(
    notification: ApiV1DatabaseNotificationPort,
    nowMs: () => number
): ManagedLiveWsNoticeTransport {
    const subscriptions: Array<() => Promise<void>> = [];
    let stopped = false;
    return {
        stop: async () => {
            stopped = true;
            await Promise.all(subscriptions.splice(0).map((stop) => stop()));
        },
        publish: (notice) => publishPostgresLiveNotice(notification, notice, nowMs()),
        subscribe: async (channel, onNotice, onSubscribed) => {
            const repair = new ThrottledFlush({
                timers: createDefaultBackgroundTimers(),
                write: async () => {
                    if (!stopped) {
                        onSubscribed?.();
                    }
                }
            }, { firstMarkDelayMs: 0, minIntervalMs: 5000 });
            let observedRepair: Promise<void> | undefined;
            const fragments = new PostgresNativeFrameFragments(() => {
                const pending = repair.mark();
                if (pending !== observedRepair) {
                    observedRepair = pending;
                    void pending.catch((error) => console.error('Room snapshot receiver recovery failed', error));
                }
            });
            subscriptions.push(async () => {
                fragments.clear();
                await repair.stop();
            });
            await notification.listen(channel, async (payload) => {
                if (stopped || computeUtf8ByteLength(payload) >= MAX_LIVE_WS_NOTICE_BYTES) {
                    return;
                }
                let value: JsonWireValue;
                try {
                    value = decodeJsonWireValue(JSON.parse(payload), 'PostgreSQL live WS notice');
                }
                catch {
                    return;
                }
                const complete = fragments.read(value, nowMs());
                const notice = complete === undefined ? undefined : decodeLiveWsNotice(complete, channel, nowMs());
                if (notice) {
                    await onNotice(notice);
                }
            }, () => {
                fragments.clear();
                if (!stopped) {
                    onSubscribed?.();
                }
            });
        }
    };
}

/** PostgreSQL accepts strictly fewer than 8,000 UTF-8 bytes per notification. */
async function publishPostgresLiveNotice(
    notification: ApiV1DatabaseNotificationPort,
    notice: LiveWsNotice,
    nowMs: number
): Promise<void> {
    if (!decodeLiveWsNotice(notice, notice.channel, nowMs)) {
        throw new TypeError('PostgreSQL live WS notice is invalid, expired, or oversized.');
    }
    const serialized = JSON.stringify(notice);
    if (computeUtf8ByteLength(serialized) < MAX_LIVE_WS_NOTICE_BYTES) {
        await notification.notify(notice.channel, notice);
        return;
    }
    for (const part of fragmentPostgresNativeFrame(serialized, notice.expiresAtMs)) {
        await notification.notify(notice.channel, part);
    }
}

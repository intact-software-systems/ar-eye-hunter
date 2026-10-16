import type { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';

import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../protocol/json-wire-identity.ts';
import { MAX_LIVE_WS_NOTICE_BYTES } from './live-ws-notice.ts';

const APP_INBOX_COMPLETION_NOTICE_KEYS = ['kind', 'version', 'channel', 'publisherId', 'key'] as const;
const APP_INBOX_COMPLETION_KEY_KEYS = ['topicId', 'resourceId', 'contextId'] as const;

/** A completion committed on one instance, handed to the instance whose waiter enqueued it. */
export interface AppInboxCompletionNotice {
    readonly kind: 'app-inbox-completion';
    readonly version: 1;
    readonly channel: string;
    readonly publisherId: string;
    readonly key: AppInboxCompletionNoticeKey;
}

export interface AppInboxCompletionNoticeKey {
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string | null;
}

export interface AppInboxCompletionNoticeTransport {
    publish(notice: AppInboxCompletionNotice): Promise<void>;
    subscribe(
        channel: string,
        onNotice: (notice: AppInboxCompletionNotice) => Promise<void> | void
    ): Promise<void>;
}

export interface AppInboxCompletionNoticeChannel {
    readonly transport: AppInboxCompletionNoticeTransport;
    readonly channel: string;
    readonly publisherId: string;
}

export interface InstallAppInboxCompletionNoticeSubscriberInput extends AppInboxCompletionNoticeChannel {
    readonly notifications: ResourceInboxCompletionNotifications;
}

/** The notice is advisory: one that fails to travel costs the remote waiter its safety tick, never its result. */
export function createAppInboxCompletionRelay(
    channel: AppInboxCompletionNoticeChannel
): ResourceInboxCompletionNotifications.Relay {
    return (identity) => {
        const notice: AppInboxCompletionNotice = {
            kind: 'app-inbox-completion',
            version: 1,
            channel: channel.channel,
            publisherId: channel.publisherId,
            key: {
                topicId: identity.topicId,
                resourceId: identity.resourceId,
                contextId: identity.contextId ?? null
            }
        };
        if (!isWithinNoticeLimit(notice)) {
            console.warn('AppInbox completion notice is oversized; the remote waiter reads on its safety tick.');
            return;
        }
        channel.transport.publish(notice).catch((error) => {
            console.warn(
                'AppInbox completion notice publish failed; the remote waiter reads on its safety tick:',
                error
            );
        });
    };
}

/** An instance never takes its own notice back; a relayed completion wakes local waiters only. */
export function installAppInboxCompletionNoticeSubscriber(
    input: InstallAppInboxCompletionNoticeSubscriberInput
): Promise<void> {
    return input.transport.subscribe(input.channel, (notice) => {
        if (notice.publisherId === input.publisherId) {
            return;
        }
        input.notifications.acceptRelayed({
            topicId: notice.key.topicId,
            resourceId: notice.key.resourceId,
            contextId: notice.key.contextId ?? undefined
        });
    });
}

/** A completion notice on the expected channel; anything else is not one. */
export function decodeAppInboxCompletionNotice(
    value: unknown,
    expectedChannel: string
): AppInboxCompletionNotice | undefined {
    let wire: JsonWireValue;
    try {
        wire = decodeJsonWireValue(value, 'AppInbox completion notice');
    }
    catch {
        return undefined;
    }
    if (!isExactRecord(wire, APP_INBOX_COMPLETION_NOTICE_KEYS)) {
        return undefined;
    }
    const key = wire.key;
    if (
        !isExactRecord(key, APP_INBOX_COMPLETION_KEY_KEYS) ||
        wire.kind !== 'app-inbox-completion' || wire.version !== 1 || wire.channel !== expectedChannel ||
        !isNonEmptyString(wire.publisherId) || typeof key.topicId !== 'string' ||
        typeof key.resourceId !== 'string' || (key.contextId !== null && typeof key.contextId !== 'string')
    ) {
        return undefined;
    }
    const notice: AppInboxCompletionNotice = {
        kind: 'app-inbox-completion',
        version: 1,
        channel: expectedChannel,
        publisherId: wire.publisherId,
        key: { topicId: key.topicId, resourceId: key.resourceId, contextId: key.contextId }
    };
    return isWithinNoticeLimit(notice) ? notice : undefined;
}

function isWithinNoticeLimit(notice: AppInboxCompletionNotice): boolean {
    return new TextEncoder().encode(JSON.stringify(notice)).length < MAX_LIVE_WS_NOTICE_BYTES;
}

function isExactRecord(value: JsonWireValue, keys: readonly string[]): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: JsonWireValue): value is string {
    return typeof value === 'string' && value.length > 0;
}

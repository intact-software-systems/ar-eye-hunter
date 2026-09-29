import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WebSocketServerMessageContext } from '@shared/services/queue-message-callbacks.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { encodeLiveWsNotice } from '../queue-pubsub/live-ws-notice.ts';
import type { RallarServerWsRouterOptions } from '../websocket/router/rallar-server-ws-router-contracts.ts';
import { decodeRtcSignalingRoute } from './decode-rtc-signaling-route.ts';

interface PublishRtcSignalingMessageInput {
    readonly service: WsQueueBoxServerService;
    readonly publication: RallarServerWsRouterOptions['livePublication'];
    readonly nowEpochMs: () => number;
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly context: WebSocketServerMessageContext;
    readonly recipientSessionId: string;
}

export function installRtcSignalingWsTopic(
    service: WsQueueBoxServerService,
    publication: RallarServerWsRouterOptions['livePublication'],
    nowEpochMs: () => number
): void {
    service.onInboxMessageDo(AppTopics.rtcSignaling, {
        onMessage: (
            message: ALMessage,
            entry: ResourceEntry,
            context: WebSocketServerMessageContext
        ): Promise<void> => {
            if (message.route.topicId !== AppTopics.rtcSignaling) {
                return Promise.resolve();
            }
            const route = decodeRtcSignalingRoute(message);
            if (route.left) {
                throw new TypeError(route.left.message);
            }
            if (route.right) {
                return publishRtcSignalingMessage({
                    service,
                    publication,
                    nowEpochMs,
                    message,
                    entry,
                    context,
                    recipientSessionId: route.right.toId
                });
            }
            return Promise.resolve();
        }
    });
}

async function publishRtcSignalingMessage(input: PublishRtcSignalingMessageInput): Promise<void> {
    const scope = input.context.source.kind === 'ws-client' ? input.context.source.authenticatedScope : undefined;
    if (!scope) {
        throw new TypeError('Admitted RTC signaling has no authenticated source scope.');
    }
    const expiresAtMs = input.entry.audit.expiryTs.epochMilliseconds;
    if (expiresAtMs <= input.nowEpochMs()) {
        return;
    }
    if (input.publication) {
        const encoded = encodeLiveWsNotice({
            channel: input.publication.channel,
            publisherId: input.publication.publisherId,
            expiresAtMs,
            message: input.message,
            scope,
            audience: { mode: 'peer', recipientSessionIds: [input.recipientSessionId] },
            inbound: {
                namespace: input.service.getInboundNamespace(),
                reference: { senderId: input.message.id.senderId, msgId: input.message.id.msgId }
            }
        });
        if (encoded.kind === 'oversize') {
            throw new TypeError(`Admitted RTC signaling notice is oversized (${encoded.inlineBytes} bytes).`);
        }
        await input.publication.transport.publish(encoded.notice);
    }
    const sent = input.service.sendToTargetsWithResult({
        message: input.message,
        expiresAtMs,
        recipientSessionIds: [input.recipientSessionId],
        inboundScope: scope,
        recipientScope: scope,
        requireAuthenticatedRecipient: true
    });
    if (sent.failedCount > 0) {
        console.error(`Local RTC signaling send failed for ${sent.failedCount} recipients.`);
    }
}

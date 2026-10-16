import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WebSocketServerMessageContext } from '@shared/services/queue-message-callbacks.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { toError } from '@shared/resilience/to-error.ts';
import { recordRallarTiming, type RallarTimingSink } from '../observability/timing.ts';
import { encodeLiveWsNotice } from '../queue-pubsub/live-ws-notice.ts';
import type { RallarServerWsRouterOptions } from '../websocket/router/rallar-server-ws-router-contracts.ts';
import { decodeRtcSignalingRoute } from './decode-rtc-signaling-route.ts';
import { isInstanceLocalRtcSignal } from './is-instance-local-rtc-signal.ts';

export interface InstallRtcSignalingWsTopicInput {
    readonly service: WsQueueBoxServerService;
    readonly publication: RallarServerWsRouterOptions['livePublication'];
    /**
     * Whether a socket here is its session's current connection generation. A signal only a stale socket here took
     * is published too: the session's live socket may be on another instance.
     */
    readonly readConnectionCurrentness: (connection: ConnectionContext) => Promise<boolean>;
    readonly nowEpochMs: () => number;
    /**
     * Receives one `rtc-signaling-relay` row per relayed signal, named for where it went, timed from its dispatch;
     * the `ws-receipt` row of the same `msgId` dates its receipt.
     */
    readonly timing: RallarTimingSink | undefined;
}

interface RelayRtcSignalingMessageInput extends InstallRtcSignalingWsTopicInput {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly context: WebSocketServerMessageContext;
    readonly recipientSessionId: string;
}

interface PublishRtcSignalingNoticeInput {
    readonly relay: RelayRtcSignalingMessageInput;
    readonly publication: NonNullable<RallarServerWsRouterOptions['livePublication']>;
    readonly scope: StateScope;
    readonly expiresAtMs: number;
}

/** One signal's local send, which every later step of its relay is timed and reported against. */
interface RtcSignalingRelayAttempt {
    readonly relay: RelayRtcSignalingMessageInput;
    readonly sent: WsServerLiveSendResult;
    readonly dispatchedAtMs: number;
}

type RtcSignalingRelayOperation = 'local-send' | 'cluster-notice' | 'undelivered';

export function installRtcSignalingWsTopic(input: InstallRtcSignalingWsTopicInput): void {
    input.service.onInboxMessageDo(AppTopics.rtcSignaling, {
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
                return relayRtcSignalingMessage({
                    ...input,
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

/**
 * A recipient connected here is sent the signal at once. A signal that reached no current socket here is published for
 * the other instances, whose subscribers skip this publisher's own notices, so a live socket receives it once.
 */
async function relayRtcSignalingMessage(relay: RelayRtcSignalingMessageInput): Promise<void> {
    const scope = relay.context.source.kind === 'ws-client' ? relay.context.source.authenticatedScope : undefined;
    if (!scope) {
        throw new TypeError('Admitted RTC signaling has no authenticated source scope.');
    }
    const expiresAtMs = relay.entry.audit.expiryTs.epochMilliseconds;
    const dispatchedAtMs = relay.nowEpochMs();
    if (expiresAtMs <= dispatchedAtMs) {
        return;
    }
    const sent = sendRtcSignalHere(relay, scope, expiresAtMs);
    const attempt = { relay, sent, dispatchedAtMs };
    if (!relay.publication) {
        recordRtcSignalingRelayTiming(attempt, sent.sentCount > 0 ? 'local-send' : 'undelivered', undefined);
        return;
    }
    if (sent.sentCount > 0 && await readSentConnectionCurrentness(relay)) {
        recordRtcSignalingRelayTiming(attempt, 'local-send', undefined);
        return;
    }
    try {
        await publishRtcSignalingNotice({ relay, publication: relay.publication, scope, expiresAtMs });
        recordRtcSignalingRelayTiming(attempt, 'cluster-notice', undefined);
    }
    catch (error) {
        recordRtcSignalingRelayTiming(attempt, 'cluster-notice', toError(error));
        throw error;
    }
}

function sendRtcSignalHere(
    relay: RelayRtcSignalingMessageInput,
    scope: StateScope,
    expiresAtMs: number
): WsServerLiveSendResult {
    const sent = relay.service.sendToTargetsWithResult({
        message: relay.message,
        expiresAtMs,
        recipientSessionIds: [relay.recipientSessionId],
        inboundScope: scope,
        recipientScope: scope,
        requireAuthenticatedRecipient: true
    });
    if (sent.failedCount > 0) {
        console.error(`Local RTC signaling send failed for ${sent.failedCount} recipients.`);
    }
    return sent;
}

async function readSentConnectionCurrentness(relay: RelayRtcSignalingMessageInput): Promise<boolean> {
    const connection = relay.context.server.connections.get(relay.recipientSessionId);
    return connection !== undefined && await relay.readConnectionCurrentness(connection);
}

/**
 * A notice carries the signal inline whenever it fits. Only a signal admitted to the shared store may travel by its
 * inbound key: an instance-local one is in no store another instance reads.
 */
async function publishRtcSignalingNotice(input: PublishRtcSignalingNoticeInput): Promise<void> {
    const { relay, publication } = input;
    const encoded = encodeLiveWsNotice({
        channel: publication.channel,
        publisherId: publication.publisherId,
        expiresAtMs: input.expiresAtMs,
        message: relay.message,
        scope: input.scope,
        audience: { mode: 'peer', recipientSessionIds: [relay.recipientSessionId] },
        inbound: {
            namespace: relay.service.getInboundNamespace(),
            reference: { senderId: relay.message.id.senderId, msgId: relay.message.id.msgId }
        }
    });
    if (encoded.kind === 'oversize') {
        throw new TypeError(`Admitted RTC signaling notice is oversized (${encoded.inlineBytes} bytes).`);
    }
    if (encoded.kind === 'inbound-key' && isInstanceLocalRtcSignal(relay.message)) {
        throw new TypeError('Instance-local RTC signaling does not fit an inline notice.');
    }
    await publication.transport.publish(encoded.notice);
}

function recordRtcSignalingRelayTiming(
    attempt: RtcSignalingRelayAttempt,
    operation: RtcSignalingRelayOperation,
    error: Error | undefined
): void {
    const { relay, sent } = attempt;
    recordRallarTiming({
        sink: relay.timing,
        event: {
            component: 'rtc-signaling-relay',
            operation,
            sessionId: relay.recipientSessionId,
            details: {
                msgId: relay.message.id.msgId,
                senderId: relay.message.id.senderId,
                recipientCount: sent.recipientCount,
                sentCount: sent.sentCount
            }
        },
        status: error === undefined ? 'ok' : 'error',
        durationMs: relay.nowEpochMs() - attempt.dispatchedAtMs,
        ...(error === undefined ? {} : { error })
    });
}

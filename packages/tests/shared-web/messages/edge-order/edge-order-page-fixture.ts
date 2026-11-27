import { vi } from 'vitest';

import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserChannelRecoveryOwners } from '@shared-web/browser/messages/browser-channel-recovery-owners.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessagesController } from '@shared-web/browser/messages/browser-rallar-messages-controller.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { BrowserGrantedTopics } from '@shared-web/browser/messages/publication/browser-granted-topics.ts';
import { BrowserPublicationStages } from '@shared-web/browser/messages/publication/browser-publication-stages.ts';
import type { RallarRoomMessageChannelDefinition } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { BrowserTopicSubscriptions } from '@shared-web/browser/messages/topic-subscription/browser-topic-subscriptions.ts';
import type { BrowserWebSocketInboxHandler } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { createDefaultBrowserServerClockFixture } from '../../connection/browser-server-clock-fixture.ts';
import { toQueuedMessageAdmission } from '../browser-message-sender-fixture.ts';

export const EDGE_ORDER_TEST_ROOM: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

/** The one recipient an acknowledgement in these tests names: who it is does not matter to the order. */
const RECIPIENT_PEER_ID = 'recipient-session';

export interface EdgeOrderTestMove {
    readonly n: number;
}

/** The edge-ordered room channel the two-page tests send and receive on. */
export const EDGE_ORDER_TEST_MOVES: RallarRoomMessageChannelDefinition = {
    roomRef: EDGE_ORDER_TEST_ROOM,
    topicId: 'room.moves',
    typeId: 'game.move',
    purpose: 'command',
    access: 'members',
    order: 'edge'
};

/**
 * One browser page's messaging stack over a middleware double. What the page hands a carrier is recorded, in
 * admission order, for a test to carry to another page in whatever order its case needs.
 */
export interface EdgeOrderPage {
    readonly messages: RallarMessagesOperations;
    readonly sent: Readonly<Record<ALDeliveryCarrier, ALMessage[]>>;
    readonly diagnostics: ALInboundRuntimeDiagnosticsEvent[];
    /** An arrival at this page over one carrier, as its inbound runtime hands an admitted message over. */
    deliver(carrier: ALDeliveryCarrier, message: ALMessage): Promise<void>;
    /**
     * Every recipient's receipt for a message this page sent reaches it: its handle reads `acknowledged`. A recipient
     * acknowledges when it admits a message, so a test can say this before it delivers the message to that page.
     */
    acknowledge(carrier: ALDeliveryCarrier, message: ALMessage): void;
    /** The carrier settles a message this page sent `superseded`: a newer one replaced it before it left. */
    supersede(carrier: ALDeliveryCarrier, message: ALMessage): void;
    /** The connect goes away: what the lifecycle composition runs at detach. */
    detach(): void;
    /** Each call to connect waits for the next resolver a test queued here; with none queued it resolves at once. */
    readonly heldConnects: Array<Promise<void>>;
}

export interface EdgeOrderPageInput {
    readonly sessionId: string;
    readonly maxPayloadBytes?: number;
}

export function createEdgeOrderPage(input: EdgeOrderPageInput): EdgeOrderPage {
    const sent: Record<ALDeliveryCarrier, ALMessage[]> = { ws: [], rtc: [] };
    const admit = (carrier: ALDeliveryCarrier) => async (message: ALMessage) => {
        sent[carrier].push(message);
        return await Promise.resolve(toQueuedMessageAdmission(message));
    };
    const context = createDefaultApiMiddlewareTestDouble({
        session: { sessionId: input.sessionId },
        serverTime: createDefaultBrowserServerClockFixture(() => Date.now()),
        middleware: {
            rtcRxStreamer: { enqueueOutboxIfAbsent: admit('rtc') },
            webSocketQueueBox: { enqueueOutboxIfAbsent: admit('ws') }
        }
    });
    const rtcCallbacks = new Map<string, Parameters<typeof context.middleware.rtcRxStreamer.onInboxMessageDo>[1]>();
    vi.mocked(context.middleware.rtcRxStreamer.onInboxMessageDo).mockImplementation((typeId, callback) => {
        rtcCallbacks.set(typeId, callback);
        return context.middleware.rtcRxStreamer;
    });
    const wsHandlers = new Map<string, BrowserWebSocketInboxHandler>();
    const deliveries = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 512,
        cancel: () => {}
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
        deliverySettlements: feed,
        readMiddleware: () => context,
        readRtcCaptureReceipt: () => undefined
    }, () => context.session);
    sessionDeliveries.beginSession(context.session);
    const settlementEpoch = feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const heldConnects: Array<Promise<void>> = [];
    const controller = new BrowserRallarMessagesController({
        creation: {
            createUnicast: newALUnicastMessage,
            createMulticast: newALMulticastMessage,
            createBroadcast: newALBroadcastMessage,
            createPrincipalBroadcast: newALPrincipalBroadcastMessage,
            newResourceId: crypto.randomUUID.bind(crypto)
        },
        deliveries,
        sessionDeliveries,
        publicationStages: new BrowserPublicationStages(),
        nowMs: Date.now,
        timers: createDefaultTimers(),
        newEdgeOrderStreamId: crypto.randomUUID.bind(crypto),
        wsInbox: {
            subscribe: (handler) => {
                wsHandlers.set(handler.id, handler);
                return () => wsHandlers.delete(handler.id);
            },
            attach: () => {},
            detach: () => {},
            isAttached: () => true
        },
        recoveryOwners: new BrowserChannelRecoveryOwners(),
        topicSubscriptions: new BrowserTopicSubscriptions({
            http: {
                subscribeGroupTopic: () => Promise.reject(new Error('No channel in this fixture subscribes.')),
                unsubscribeGroupTopic: () => Promise.reject(new Error('No channel in this fixture subscribes.'))
            },
            timers: createDefaultTimers(),
            newRequestId: () => crypto.randomUUID()
        }),
        connect: async () => {
            await heldConnects.shift();
            return context;
        },
        readMiddleware: () => context,
        requireMiddleware: () => context,
        requireSession: () => context.session,
        resolveDefaultRoom: () => undefined,
        resolveCurrentRoomRef: () => undefined,
        toRoomId: (room) => typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: (room) => typeof room === 'string' ? { ...EDGE_ORDER_TEST_ROOM, groupId: room } : room,
        resolveRoomSendFence: (_room, explicit) => ({ minSnapshotVersion: explicit, rosterVersion: undefined }),
        readMessageMaxPayloadBytes: () => input.maxPayloadBytes ?? 64 * 1024,
        readPublicationPermissions: () => undefined,
        grantedTopics: new BrowserGrantedTopics({ findGroupSnapshot: () => undefined }),
        readInboundDiagnostics: () => (event) => diagnostics.push(event)
    });
    return {
        messages: controller.operations,
        sent,
        diagnostics,
        heldConnects,
        deliver: async (carrier, message) => {
            if (carrier === 'rtc') {
                await rtcCallbacks.get(message.payload.typeId)?.onMessage(
                    message,
                    toResourceEntry(message.payload.typeId, {})
                );
                return;
            }
            for (const handler of wsHandlers.values()) {
                await handler.onMessage(message);
            }
        },
        acknowledge: (carrier, message) =>
            settlementEpoch.settlements[carrier]({
                kind: 'acknowledgement',
                msgId: message.id.msgId,
                carrier,
                atMs: Date.now(),
                mode: 'receiver',
                confirmedHopPeerIds: [RECIPIENT_PEER_ID],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: [RECIPIENT_PEER_ID],
                confirmedRecipientPeerIds: [RECIPIENT_PEER_ID],
                unconfirmedRecipientPeerIds: [],
                outsideAudienceRecipientPeerIds: [],
                complete: true,
                traceId: message.id.traceId
            }),
        supersede: (carrier, message) =>
            settlementEpoch.settlements[carrier]({
                kind: 'superseded',
                msgId: message.id.msgId,
                carrier,
                atMs: Date.now(),
                replacementMsgId: crypto.randomUUID(),
                detail: 'A newer message replaced it.',
                traceId: message.id.traceId
            }),
        detach: () => controller.subscriptions.dropHeldEdgeOrderMessages()
    };
}

/** Lets what an already resolved promise unblocked run: the page's sends are a few awaits deep. */
export async function settleTurns(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

/** What the page stated it did not hand over: gaps, dropped arrivals and held messages it gave up. */
export function readEdgeOrderDrops(page: EdgeOrderPage): ALInboundRuntimeDiagnosticsEvent[] {
    return page.diagnostics.filter((event) => event.kind.startsWith('edge-order-') && !(event.kind === 'edge-order-arrival' && event.outcome === 'held'));
}

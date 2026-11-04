import { describe, expect, it } from 'vitest';

import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { BrowserGrantedTopics } from '@shared-web/browser/messages/publication/browser-granted-topics.ts';
import { BrowserPublicationStages } from '@shared-web/browser/messages/publication/browser-publication-stages.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { newALBroadcastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-delivery-carrier.ts';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { toQueuedMessageAdmission } from '../browser-message-sender-fixture.ts';

const DECLARED_TOPIC_ID = 'app.granted-feed';

interface GrantedDispatchFixture {
    readonly dispatch: BrowserRallarMessageDispatch;
    readonly deliveries: BrowserRallarDeliveryRegistry;
    readonly context: ApiMiddleware;
    /** Every carrier admission the dispatch reached, by carrier. */
    readonly admitted: ALDeliveryCarrier[];
}

describe('a members send on a declared granted topic naming no room', () => {
    it.each<[ALDeliveryCarrier, (senderId: string, topicId: string) => ALMessage]>([
        ['ws', (senderId, topicId) => toWorldBroadcast(senderId, topicId)],
        ['rtc', (senderId, topicId) => toRoomlessUnicast(senderId, topicId)]
    ])('is refused unsupported over %s before its leg: a granted delivery names a room', async (carrier, toMessage) => {
        const fixture = createGrantedDispatchFixture();
        const declared = toMessage(fixture.context.session.sessionId, DECLARED_TOPIC_ID);
        const undeclared = toMessage(fixture.context.session.sessionId, 'app.chat');

        const [refused, carried] = await Promise.all([declared, undeclared].map(async (message) => {
            const handle = fixture.deliveries.open(message, carrier);
            fixture.dispatch.send(toMembersDelivery(fixture.context, message, carrier));
            return (await handle.wait({ until: ['queued'] })).lifecycle;
        }));

        expect(refused).toMatchObject({ state: 'rejected', evidence: { failure: { kind: 'refused', reason: 'unsupported' } } });
        expect(carried?.state).toBe('queued');
        expect(fixture.admitted).toEqual([carrier]);
    });
});

function createGrantedDispatchFixture(): GrantedDispatchFixture {
    const admitted: ALDeliveryCarrier[] = [];
    const admit = (carrier: ALDeliveryCarrier) => ({
        enqueueOutboxIfAbsent: async (message: ALMessage) => {
            admitted.push(carrier);
            return await Promise.resolve(toQueuedMessageAdmission(message));
        }
    });
    const context = createDefaultApiMiddlewareTestDouble({
        middleware: { webSocketQueueBox: admit('ws'), rtcRxStreamer: admit('rtc') }
    });
    const deliveries = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 100, maxEntries: 8, cancel: () => {} });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
        readMiddleware: () => context,
        readRtcCaptureReceipt: () => undefined,
        deliverySettlements: feed
    }, () => context.session);
    sessionDeliveries.beginSession(context.session);
    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
    // No room is cached: the declared topic alone makes the send a granted delivery.
    const grantedTopics = new BrowserGrantedTopics({ findGroupSnapshot: () => undefined });
    grantedTopics.declareGrantedTopic(DECLARED_TOPIC_ID);
    const dispatch = new BrowserRallarMessageDispatch({
        deliveries,
        sessionDeliveries,
        publicationStages: new BrowserPublicationStages({ nowMs: Date.now }),
        nowMs: Date.now,
        readPublicationPermissions: () => undefined,
        grantedTopics
    });
    return { dispatch, deliveries, context, admitted };
}

function toMembersDelivery(
    context: ApiMiddleware,
    message: ALMessage,
    carrier: ALDeliveryCarrier
): BrowserRallarMessageDispatch.Delivery {
    return {
        context,
        message,
        carrier,
        requestedConfiguration: undefined,
        rtcCapture: { status: 'unavailable', reason: 'absent' },
        canFallback: false,
        payloadIssues: [],
        access: 'members',
        onStorageUnavailable: 'refuse',
        publication: undefined
    };
}

function toWorldBroadcast(senderId: string, topicId: string): ALMessage {
    return newALBroadcastMessage(senderId, { topicId, contextId: 'all', resourceId: 'one' }, 'world', 'feed.v1', {}, {
        ack: 'none',
        ttlMs: 30_000
    });
}

function toRoomlessUnicast(senderId: string, topicId: string): ALMessage {
    return newALUnicastMessage(senderId, { topicId, contextId: 'all', resourceId: 'one' }, 'peer-b', 'feed.v1', {}, {
        ack: 'none',
        ttlMs: 30_000
    });
}

import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

type CarrierGap = 'no room snapshot' | 'room halted' | 'no accepted layout';
type Durability = 'volatile' | 'local-outbox';

interface CarrierGapFixture {
    readonly origin: RtcOriginOverlayFixture;
    readonly wsAdmissions: ALMessage[];
    /** An RTC first leg; `canFallback` is the default `rtc-with-ws-fallback` strategy, false is `rtc` alone. */
    send(message: ALMessage, canFallback: boolean): Promise<RallarMessageHandle>;
}

describe('a room send whose RTC carrier is in a gap at admission', () => {
    it.each(
        [
            ['no room snapshot', 'volatile'],
            ['no room snapshot', 'local-outbox'],
            ['room halted', 'volatile'],
            ['room halted', 'local-outbox'],
            ['no accepted layout', 'volatile'],
            ['no accepted layout', 'local-outbox']
        ] as const
    )(
        'hands a default rtc-with-ws-fallback send over to WS at once with %s (%s)',
        async (gap, durability) => {
            const fixture = createCarrierGapFixture(gap);
            const message = createRoomCommand(`hand-over-${gap}-${durability}`, durability);

            const handle = await fixture.send(message, true);

            expect(fixture.wsAdmissions.map((admitted) => admitted.id.msgId)).toEqual([
                message.id.msgId
            ]);
            expect(handle.lifecycle().state).toBe('queued');
            expect(handle.lifecycle().evidence.attempts).toEqual([
                expect.objectContaining({
                    carrier: 'rtc',
                    outcome: 'unroutable',
                    unroutableReason: 'no-route'
                })
            ]);
            expect(await fixture.origin.resources.workQueue.getAllKeys()).toEqual([]);
        }
    );

    it.each(['no room snapshot', 'room halted', 'no accepted layout'] as const)(
        'keeps an rtc-only durable send on RTC with %s, handing nothing to WS',
        async (gap) => {
            const fixture = createCarrierGapFixture(gap);
            const message = createRoomCommand(`hold-${gap}`, 'local-outbox');

            const handle = await fixture.send(message, false);

            expect(fixture.wsAdmissions).toEqual([]);
            expect(handle.lifecycle()).toMatchObject({
                state: 'accepted',
                evidence: { admittedDurable: true }
            });
            expect(await fixture.origin.resources.workQueue.getAllKeys()).not.toEqual([]);
        }
    );
});

function createCarrierGapFixture(gap: CarrierGap): CarrierGapFixture {
    const origin = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c']
    });
    const snapshot = toGapSnapshot(gap);
    if (snapshot === undefined) {
        origin.groups.delete('room');
    }
    else {
        origin.groups.accept('room', snapshot);
    }
    const wsAdmissions: ALMessage[] = [];
    const context = createDefaultApiMiddlewareTestDouble({
        session: { sessionId: 'a' },
        middleware: {
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: (message, carrierGap) => origin.manager.enqueueLegIfAbsent(message, carrierGap)
            },
            webSocketQueueBox: {
                enqueueOutboxIfAbsent: async (message): Promise<ALOutboundEnqueueResult> => {
                    wsAdmissions.push(message);
                    return {
                        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
                        message,
                        entries: [],
                        trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
                    };
                }
            }
        }
    });
    const deliveries = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 512,
        cancel: () => {}
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
        deliverySettlements: feed,
        readMiddleware: () => context
    });
    sessionDeliveries.beginSession(context.session);
    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
    const dispatch = new BrowserRallarMessageDispatch({
        deliveries,
        sessionDeliveries,
        nowMs: Date.now
    });
    return {
        origin,
        wsAdmissions,
        send: async (message, canFallback) => {
            const handle = deliveries.open(message, 'rtc');
            dispatch.send({
                context,
                carrier: 'rtc',
                message,
                canFallback,
                payloadIssues: [],
                onStorageUnavailable: 'refuse'
            });
            await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
            return handle;
        }
    };
}

function toGapSnapshot(gap: CarrierGap): GroupSnapshot | undefined {
    const snapshot = createOriginSnapshot(['a', 'b', 'c'], 4);
    switch (gap) {
        case 'no room snapshot':
            return undefined;
        case 'room halted':
            return { ...snapshot, group: { ...snapshot.group, transportState: 'halted' } };
        case 'no accepted layout':
            return { ...snapshot, group: { ...snapshot.group, acceptedLayoutIdentity: null } };
    }
}

function createRoomCommand(resourceId: string, durability: Durability): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'room.command', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'room.command.v1',
        { action: 'ready' },
        {
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: 30_000,
            qos: { durability: { algo: durability } }
        }
    );
}

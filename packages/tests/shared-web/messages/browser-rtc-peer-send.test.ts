import { describe, expect, it, vi } from 'vitest';

import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryCarrier,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { AL_FALLBACK_NOT_READY_ATTEMPTS } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const COMMAND_CHANNEL = { purpose: 'command', durability: undefined, onStorageUnavailable: 'refuse' } as const;
const DIRECTOR = 'director';
const INTENT = {
    typeId: 'room.director.intent.v1',
    topicId: 'room.director.intent',
    payload: { intent: 'pickup' }
};
const DIRECTOR_UNICAST = { mode: 'unicast', toPeerId: DIRECTOR, groupRef: ROOM_REF };
const ADMITTED: ALDeliveryAdmissionVerdict = {
    kind: 'admitted',
    durable: false,
    queuedAttempts: 1
};
const NO_ROUTE: ALDeliveryAdmissionVerdict = {
    kind: 'unroutable',
    reason: 'no-route',
    detail: 'Skipping RTC outbound dispatch without planned transport messages'
};
const SERVER_OVER_WS = 'The server is addressed over WS: a peer-addressed send to it takes the ws strategy.';
const SERVER_NAMES_NO_PEER_ID = 'A peer-addressed send needs a server that names its peer id; this server names none.';
const CONTEXT_NAMES_ANOTHER_ROOM = 'A peer-addressed send routes in the room it names: contextId must equal the room id.';

describe('a typed send addressed to one peer over RTC (Q11, C7)', () => {
    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'admits one receipted room unicast on RTC for a command channel on %s',
        async (strategy) => {
            const fixture = createBrowserMessageSenderFixture();
            const rtcAdmission = vi.spyOn(
                fixture.middleware.middleware.rtcRxStreamer,
                'enqueueOutboxIfAbsent'
            );

            const handle = await fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                peerId: DIRECTOR,
                strategy
            }, COMMAND_CHANNEL);

            const message = rtcAdmission.mock.calls[0][0];
            expect(message.id.msgId).toBe(handle.msgId);
            expect(message.targets).toEqual(DIRECTOR_UNICAST);
            expect(message.route).toMatchObject({
                topicId: 'room.director.intent',
                contextId: 'room'
            });
            // A unicast that names its room has a logical audience, so a command asks the addressee receipt.
            expect(message.delivery).toEqual({
                ownership: 'shared',
                reliability: 'at-least-once',
                ack: 'receiver'
            });
            expect(message.qos?.durability).toEqual({ algo: 'volatile' });
        }
    );

    it('names the current room when the send names none: over RTC a peer send always names its room', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendTyped({ ...INTENT, peerId: DIRECTOR }, COMMAND_CHANNEL);

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.targets).toEqual(DIRECTOR_UNICAST);
        expect(message.route.contextId).toBe('room');
    });

    it('sends a typed room channel send to one peer over RTC with WS fallback by default (D75)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );
        const channels = new BrowserTypedMessageChannels({
            inputValidator: new BrowserMessageInputValidator({
                readMaxPayloadBytes: () => 64 * 1024
            }),
            sender: fixture.sender,
            rtc: { onMessage: () => () => {} },
            ws: { onMessage: () => () => {} }
        });
        const intents = channels.room<{ intent: string; }>({
            topicId: 'room.director.intent',
            typeId: 'room.director.intent.v1',
            roomId: 'room',
            purpose: 'command'
        });

        await intents.send({ intent: 'pickup' }, { peerId: DIRECTOR });

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.targets).toEqual(DIRECTOR_UNICAST);
        expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'receiver' });
    });

    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)(
        'refuses a contextId naming another room at the sender on %s (N1, C8)',
        async (strategy) => {
            const fixture = createBrowserMessageSenderFixture();
            const admitted = captureCarrierAdmissions(fixture);

            await expect(fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                contextId: 'other-room',
                peerId: DIRECTOR,
                strategy
            }, COMMAND_CHANNEL)).rejects.toMatchObject({
                issues: [{
                    path: '$.contextId',
                    code: 'context-room-mismatch',
                    message: CONTEXT_NAMES_ANOTHER_ROOM
                }]
            });
            expect(admitted).toEqual([]);
        }
    );

    it('accepts a contextId that names its own room', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendTyped({
            ...INTENT,
            roomId: 'room',
            contextId: 'room',
            peerId: DIRECTOR
        }, COMMAND_CHANNEL);

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.route.contextId).toBe('room');
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'refuses a send to the server on %s: the server is addressed over WS (C9)',
        async (strategy) => {
            const fixture = createBrowserMessageSenderFixture();
            const admitted = captureCarrierAdmissions(fixture);

            await expect(
                fixture.sender.sendTyped(
                    { ...INTENT, roomId: 'room', peerId: 'server', strategy },
                    COMMAND_CHANNEL
                )
            )
                .rejects.toMatchObject({
                    issues: [{ path: '$.peerId', code: 'unsupported', message: SERVER_OVER_WS }]
                });
            expect(admitted).toEqual([]);
        }
    );

    it('refuses a fallback send while the server names no peer id, since its second leg is WS (R-S3c-i-32, C9)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        Object.assign(fixture.middleware.middleware.webSocketQueueBox, { serverPeerId: undefined });

        await expect(
            fixture.sender.sendTyped(
                { ...INTENT, roomId: 'room', peerId: DIRECTOR },
                COMMAND_CHANNEL
            )
        )
            .rejects.toMatchObject({
                issues: [{
                    path: '$.peerId',
                    code: 'unsupported',
                    message: SERVER_NAMES_NO_PEER_ID
                }]
            });
    });

    it('sends a plain RTC peer send while the server names no peer id: it never reaches WS (C9)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        Object.assign(fixture.middleware.middleware.webSocketQueueBox, { serverPeerId: undefined });
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendTyped({
            ...INTENT,
            roomId: 'room',
            peerId: DIRECTOR,
            strategy: 'rtc'
        }, COMMAND_CHANNEL);

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.targets).toEqual(DIRECTOR_UNICAST);
    });

    it.each([
        ['exclusions', { exceptPeerIds: ['peer-c'] }],
        ['a membership fence', { membershipEpoch: 1 }],
        ['a next hop', { nextHopPeerIds: ['peer-c'] }],
        ['an overlay', { overlayId: 'overlay-1' }],
        ['a fan-out limit', { fanoutLimit: 2 }]
    ])(
        'refuses a peer send over RTC that carries %s, which a unicast cannot honour',
        async (_name, extra) => {
            const fixture = createBrowserMessageSenderFixture();
            const admitted = captureCarrierAdmissions(fixture);

            const sending = fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                peerId: DIRECTOR,
                ...extra
            }, COMMAND_CHANNEL);

            await expect(sending).rejects.toSatisfy(isRallarValidationError);
            await expect(sending).rejects.toMatchObject({
                issues: expect.arrayContaining([
                    expect.objectContaining({ path: '$.peerId', code: 'unsupported' })
                ])
            });
            expect(admitted).toEqual([]);
        }
    );

    it('refuses a peer send over RTC whose scope is not its room', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admitted = captureCarrierAdmissions(fixture);

        await expect(
            fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                peerId: DIRECTOR,
                scope: 'all',
                strategy: 'rtc'
            }, COMMAND_CHANNEL)
        )
            .rejects.toMatchObject({ issues: [{ path: '$.scope', code: 'unsupported' }] });
        expect(admitted).toEqual([]);
    });
});

describe('what the handle of a peer send over RTC reads (Q11, D56)', () => {
    it('ends acknowledged on RTC when the addressee is directly ready and ACKs', async () => {
        const fixture = createPeerFallbackFixture(ADMITTED);
        const handle = await fixture.send('rtc-with-ws-fallback');

        fixture.settle(toReceipt(handle.msgId, 'rtc'));

        expect(handle.lifecycle().state).toBe('acknowledged');
        expect(handle.lifecycle().evidence.carrierFallback).toBeUndefined();
        expect(handle.lifecycle().evidence.failure).toBeUndefined();
        expect(readCarriers(fixture)).toEqual(['rtc']);
    });

    it('falls back at admission when the addressee is missing from a non-empty ready set, the WS leg keeping its room', async () => {
        const fixture = createPeerFallbackFixture(NO_ROUTE);
        const handle = await fixture.send('rtc-with-ws-fallback');
        await waitForCarriers(fixture, ['rtc', 'ws']);

        const [rtcLeg, wsLeg] = fixture.admissions;
        // The WS leg is the envelope the RTC admission returned: its msgId, its deadline, its room and its context.
        expect(wsLeg!.message).toEqual(rtcLeg!.message);
        expect(wsLeg!.message.targets).toEqual(DIRECTOR_UNICAST);
        expect(wsLeg!.message.route.contextId).toBe('room');
        expect(fixture.handedOver).toEqual([]);
        expect(handle.lifecycle().evidence.attempts).toMatchObject([{
            carrier: 'rtc',
            outcome: 'unroutable'
        }]);

        fixture.settle(toReceipt(handle.msgId, 'ws'));

        expect(handle.lifecycle().state).toBe('acknowledged');
    });

    it('hands the leg to WS after the not-ready bound when the addressee is connected but not the overlay next hop', async () => {
        const fixture = createPeerFallbackFixture(ADMITTED);
        const handle = await fixture.send('rtc-with-ws-fallback');

        for (let attempt = 1; attempt < AL_FALLBACK_NOT_READY_ATTEMPTS; attempt += 1) {
            fixture.settle(toNotReady(handle.msgId, `send-${attempt}`));
        }
        expect(fixture.handedOver).toEqual([]);
        fixture.settle(toNotReady(handle.msgId, 'send-last'));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        expect(fixture.handedOver).toEqual([handle.msgId]);
        expect(fixture.admissions[1]!.message).toEqual(fixture.admissions[0]!.message);
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            from: 'rtc',
            to: 'ws',
            reason: 'not-ready'
        });

        fixture.settle(toReceipt(handle.msgId, 'ws'));

        expect(handle.lifecycle().state).toBe('acknowledged');
    });

    it('hands a receipt that ran out on RTC to WS inside the deadline, and ends on the WS receipt', async () => {
        const fixture = createPeerFallbackFixture(ADMITTED);
        const handle = await fixture.send('rtc-with-ws-fallback');

        fixture.settle(toExhausted(handle.msgId));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        expect(handle.lifecycle().state).not.toBe('failed');
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            from: 'rtc',
            to: 'ws',
            reason: 'receipt-exhausted'
        });
        fixture.settle(toReceipt(handle.msgId, 'ws'));
        expect(handle.lifecycle().state).toBe('acknowledged');
        expect(handle.lifecycle().evidence.failure).toBeUndefined();
    });

    describe('on the rtc strategy alone, which never falls back', () => {
        it('ends failed when the addressee has no route', async () => {
            const fixture = createPeerFallbackFixture(NO_ROUTE);
            const handle = await fixture.send('rtc');

            const { lifecycle } = await handle.wait();
            expect(lifecycle.state).toBe('failed');
            expect(lifecycle.evidence.failure).toEqual({ kind: 'unroutable', reason: 'no-route' });
            expect(readCarriers(fixture)).toEqual(['rtc']);
        });

        it('ends failed when the RTC receipt runs out: the receipt end is the message end', async () => {
            const fixture = createPeerFallbackFixture(ADMITTED);
            const handle = await fixture.send('rtc');

            fixture.settle(toExhausted(handle.msgId));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(handle.lifecycle().state).toBe('failed');
            expect(handle.lifecycle().evidence.failure).toMatchObject({
                kind: 'receipt-exhausted',
                cause: 'budget'
            });
            expect(fixture.handedOver).toEqual([]);
            expect(readCarriers(fixture)).toEqual(['rtc']);
        });

        it('keeps the message on RTC through any run of not-ready attempts', async () => {
            const fixture = createPeerFallbackFixture(ADMITTED);
            const handle = await fixture.send('rtc');

            for (let attempt = 0; attempt <= AL_FALLBACK_NOT_READY_ATTEMPTS; attempt += 1) {
                fixture.settle(toNotReady(handle.msgId, `send-${attempt}`));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(fixture.handedOver).toEqual([]);
            expect(readCarriers(fixture)).toEqual(['rtc']);
            expect(handle.lifecycle().state).not.toBe('failed');
        });
    });
});

interface PeerAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly message: ALMessage;
}

interface CarrierDoubles {
    readonly context: ApiMiddleware;
    readonly admissions: readonly PeerAdmission[];
    readonly handedOver: readonly string[];
}

interface PeerFallbackFixture {
    readonly admissions: readonly PeerAdmission[];
    readonly handedOver: readonly string[];
    settle(settlement: ALDeliverySettlement): void;
    send(strategy: 'rtc' | 'rtc-with-ws-fallback'): Promise<RallarMessageHandle>;
}

/** The production sender, dispatch, registry and fallback controller over the carrier doubles. */
function createPeerFallbackFixture(rtcVerdict: ALDeliveryAdmissionVerdict): PeerFallbackFixture {
    const { context, admissions, handedOver } = createCarrierDoubles(rtcVerdict);
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
    const epoch = feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
    const sender = new BrowserRallarMessageSender({
        sessionDeliveries,
        creation: {
            createUnicast: newALUnicastMessage,
            createMulticast: newALMulticastMessage,
            createBroadcast: newALBroadcastMessage,
            newResourceId: crypto.randomUUID.bind(crypto)
        },
        deliveries,
        dispatch: new BrowserRallarMessageDispatch({
            deliveries,
            sessionDeliveries,
            nowMs: Date.now
        }),
        inputValidator: new BrowserMessageInputValidator({ readMaxPayloadBytes: () => 64 * 1024 }),
        connect: async () => context,
        requireSession: () => context.session,
        resolveDefaultRoom: () => ROOM_REF,
        resolveCurrentRoomRef: () => ROOM_REF,
        toRoomId: (room) => typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: () => ROOM_REF,
        resolveRoomMinSnapshotVersion: (_room, explicit) => explicit
    });
    return {
        admissions,
        handedOver,
        settle: (settlement) => epoch.settlements[settlement.carrier](settlement),
        send: async (strategy) => {
            const handle = await sender.sendTyped({
                ...INTENT,
                roomRef: ROOM_REF,
                peerId: DIRECTOR,
                strategy
            }, COMMAND_CHANNEL);
            await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
            return handle;
        }
    };
}

/** RTC answers with `rtcVerdict` and returns the envelope with the deadline it selected; WS admits what it is handed. */
function createCarrierDoubles(rtcVerdict: ALDeliveryAdmissionVerdict): CarrierDoubles {
    const admissions: PeerAdmission[] = [];
    const handedOver: string[] = [];
    const admit = async (
        carrier: ALDeliveryCarrier,
        message: ALMessage
    ): Promise<ALOutboundEnqueueResult> => {
        const admitted = carrier === 'rtc'
            ? {
                ...message,
                constraints: { ...message.constraints, expiresAtMs: message.id.ts + 29_000 }
            }
            : message;
        admissions.push({ carrier, message: admitted });
        return {
            verdict: carrier === 'rtc' ? rtcVerdict : ADMITTED,
            message: admitted,
            entries: [],
            trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(admitted)
        };
    };
    const context = createDefaultApiMiddlewareTestDouble({
        middleware: {
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: (message) => admit('rtc', message),
                handOverOutbox: async (msgId) => {
                    handedOver.push(msgId);
                }
            },
            webSocketQueueBox: { enqueueOutboxIfAbsent: (message) => admit('ws', message) }
        }
    });
    return { context, admissions, handedOver };
}

function readCarriers(fixture: PeerFallbackFixture): readonly ALDeliveryCarrier[] {
    return fixture.admissions.map((admission) => admission.carrier);
}

/** The WS admission settles in a later microtask than its carrier call; one task turn lands it. */
async function waitForCarriers(
    fixture: PeerFallbackFixture,
    carriers: readonly ALDeliveryCarrier[]
): Promise<void> {
    await vi.waitFor(() => expect(readCarriers(fixture)).toEqual(carriers));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function toNotReady(msgId: string, attemptId: string): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        attemptId,
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: 'RTC relay edge is not permitted by current server room topology',
        willRetry: true
    };
}

function toExhausted(msgId: string): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        mode: 'receiver',
        confirmedPeerIds: [],
        unconfirmedPeerIds: [DIRECTOR],
        detail: 'The receipt ran out of retries after 3 of 3.',
        cause: 'budget'
    };
}

function toReceipt(msgId: string, carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId,
        carrier,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: [DIRECTOR],
        confirmedRecipientPeerIds: [DIRECTOR],
        unconfirmedRecipientPeerIds: [],
        complete: true
    };
}

/** Every message either carrier of the fixture is handed, in order: a refused send must leave it empty. */
function captureCarrierAdmissions(
    fixture: ReturnType<typeof createBrowserMessageSenderFixture>
): readonly PeerAdmission[] {
    const admitted: PeerAdmission[] = [];
    const capture = (carrier: ALDeliveryCarrier) => async (message: ALMessage): Promise<ALOutboundEnqueueResult> => {
        admitted.push({ carrier, message });
        return {
            verdict: ADMITTED,
            message,
            entries: [],
            trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
        };
    };
    fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = capture('rtc');
    fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = capture('ws');
    return admitted;
}

import { describe, expect, it, onTestFinished } from 'vitest';

import { installRelayedAckNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice-subscriber.ts';
import { toRelayedAckNotice } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, newALAckControlMessage, type ALAckPayload } from '@shared/al-contracts/al-control.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { WsQueueBoxServerAckRelay } from '@shared/services/ws-queue-box-server/ws-queue-box-server-ack-relay.ts';
import { WsQueueBoxServerReceiptAggregation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts';
import type {
    WsQueueBoxServerReceiptObservation,
    WsQueueBoxServerReceiptObserver
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

async function createObservedServer(observe: WsQueueBoxServerReceiptObserver | undefined, expiresAtEpochMs = Number.MAX_SAFE_INTEGER) {
    const socket = new JsonWebSocketServer();
    for (const id of ['origin', 'recipient']) {
        const native = new SimulatedWebSocket(`ws://${id}`);
        await native.open();
        socket.addConnection(new ConnectionContext({ id, socket: native }));
    }
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(),
        socket,
        name: 'server',
        queueEngine: engine,
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs }),
        targetResolver: { resolveBroadcastRecipients: () => [{ peerId: 'recipient', connectionId: 'recipient' }] },
        ...{ receiptObserver: observe }
    });
    service.authorizeInboundMessagesWith({
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? ({ authorized: true, roomAudience: { recipientPeerIds: ['recipient'], snapshotVersion: 7 } })
                : ({ authorized: true }),
        sendNacks: false
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
    });
    return service;
}

function data(): ALMessage {
    return {
        id: { v: 3, msgId: 'subject', senderId: 'origin', ts: Date.now() },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: 'room' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { ...SCOPE, groupId: 'room' } },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function ack(senderId = 'recipient'): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId: 'ack-1', senderId, ts: Date.now() - 1 },
        {
            ackedMsgId: 'subject',
            originPeerId: 'origin',
            fromPeerId: senderId,
            toPeerId: 'origin',
            logicalRecipientPeerId: senderId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now() - 1
        }
    );
}

function ackPayload(): ALAckPayload {
    const control = decodeALControlMessage(ack()).right;
    if (control?.type !== 'ack') {
        throw new Error('test ACK malformed');
    }
    return control.payload;
}

describe('private upstream receipt observation', () => {
    it('retains real authenticated socket, complete count and distinct outbox outcomes', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => events.push(event));
        expect((await service.acceptIncomingMessage(data(), 'origin')).right?.kind).toBe('admitted');
        const accepted = await service.acceptIncomingMessage(ack(), 'recipient');
        expect(accepted.left).toBeUndefined();
        expect(accepted.right?.kind).toBe('control');
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'socket-decision',
                connectionId: 'recipient',
                fromPeerId: 'recipient',
                scopeDisposition: 'authorized',
                outcome: 'control'
            }),
            expect.objectContaining({
                kind: 'ack-count',
                controlMsgId: 'ack-1',
                source: 'local',
                outcome: 'complete',
                before: expect.objectContaining({ expectedRecipientPeerIds: ['recipient'], confirmedRecipientPeerIds: [] }),
                after: expect.objectContaining({ confirmedRecipientPeerIds: ['recipient'] })
            }),
            expect.objectContaining({
                kind: 'receipt-outbox',
                receipt: expect.objectContaining({ phase: 'complete', msgId: 'subject' }),
                verdict: expect.objectContaining({ kind: 'admitted', durable: true })
            })
        ]));
    });

    it('retains the actual forged socket rejection without inventing a count', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => events.push(event));
        await service.acceptIncomingMessage(data(), 'origin');
        events.length = 0;
        const result = await service.acceptIncomingMessage(ack('forged'), 'recipient');
        expect(result.left?.code).toBe('unauthorized');
        expect(events).toEqual([
            expect.objectContaining({
                kind: 'socket-decision',
                connectionId: 'recipient',
                fromPeerId: 'recipient',
                scopeDisposition: 'unobserved',
                outcome: 'rejected',
                rejectionCode: 'unauthorized'
            })
        ]);
    });
});

interface ReceiptAggregationFixtureEffects {
    readonly clock?: { value: number; };
    readonly acceptServerReceipt?: WsQueueBoxServerReceiptAggregation.Dependencies['acceptServerReceipt'];
}

function createObservedAggregation(
    observe: WsQueueBoxServerReceiptObserver | undefined,
    enqueue: WsQueueBoxServerReceiptAggregation.Dependencies['enqueueOutbox'],
    effects: ReceiptAggregationFixtureEffects = {}
) {
    const clock = effects.clock ?? { value: 1000 };
    const aggregation = new WsQueueBoxServerReceiptAggregation({
        serverPeerId: 'server',
        clock: { nowMs: () => clock.value },
        newControlId: () => 'receipt-control',
        qosProvider: undefined,
        queueEngine: new InboxOutboxEngine(),
        enqueueOutbox: enqueue,
        acceptServerControl: async () => ({ kind: 'not-handled' }),
        acceptServerReceipt: effects.acceptServerReceipt ?? (async () => ({ kind: 'not-handled' })),
        ...{ receiptObserver: observe }
    });
    aggregation.recordAdmission({
        msgId: 'subject',
        originPeerId: 'origin',
        expectedRecipientPeerIds: ['recipient', 'other'],
        snapshotVersion: 7,
        deadlineAtMs: 30000
    });
    onTestFinished(() => aggregation.dispose());
    return { aggregation, clock };
}

describe('owned receipt count observation', () => {
    it('retains partial, duplicate, outside-audience and deadline decisions with the owned clock and exact frozen sets', () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation, clock } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('no enqueue expected');
        });
        const payload = ackPayload();
        expect(aggregation.recordAck(payload).right?.receipt).toBeUndefined();
        expect(aggregation.recordAck(payload).left?.code).toBe('unauthorized');
        expect(aggregation.recordAck({ ...payload, fromPeerId: 'outside', logicalRecipientPeerId: 'outside' }).left?.code).toBe('unauthorized');
        clock.value = 30000;
        expect(aggregation.recordAck({ ...payload, fromPeerId: 'other', logicalRecipientPeerId: 'other' }).left?.code).toBe('unauthorized');
        expect(aggregation.sweep(30000)).toMatchObject([{ phase: 'timed-out', confirmedRecipientPeerIds: ['recipient'] }]);
        expect(events.map((event) => event.kind === 'ack-count' ? { source: event.source, clock: event.countAtEpochMs, outcome: event.outcome } : undefined))
            .toEqual([
                { source: 'direct', clock: 1000, outcome: 'partial' },
                { source: 'direct', clock: 1000, outcome: 'rejected' },
                { source: 'direct', clock: 1000, outcome: 'rejected' },
                { source: 'direct', clock: 30000, outcome: 'rejected' }
            ]);
        expect(events[0]).toMatchObject({ before: { confirmedRecipientPeerIds: [] }, after: { confirmedRecipientPeerIds: ['recipient'] } });
        expect(events[1]).toMatchObject({ before: { confirmedRecipientPeerIds: ['recipient'] }, after: { confirmedRecipientPeerIds: ['recipient'] } });
        expect(events[3]).toMatchObject({ before: { expectedRecipientPeerIds: ['recipient', 'other'], deadlineAtMs: 30000 } });
    });

    it('records the actual returned outbox verdict after enqueue and never turns a thrown enqueue into a verdict', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        let fail = false;
        const { aggregation } = createObservedAggregation((event) => events.push(event), async (message) => {
            if (fail) {
                throw new Error('enqueue failure');
            }
            return { message, verdict: { kind: 'duplicate' }, entries: [], trackedReceiptAlgo: 'none' };
        });
        await aggregation.acceptControlMessage(ack());
        await aggregation.acceptControlMessage(ack('other'));
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'receipt-outbox',
                    receiptControlMsgId: 'receipt-control',
                    verdict: { kind: 'duplicate' },
                    receipt: expect.objectContaining({ phase: 'complete' })
                })
            ])
        );
        aggregation.recordAdmission({
            msgId: 'subject',
            originPeerId: 'origin',
            expectedRecipientPeerIds: ['recipient'],
            snapshotVersion: 7,
            deadlineAtMs: 30000
        });
        fail = true;
        const before = events.length;
        await expect(aggregation.acceptControlMessage(ack())).rejects.toThrow('enqueue failure');
        expect(events.slice(before)).toMatchObject([{ kind: 'ack-count', outcome: 'complete' }]);
    });
});

describe('owned ACK relay observation', () => {
    it('retains failed publication separately from the existing successful handoff return', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('no receipt expected');
        });
        const relay = new WsQueueBoxServerAckRelay({
            serverPeerId: 'other-server',
            clock: { nowMs: () => 1000 },
            receipts: aggregation,
            readIngressAudience: async () => ['recipient'],
            publishRelayedAck: async () => Either.ofLeft('private transport prose'),
            ...{ receiptObserver: (event: WsQueueBoxServerReceiptObservation) => events.push(event) }
        });
        const message = ack();
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'ack') {
            throw new Error('test ACK malformed');
        }
        const remote = newALAckControlMessage(message.id, { ...control.payload, ackedMsgId: 'other-subject' });
        expect((await relay.relayUnownedAck(remote)).right).toBe(true);
        expect(events).toEqual([
            expect.objectContaining({
                kind: 'ack-relay',
                controlMsgId: 'ack-1',
                outcome: 'publication-failed',
                ack: expect.objectContaining({ ackedMsgId: 'other-subject' })
            })
        ]);
    });
});

describe('private evidence does not control delivery', () => {
    it('retains scope refusal from the already-read authority proof without counting', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const service = await createObservedServer((event) => events.push(event), 0);
        const result = await service.acceptIncomingMessage(ack(), 'recipient');
        expect(result.left?.code).toBe('unauthorized');
        expect(events).toMatchObject([{
            kind: 'socket-decision',
            fromPeerId: 'recipient',
            authenticatedScope: SCOPE,
            scopeDisposition: 'refused',
            scopeAtEpochMs: expect.any(Number),
            outcome: 'rejected'
        }]);
    });

    it('keeps real socket results and aggregate state when the immutable sink throws', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const immutableChecks: boolean[] = [];
        const service = await createObservedServer((event) => {
            events.push(event);
            immutableChecks.push(Object.isFrozen(event));
            if (event.kind === 'ack-count' && event.after !== undefined) {
                immutableChecks.push(Object.isFrozen(event.after.confirmedRecipientPeerIds));
                immutableChecks.push(!Reflect.set(event.after.confirmedRecipientPeerIds, '0', 'forged'));
            }
            throw new Error('sink failed');
        });
        expect((await service.acceptIncomingMessage(data(), 'origin')).right?.kind).toBe('admitted');
        expect((await service.acceptIncomingMessage(ack(), 'recipient')).right?.kind).toBe('control');
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'ack-count', outcome: 'complete', after: expect.objectContaining({ confirmedRecipientPeerIds: ['recipient'] }) }),
            expect.objectContaining({
                kind: 'receipt-outbox',
                receipt: expect.objectContaining({ phase: 'complete', confirmedRecipientPeerIds: ['recipient'] })
            })
        ]));
        expect(immutableChecks.length).toBeGreaterThan(0);
        expect(immutableChecks.every(Boolean)).toBe(true);
        const disabled = await createObservedServer(undefined);
        expect((await disabled.acceptIncomingMessage(data(), 'origin')).right?.kind).toBe('admitted');
        expect((await disabled.acceptIncomingMessage(ack(), 'recipient')).right?.kind).toBe('control');
    });

    it('copies actual enqueue facts before settlement and publishes after its effects even when it throws', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const order: string[] = [];
        const verdict = { kind: 'admitted' as const, durable: true, queuedAttempts: 2 };
        const { aggregation } = createObservedAggregation((event) => {
            order.push(event.kind);
            events.push(event);
        }, async (message) => {
            order.push('enqueue');
            Reflect.set(message.id, 'msgId', 'mutated-control');
            return { message, verdict, entries: [], trackedReceiptAlgo: 'none' };
        }, {
            acceptServerReceipt: async () => {
                order.push('settle');
                verdict.durable = false;
                verdict.queuedAttempts = 99;
                throw new Error('settlement failure');
            }
        });
        await aggregation.acceptControlMessage(ack());
        await expect(aggregation.acceptControlMessage(ack('other'))).rejects.toThrow('settlement failure');
        expect(order).toEqual(['ack-count', 'enqueue', 'settle', 'receipt-outbox', 'ack-count']);
        expect(events.find((event) => event.kind === 'receipt-outbox')).toMatchObject({
            kind: 'receipt-outbox',
            receiptControlMsgId: 'receipt-control',
            verdict: { kind: 'admitted', durable: true, queuedAttempts: 2 },
            receipt: { confirmedRecipientPeerIds: ['recipient', 'other'] }
        });
    });

    it('counts the actual subscriber publisher as relayed provenance without receiving-socket facts', async () => {
        const events: WsQueueBoxServerReceiptObservation[] = [];
        const { aggregation } = createObservedAggregation((event) => events.push(event), async () => {
            throw new Error('partial only');
        });
        const relay = new WsQueueBoxServerAckRelay({
            serverPeerId: 'server',
            clock: { nowMs: () => 1000 },
            receipts: aggregation,
            readIngressAudience: async () => undefined,
            publishRelayedAck: undefined
        });
        await installRelayedAckNoticeSubscriber({
            publisherId: 'owner-publisher',
            channel: 'ws-channel',
            transport: {
                publish: async () => {},
                subscribe: async (_channel, onNotice) => {
                    const notice = toRelayedAckNotice({ publisherId: 'other-publisher', channel: 'ws-channel', message: ack() }).right;
                    if (notice === undefined) {
                        throw new Error('test ACK notice malformed');
                    }
                    await onNotice(notice);
                }
            },
            acceptRelayedAck: (message, publisherId) => relay.acceptRelayedAck(message, publisherId)
        });
        expect(events).toMatchObject([{
            kind: 'ack-count',
            source: 'relayed',
            relayPublisherId: 'other-publisher',
            controlMsgId: 'ack-1',
            outcome: 'partial'
        }]);
        expect(events[0]).not.toHaveProperty('authenticatedScope');
        expect(events[0]).not.toHaveProperty('connectionId');
    });
});

it('publishes count evidence after the existing control receipt effects so sink clock changes cannot change them', async () => {
    const events: WsQueueBoxServerReceiptObservation[] = [];
    const effects: Array<{ readonly kind: string; readonly clock: number; readonly confirmed: readonly string[]; }> = [];
    const clock = { value: 1000 };
    const mutationResults: boolean[] = [];
    const fixture = createObservedAggregation((event) => {
        events.push(event);
        if (event.kind === 'ack-count') {
            clock.value = 90000;
            if (event.after !== undefined) {
                mutationResults.push(Reflect.set(event.after.confirmedRecipientPeerIds, '0', 'forged'));
            }
        }
    }, async (message) => {
        const receipt = JSON.parse(message.payload.resource);
        effects.push({ kind: 'enqueue', clock: clock.value, confirmed: receipt.confirmedRecipientPeerIds });
        return { message, verdict: { kind: 'duplicate' }, entries: [], trackedReceiptAlgo: 'none' };
    }, {
        clock,
        acceptServerReceipt: async (message) => {
            const receipt = JSON.parse(message.payload.resource);
            effects.push({ kind: 'settle', clock: clock.value, confirmed: receipt.confirmedRecipientPeerIds });
            return { kind: 'not-handled' };
        }
    });
    fixture.aggregation.sweep(30000);
    fixture.aggregation.recordAdmission({
        msgId: 'subject',
        originPeerId: 'origin',
        expectedRecipientPeerIds: ['recipient'],
        snapshotVersion: 7,
        deadlineAtMs: 30000
    });
    await fixture.aggregation.acceptControlMessage(ack());
    expect(effects).toEqual([
        { kind: 'enqueue', clock: 1000, confirmed: ['recipient'] },
        { kind: 'settle', clock: 1000, confirmed: ['recipient'] }
    ]);
    expect(events.map((event) => event.kind)).toEqual(['receipt-outbox', 'ack-count']);
    expect(mutationResults).toEqual([false]);
});

it('retains the closed actual storage failure cause while excluding arbitrary enqueue prose', async () => {
    const events: WsQueueBoxServerReceiptObservation[] = [];
    const { aggregation } = createObservedAggregation((event) => events.push(event), async (message) => ({
        message,
        verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'PRIVATE_FAILURE_PROSE' },
        entries: [],
        trackedReceiptAlgo: 'none'
    }));
    await aggregation.acceptControlMessage(ack());
    await aggregation.acceptControlMessage(ack('other'));
    const event = events.find((event) => event.kind === 'receipt-outbox');
    expect(event).toMatchObject({ verdict: { kind: 'storage-unavailable', cause: 'quota' }, trackedReceiptAlgo: 'none' });
    expect(JSON.stringify(event)).not.toContain('PRIVATE_FAILURE_PROSE');
});

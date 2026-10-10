import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage
} from '@shared/al-contracts/al-control.ts';
import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';
import {
    createReceiptTrackingFixture,
    receiptMessage,
    roomMessage,
    type ReceiptTrackingFixture
} from './receipt-tracking-test-fixture.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

describe('WS client receipt tracking for a receiver room send', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('creates the pending receipt from the admitted audience and settles acknowledged on the complete aggregate', async () => {
        const fixture = await createReceiptTrackingFixture();
        const sent = await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        expect(sent.verdict.kind).toBe('admitted');
        expect(await readReceipt(fixture)).toBeUndefined();

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []))).right).toEqual({
            kind: 'control',
            handled: false
        });
        expect(await readReceipt(fixture)).toMatchObject({
            mode: 'receiver',
            expectedPeerIds: ['b', 'c'],
            ackedPeerIds: []
        });

        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));

        // The complete aggregate leaves its final snapshot, so a redelivered receipt finds nothing to move.
        expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: ['b', 'c'], ackedPeerIds: ['b', 'c'] });
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            msgId: 'room-message-1',
            carrier: 'ws',
            mode: 'receiver',
            // A `receiver` receipt at a WS origin names no hop; its server's peer id is the hop of a `hop` or `subtree` send only.
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: ['b', 'c'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('settles a timed-out aggregate at the message deadline, naming the missing recipient, and keeps its final snapshot', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const fixture = await createReceiptTrackingFixture();
        const message = roomMessage();
        await fixture.service.enqueueOutboxIfAbsent(message);
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        // The server sweeps the aggregate once the message deadline has passed; its receipt arrives after it.
        vi.setSystemTime(message.constraints!.expiresAtMs! + 50);

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']))).left).toBeUndefined();

        expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: ['b', 'c'], ackedPeerIds: ['b'] });
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            mode: 'receiver',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: ['c'],
            complete: false
        });
        expect(fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation').at(-1)).toMatchObject({
            phase: 'timed-out',
            commitOutcome: 'committed',
            pendingBefore: { expectedPeerIds: ['b', 'c'], ackedPeerIds: [] },
            candidateAfter: { expectedPeerIds: ['b', 'c'], ackedPeerIds: ['b'] },
            settlement: { confirmedRecipientPeerIds: ['b'], unconfirmedRecipientPeerIds: ['c'], complete: false }
        });
    });

    it('writes nothing for a repeated receipt or one about a message this origin never sent', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
        expect(acknowledgements()).toHaveLength(1);

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c'], { msgId: 'unsent-message', expectedRecipientPeerIds: ['b', 'c'] }));

        expect(acknowledgements()).toHaveLength(1);
        expect(await fixture.outboundStores.admissionStore.readReceiptState({ originPeerId: 'self', msgId: 'unsent-message' }))
            .toBeUndefined();
    });
});

describe('WS client receipt tracking for a volatile send whose server receipt arrives after the deadline (D74)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('settles a timed-out aggregate that arrives inside the receipt grace', async () => {
        const { fixture, message } = await sendVolatileRoomMessage();
        vi.setSystemTime(message.constraints!.expiresAtMs! + AL_RECEIPT_DEADLINE_GRACE_MS - 1);

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']))).left).toBeUndefined();

        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            msgId: 'room-message-1',
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: ['c'],
            complete: false
        });
    });

    it('settles nothing for an aggregate that arrives once the grace has passed', async () => {
        const { fixture, message } = await sendVolatileRoomMessage();
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
        const admittedAcknowledgements = acknowledgements().length;
        vi.setSystemTime(message.constraints!.expiresAtMs! + AL_RECEIPT_DEADLINE_GRACE_MS);

        expect((await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']))).left).toBeUndefined();

        expect(acknowledgements()).toHaveLength(admittedAcknowledgements);
    });
});

describe('WS client receipt tracking for a receiver unicast that names its room (D53)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('expects nobody at admission; the admitted receipt names the addressee and its complete receipt acknowledges it', async () => {
        const fixture = await createReceiptTrackingFixture();
        const unicast: ALMessage = {
            ...roomMessage(),
            id: { ...roomMessage().id, msgId: 'unicast-message-1' },
            targets: { mode: 'unicast', toPeerId: 'b', groupRef: ROOM }
        };
        expect((await fixture.service.enqueueOutboxIfAbsent(unicast)).verdict.kind).toBe(
            'admitted'
        );
        const readUnicastReceipt = async () =>
            await fixture.outboundStores.admissionStore.readReceiptState({
                originPeerId: 'self',
                msgId: 'unicast-message-1'
            });
        expect(await readUnicastReceipt()).toBeUndefined();

        await fixture.service.acceptIncomingMessage(
            receiptMessage('admitted', [], { msgId: 'unicast-message-1', expectedRecipientPeerIds: ['b'] })
        );
        expect(await readUnicastReceipt()).toMatchObject({
            mode: 'receiver',
            expectedPeerIds: ['b'],
            ackedPeerIds: []
        });
        await fixture.service.acceptIncomingMessage(
            receiptMessage('complete', ['b'], { msgId: 'unicast-message-1', expectedRecipientPeerIds: ['b'] })
        );

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'unicast-message-1',
            mode: 'receiver',
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('refuses a room send that asks for a leader receipt by quality of service alone as unsupported', async () => {
        const fixture = await createReceiptTrackingFixture();

        const sent = await fixture.service.enqueueOutboxIfAbsent({
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'receiver' },
            qos: { ack: { algo: 'leader' } }
        });

        expect(sent.verdict).toMatchObject({ kind: 'refused', reason: 'unsupported' });
        expect(await readReceipt(fixture)).toBeUndefined();
    });

    it('tracks a group-leader room send as the leader receipt the admitted receipt names, and acknowledges it on the leader alone', async () => {
        const fixture = await createReceiptTrackingFixture();
        const leaderSend: ALMessage = { ...roomMessage(), delivery: { reliability: 'at-least-once', ack: 'group-leader' } };
        const sent = await fixture.service.enqueueOutboxIfAbsent(leaderSend);
        expect([sent.verdict.kind, sent.trackedReceiptAlgo]).toEqual(['admitted', 'leader']);
        expect(await readReceipt(fixture)).toBeUndefined();

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', [], { msgId: 'room-message-1', expectedRecipientPeerIds: ['c'] }));
        expect(await readReceipt(fixture)).toMatchObject({ mode: 'leader', expectedPeerIds: ['c'], ackedPeerIds: [] });
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
        const admittedAcknowledgements = acknowledgements().length;
        // The server's own ACK confirms its hop, not the leader.
        await fixture.service.acceptIncomingMessage(serverAck('room-message-1'));
        expect(await readReceipt(fixture)).toMatchObject({ mode: 'leader', expectedPeerIds: ['c'], ackedPeerIds: [] });
        expect(acknowledgements()).toHaveLength(admittedAcknowledgements);
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['c'], { msgId: 'room-message-1', expectedRecipientPeerIds: ['c'] }));

        expect(acknowledgements().at(-1)).toMatchObject({
            msgId: 'room-message-1',
            mode: 'leader',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: ['c'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });
});

describe('WS client receipts the server answers itself (R-S3a-4, D57 as applied)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('tracks a hop room send against its server, the one hop a WS origin has', async () => {
        const fixture = await createReceiptTrackingFixture();
        const hop: ALMessage = {
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        };
        await fixture.service.enqueueOutboxIfAbsent(hop);
        expect(await readReceipt(fixture)).toMatchObject({
            mode: 'hop',
            expectedPeerIds: ['server'],
            ackedPeerIds: []
        });

        await fixture.service.acceptIncomingMessage(serverAck('room-message-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'room-message-1',
            mode: 'hop',
            confirmedHopPeerIds: ['server'],
            unconfirmedHopPeerIds: [],
            complete: true
        });
    });

    it('tracks a subtree room send against its server and completes on the server\'s own delivered ACK', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent({
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'subtree' } }
        });
        expect(await readReceipt(fixture)).toMatchObject({
            mode: 'subtree',
            expectedPeerIds: ['server'],
            ackedPeerIds: []
        });

        await fixture.service.acceptIncomingMessage(serverAck('room-message-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'room-message-1',
            mode: 'subtree',
            confirmedHopPeerIds: ['server'],
            unconfirmedHopPeerIds: [],
            complete: true
        });
    });

    it('expects the server itself for a receiver command addressed to it and completes on the server\'s own ACK', async () => {
        const fixture = await createReceiptTrackingFixture();
        const command: ALMessage = {
            ...roomMessage(),
            id: { ...roomMessage().id, msgId: 'server-command-1' },
            targets: { mode: 'unicast', toPeerId: 'server', groupRef: ROOM }
        };
        await fixture.service.enqueueOutboxIfAbsent(command);
        expect(
            await fixture.outboundStores.admissionStore.readReceiptState({
                originPeerId: 'self',
                msgId: 'server-command-1'
            })
        )
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['server'], ackedPeerIds: [] });

        await fixture.service.acceptIncomingMessage(serverAck('server-command-1'));

        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        ).toMatchObject({
            msgId: 'server-command-1',
            mode: 'receiver',
            confirmedRecipientPeerIds: ['server'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('tracks no server hop while the server named no peer id: one that predates S3c-i (R-S3c-i-6)', async () => {
        const fixture = await createReceiptTrackingFixture({ serverPeerId: undefined });

        await fixture.service.enqueueOutboxIfAbsent({
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        });

        expect(await readReceipt(fixture)).toBeUndefined();
    });

    it('tracks a group-leader room send from the admitted receipt while the server named no peer id', async () => {
        const fixture = await createReceiptTrackingFixture({ serverPeerId: undefined });

        const sent = await fixture.service.enqueueOutboxIfAbsent({
            ...roomMessage(),
            delivery: { reliability: 'at-least-once', ack: 'group-leader' }
        });
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', [], { msgId: 'room-message-1', expectedRecipientPeerIds: ['c'] }));

        expect(sent.trackedReceiptAlgo).toBe('leader');
        expect(await readReceipt(fixture)).toMatchObject({ mode: 'leader', expectedPeerIds: ['c'], ackedPeerIds: [] });
    });
});

describe('WS client receipt admission edges', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it.each(['control-admission', 'receipt-confirmation'] as const)(
        'preserves acknowledgement within receipt grace when a %s observer reads the handle lifecycle',
        async (observedKind) => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(1_000_000);
            const registry = new BrowserRallarDeliveryRegistry({
                nowMs: () => Date.now(),
                retainTerminalMs: 60_000,
                maxEntries: 512,
                cancel: () => undefined
            });
            const message = roomMessage();
            const handle = registry.open(message, 'ws');
            const observedStates: string[] = [];
            const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
            const fixture = await createReceiptTrackingFixture({
                serverPeerId: 'server',
                diagnosticsSink: (event) => {
                    diagnostics.push(event);
                    if (event.kind === observedKind && event.phase === 'complete') {
                        observedStates.push(handle.lifecycle().state);
                    }
                },
                settlementSink: (settlement) => registry.record(settlement)
            });
            expect((await fixture.service.enqueueOutboxIfAbsent(message)).verdict.kind).toBe('admitted');
            vi.setSystemTime(1_030_001);

            const result = await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));

            expect(result.right).toEqual({ kind: 'control', handled: false });
            expect(observedStates).toEqual(['acknowledged']);
            expect(handle.lifecycle()).toMatchObject({
                state: 'acknowledged',
                evidence: { expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: ['b', 'c'] }
            });
            expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: ['b', 'c'], ackedPeerIds: ['b', 'c'] });
            expect(diagnostics.filter((event) => event.kind === 'receipt-confirmation').at(-1)).toMatchObject({
                confirmedRecipientPeerIds: ['b', 'c'],
                candidateAfter: { expectedPeerIds: ['b', 'c'], ackedPeerIds: ['b', 'c'] },
                commitOutcome: 'committed',
                settlement: {
                    expectedRecipientPeerIds: ['b', 'c'],
                    confirmedRecipientPeerIds: ['b', 'c'],
                    unconfirmedRecipientPeerIds: [],
                    confirmedHopPeerIds: [],
                    unconfirmedHopPeerIds: [],
                    complete: true
                }
            });
        }
    );

    it.each([
        { confirmed: ['b'], unconfirmed: ['c'], complete: false },
        { confirmed: ['b', 'c'], unconfirmed: [], complete: true }
    ])('retains actual complete-phase confirmation facts for $confirmed', async ({ confirmed, unconfirmed, complete }) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const fixture = await createReceiptTrackingFixture({
            serverPeerId: 'server',
            settlementSink: (settlement) => {
                if (settlement.kind === 'acknowledgement' && settlement.confirmedRecipientPeerIds.length > 0) {
                    Reflect.set(settlement.expectedRecipientPeerIds, '0', 'mutated-expected');
                    Reflect.set(settlement.confirmedRecipientPeerIds, '0', 'mutated-confirmed');
                    Reflect.set(settlement.unconfirmedRecipientPeerIds, '0', 'mutated-unconfirmed');
                    Reflect.set(settlement.confirmedHopPeerIds, '0', 'mutated-confirmed-hop');
                    Reflect.set(settlement.unconfirmedHopPeerIds, '0', 'mutated-unconfirmed-hop');
                }
            }
        });
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        const before = await fixture.outboundStores.admissionStore.readReceiptAdmission({ originPeerId: 'self', msgId: 'room-message-1' });
        vi.setSystemTime(1_000_100);
        const control = receiptMessage('complete', confirmed);
        vi.setSystemTime(1_000_150);

        await fixture.service.acceptIncomingMessage(control);

        const confirmation = fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation').at(-1);
        expect(confirmation).toMatchObject({
            kind: 'receipt-confirmation',
            msgId: 'receipt-complete',
            typeId: AL_CONTROL_RECEIPT_TYPE_ID,
            controlSenderId: 'server',
            targetMsgId: 'room-message-1',
            originPeerId: 'self',
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: confirmed,
            snapshotVersion: 7,
            phase: 'complete',
            observedAtEpochMs: 1_000_100,
            admissionAtMs: 1_000_150,
            attempt: 1,
            senderVersion: before.clientRecord?.version,
            commitOutcome: 'committed',
            pendingBefore: { mode: 'receiver', expectedPeerIds: ['b', 'c'], ackedPeerIds: [], deadlineAtMs: 1_030_000 },
            candidateAfter: { mode: 'receiver', expectedPeerIds: ['b', 'c'], ackedPeerIds: confirmed, deadlineAtMs: 1_030_000 },
            candidateExpiresAtMs: 1_030_000 + AL_RECEIPT_DEADLINE_GRACE_MS,
            settlement: {
                kind: 'acknowledgement',
                msgId: 'room-message-1',
                mode: 'receiver',
                confirmedHopPeerIds: [],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: ['b', 'c'],
                confirmedRecipientPeerIds: confirmed,
                unconfirmedRecipientPeerIds: unconfirmed,
                complete
            }
        });
        expect(before.clientRecord?.version).not.toBe(7);
        const acknowledgement = fixture.settlements.filter((event) => event.kind === 'acknowledgement').at(-1)!;
        expect(acknowledgement).toMatchObject({
            expectedRecipientPeerIds: ['mutated-expected', 'c'],
            confirmedRecipientPeerIds: complete ? ['mutated-confirmed', 'c'] : ['mutated-confirmed'],
            unconfirmedRecipientPeerIds: ['mutated-unconfirmed'],
            confirmedHopPeerIds: ['mutated-confirmed-hop'],
            unconfirmedHopPeerIds: ['mutated-unconfirmed-hop'],
            complete
        });
    });

    it('retains explicit absence for unknown receipts and the first admitted pending row', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
        expect(fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation')).toEqual([
            expect.objectContaining({
                pendingBefore: null,
                candidateAfter: null,
                candidateExpiresAtMs: null,
                senderVersion: null,
                settlement: null,
                commitOutcome: 'not-attempted',
                attempt: 1
            })
        ]);
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        expect(fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation').at(-1)).toMatchObject({
            pendingBefore: null,
            candidateAfter: { expectedPeerIds: ['b', 'c'], ackedPeerIds: [] },
            commitOutcome: 'committed',
            settlement: { complete: false, unconfirmedRecipientPeerIds: ['b', 'c'] }
        });
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        expect(fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation').at(-1)).toMatchObject({
            pendingBefore: { expectedPeerIds: ['b', 'c'], ackedPeerIds: [] },
            candidateAfter: { expectedPeerIds: ['b', 'c'], ackedPeerIds: [] },
            commitOutcome: 'not-attempted',
            settlement: null
        });
    });

    it('retains each actual conflicted or expired attempt without inventing a settlement', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        const store = fixture.outboundStores.admissionStore;
        const before = await store.readReceiptAdmission({ originPeerId: 'self', msgId: 'room-message-1' });
        const commitBundle = store.commitBundle.bind(store);
        const commit = vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const concurrent = roomMessage();
            await fixture.service.enqueueOutboxIfAbsent({ ...concurrent, id: { ...concurrent.id, msgId: 'concurrent-send' } });
            return await commitBundle(bundle);
        });
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        expect(fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation')).toEqual([
            expect.objectContaining({
                attempt: 1,
                senderVersion: before.clientRecord!.version,
                commitOutcome: 'conflict',
                pendingBefore: null,
                settlement: null
            }),
            expect.objectContaining({
                attempt: 2,
                senderVersion: before.clientRecord!.version + 1,
                commitOutcome: 'committed',
                pendingBefore: null,
                settlement: expect.objectContaining({ complete: false })
            })
        ]);
        commit.mockResolvedValue('conflict');
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
        expect(fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation').slice(-3)).toEqual(
            [1, 2, 3].map((attempt) =>
                expect.objectContaining({ attempt, commitOutcome: 'conflict', pendingBefore: expect.objectContaining({ ackedPeerIds: [] }), settlement: null })
            )
        );
        commit.mockResolvedValueOnce('expired');
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
        expect(fixture.diagnostics.filter((event) => event.kind === 'receipt-confirmation').at(-1)).toMatchObject({
            attempt: 1,
            commitOutcome: 'expired',
            settlement: null
        });
        expect(await readReceipt(fixture)).toMatchObject({ ackedPeerIds: [] });
        expect(fixture.settlements.filter((event) => event.kind === 'acknowledgement' && event.complete)).toEqual([]);
    });

    it.each(['absent', 'throwing'] as const)('preserves receipt writes and settlements with an $0 diagnostics sink', async (sink) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const fixture = await createReceiptTrackingFixture({
            serverPeerId: 'server',
            diagnosticsSink: sink === 'absent' ? null : () => {
                throw new Error('test sink failure');
            }
        });
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        const accepted = await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
        expect(accepted.right).toEqual({ kind: 'control', handled: false });
        expect(await readReceipt(fixture)).toMatchObject({ ackedPeerIds: ['b', 'c'] });
        expect(fixture.settlements.filter((event) => event.kind === 'acknowledgement').at(-1)).toMatchObject({
            complete: true,
            confirmedRecipientPeerIds: ['b', 'c']
        });
    });

    it('acknowledges an empty admitted audience at once', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', [], { msgId: 'room-message-1', expectedRecipientPeerIds: [] }));

        expect(await readReceipt(fixture)).toMatchObject({ expectedPeerIds: [], ackedPeerIds: [] });
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
            expect.objectContaining({
                confirmedHopPeerIds: [],
                unconfirmedHopPeerIds: [],
                expectedRecipientPeerIds: [],
                confirmedRecipientPeerIds: [],
                unconfirmedRecipientPeerIds: [],
                complete: true
            })
        ]);
    });

    it('settles a complete aggregate that overtook its admitted receipt, and the late admitted receipt moves nothing', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');

        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));

        expect(acknowledgements()).toEqual([
            expect.objectContaining({ confirmedRecipientPeerIds: ['b', 'c'], unconfirmedRecipientPeerIds: [], complete: true })
        ]);
        expect(await readReceipt(fixture)).toMatchObject({ ackedPeerIds: ['b', 'c'] });
    });

    it('refuses a terminal aggregate about a message this origin never sent', async () => {
        const fixture = await createReceiptTrackingFixture();

        await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']));

        expect(await readReceipt(fixture)).toBeUndefined();
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([]);
    });

    it.each(['admitted', 'complete'] as const)(
        'refuses a redelivered %s receipt after the complete aggregate without a write or a settlement',
        async (redelivered) => {
            const fixture = await createReceiptTrackingFixture();
            await fixture.service.enqueueOutboxIfAbsent(roomMessage());
            await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
            await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c']));
            const settled = fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').length;

            // Receipt rows are durable at-least-once outbox rows: the same receipt may be dispatched again.
            await fixture.service.acceptIncomingMessage(receiptMessage(redelivered, redelivered === 'complete' ? ['b', 'c'] : []));

            const acknowledgements = fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');
            expect(acknowledgements).toHaveLength(settled);
            expect(acknowledgements.at(-1)).toMatchObject({ confirmedRecipientPeerIds: ['b', 'c'], unconfirmedRecipientPeerIds: [], complete: true });
            expect(await readReceipt(fixture)).toMatchObject({ ackedPeerIds: ['b', 'c'] });
        }
    );

    it.each([
        { name: 'after the admitted row it answers', admitted: true },
        { name: 'with no row at all', admitted: false }
    ])('refuses a timed-out receipt past the message deadline plus the receipt grace $name', async ({ admitted }) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const fixture = await createReceiptTrackingFixture();
        const message = roomMessage();
        await fixture.service.enqueueOutboxIfAbsent(message);
        if (admitted) {
            await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        }
        const settled = fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').length;
        vi.setSystemTime(message.constraints!.expiresAtMs! + AL_RECEIPT_DEADLINE_GRACE_MS + 1_000);

        await fixture.service.acceptIncomingMessage(receiptMessage('timed-out', ['b']));

        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toHaveLength(settled);
    });

    it('states one control-admission diagnostic per receipt control, admitted or refused, keyed by the control', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
        await fixture.service.acceptIncomingMessage(receiptMessage('complete', ['b', 'c'], { msgId: 'unsent-message', expectedRecipientPeerIds: ['b', 'c'] }));

        expect(fixture.diagnostics.filter((event) => event.kind === 'control-admission')).toEqual([
            {
                kind: 'control-admission',
                msgId: 'receipt-admitted',
                typeId: AL_CONTROL_RECEIPT_TYPE_ID,
                targetMsgId: 'room-message-1',
                outcome: 'committed',
                reason: 'none',
                phase: 'admitted'
            },
            {
                kind: 'control-admission',
                msgId: 'receipt-complete',
                typeId: AL_CONTROL_RECEIPT_TYPE_ID,
                targetMsgId: 'unsent-message',
                outcome: 'rejected',
                reason: 'AL receipt names no retained outbound message of its origin',
                phase: 'complete'
            }
        ]);
    });

    // R-S3a-9: a recipe waits for the `complete` receipt by matching the serialized event in its key order. The
    // phase comes last, so a wait that names no phase still matches the same event.
    it('states the receipt phase after the outcome and reason of the serialized diagnostic', async () => {
        const fixture = await createReceiptTrackingFixture();
        await fixture.service.enqueueOutboxIfAbsent(roomMessage());

        await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));

        const [admission] = fixture.diagnostics.filter((event) => event.kind === 'control-admission');
        expect(JSON.stringify(admission)).toBe(
            '{"kind":"control-admission","msgId":"receipt-admitted","typeId":"al.control.receipt.v1","targetMsgId":"room-message-1","outcome":"committed","reason":"none","phase":"admitted"}'
        );
    });
});

async function readReceipt(fixture: ReceiptTrackingFixture) {
    return await fixture.outboundStores.admissionStore.readReceiptState({ originPeerId: 'self', msgId: 'room-message-1' });
}

/** The server's own ACK: it speaks for itself as the recipient and is addressed to the origin. */
function serverAck(ackedMsgId: string): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId: `server-ack-${ackedMsgId}`, senderId: 'server', ts: Date.now() },
        {
            ackedMsgId,
            fromPeerId: 'server',
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId: 'server',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

interface VolatileRoomSend {
    readonly fixture: ReceiptTrackingFixture;
    readonly message: ALMessage;
}

/** A volatile receiver room send on the WS client, whose server has stated the admitted audience. */
async function sendVolatileRoomMessage(): Promise<VolatileRoomSend> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const fixture = await createReceiptTrackingFixture({
        serverPeerId: 'server',
        outboundVolatileStores: createVolatileALOutboundRuntimeStores(
            { decodePrepared: decodeALOutboundTransportMessage },
            undefined
        )
    });
    const message: ALMessage = { ...roomMessage(), qos: { durability: { algo: 'volatile' } } };
    expect((await fixture.service.enqueueOutboxIfAbsent(message)).verdict.kind).toBe('admitted');
    await fixture.service.acceptIncomingMessage(receiptMessage('admitted', []));
    // The receipt row lives in the memory pair, never in the durable one.
    expect(await readReceipt(fixture)).toBeUndefined();
    return { fixture, message };
}

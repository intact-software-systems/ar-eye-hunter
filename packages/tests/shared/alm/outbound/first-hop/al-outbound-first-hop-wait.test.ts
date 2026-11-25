import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALRoute,
    newALUnicastMessage,
    type ALAckMode,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs, type ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundPreparedSendResult,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundFirstHopWaitSnapshot } from '@shared/alm/outbound/first-hop/compute-al-outbound-first-hop-wait.ts';
import { toALOutboundMessageEndBundle } from '@shared/alm/outbound/message-end/to-al-outbound-message-end-bundle.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundFirstHopTimeoutEffectId
} from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import '../../../../setup-browser-indexeddb.ts';
import { ORIGIN_ROOM } from '../../../multicast/rtc-origin-overlay-fixture.ts';
import {
    claimOutboundTestWork,
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createServerReceipt,
    createWsClientCarrierStores,
    createWsClientMintingPlanner,
    createWsClientSender,
    drainOutboundWorkDueNow,
    OUTBOUND_LEASE_RECOVERY_BOUND_MS,
    OUTBOUND_TEST_SEND_PLANNER,
    peekOutboundWorkReadyAt,
    trackOutboundTestAcks,
    type WsClientCarrierStoreKind
} from '../../outbound-runtime-test-fixture.ts';

import { toTestALNackPayload } from '../../../../al-control-test-payloads.ts';

/** The WS client's session, and the WS server it names as its one hop, as `WsQueueBoxClientService` composes it. */
const SESSION_ID = 'origin';
const SERVER_PEER_ID = 'server';
const START_MS = Date.UTC(2026, 10, 19, 12);

type SendShape = 'room broadcast' | 'room unicast';

const STORE_KINDS: readonly WsClientCarrierStoreKind[] = ['memory', 'indexeddb'];
const SEND_SHAPES: readonly SendShape[] = ['room broadcast', 'room unicast'];

/** One frame the WS client wrote to its socket: whether the server got it is the loss's decision, not the sender's. */
interface WrittenFrame {
    readonly msgId: string;
    readonly phase: string;
}

interface FirstHopFixture {
    readonly ws: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    readonly stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly written: WrittenFrame[];
    readonly settlements: ALDeliverySettlement[];
    /** Lets a transport that answered `not-ready` write from now on. */
    releaseTransport(): void;
    /** From now on every re-plan of a send is refused for good, as a revoked publish grant refuses it. */
    revokePublishGrant(): void;
}

interface FirstHopFixtureOptions {
    readonly transport?: 'not-ready';
}

interface DrainedRuntime<TPrepared> {
    readonly runtime: object;
    readonly stores: ALOutboundRuntimeStores<TPrepared>;
}

describe('a WS client\'s receipted send that waits on its first hop', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(STORE_KINDS.flatMap((store) => SEND_SHAPES.map((shape) => [store, shape] as const)))(
        'on %s, writes a %s again after each silent receipt timeout, then ends it receipt-exhausted',
        async (store, shape) => {
            const fixture = createFirstHopFixture(store);
            const only = await sendOne(fixture, shape, 'receiver');
            expect(await readWorkReadyAt(fixture)).toBe(START_MS + 2_000);
            for (const resend of [1, 2, 3]) {
                await advance(fixture, 2_000);
                expect(fixture.written).toHaveLength(1 + resend);
            }
            const attemptIds = fixture.settlements.flatMap((fact) => fact.kind === 'attempt-started' ? [fact.attemptId] : []);
            expect(new Set(attemptIds).size).toBe(4);
            await advance(fixture, 2_000);
            expect(fixture.written).toHaveLength(4);
            expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([
                expect.objectContaining({
                    msgId: only.id.msgId,
                    mode: 'receiver',
                    cause: 'budget',
                    detail: 'The first hop did not answer after 3 of 3 retries.'
                })
            ]);
            expect(await readWorkReadyAt(fixture)).toBeUndefined();
        }
    );

    it.each(SEND_SHAPES.flatMap((shape) => (['admitted', 'complete', 'timed-out'] as const).map((phase) => [shape, phase] as const)))(
        'for a %s, a server receipt in phase %s ends the wait and its timer in its own commit',
        async (shape, phase) => {
            const fixture = createFirstHopFixture('memory');
            const only = await sendOne(fixture, shape, 'receiver');
            expect(await fixture.ws.acceptReceipt(createServerReceipt(only, phase, ['peer-b']))).toEqual({
                kind: 'committed'
            });
            expect(await readWorkReadyAt(fixture)).toBeUndefined();
            await advance(fixture, 10_000);
            expect(fixture.written).toHaveLength(1);
            expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
        }
    );

    it.each(SEND_SHAPES)(
        'admits the receipt of a %s that arrives after a first-hop deadline like any other: the receipt row takes the message deadline and no attempts',
        async (shape) => {
            const fixture = createFirstHopFixture('memory');
            const only = await sendOne(fixture, shape, 'receiver');
            await advance(fixture, 2_500);
            expect(fixture.written).toHaveLength(2);
            expect(await fixture.ws.acceptReceipt(createServerReceipt(only, 'admitted', ['peer-b']))).toEqual({
                kind: 'committed'
            });
            expect(
                await fixture.stores.admissionStore.readPendingAck({ originPeerId: SESSION_ID, msgId: only.id.msgId })
            ).toMatchObject({ attempts: 0, deadlineAtMs: resolveALMessageExpireAtMs(only), expectedPeerIds: ['peer-b'] });
            await advance(fixture, 10_000);
            expect(fixture.written).toHaveLength(2);
        }
    );

    it.each(SEND_SHAPES)('charges a %s no attempt while its frame could not be written', async (shape) => {
        const fixture = createFirstHopFixture('memory', { transport: 'not-ready' });
        await sendOne(fixture, shape, 'receiver');
        await advance(fixture, 7_000);
        expect(fixture.written).toEqual([]);
        expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
        fixture.releaseTransport();
        await advance(fixture, 1_000);
        expect(fixture.written).toHaveLength(1);
        for (const resend of [1, 2, 3]) {
            await advance(fixture, 2_000);
            expect(fixture.written).toHaveLength(1 + resend);
        }
    });

    it.each(SEND_SHAPES)('a %s whose retry policy is none holds no wait', async (shape) => {
        const fixture = createFirstHopFixture('memory');
        await sendOne(fixture, shape, 'receiver', { retry: { algo: 'none' } });
        await expectNoWait(fixture);
    });

    it.each(SEND_SHAPES)('a %s with ack none holds no wait', async (shape) => {
        const fixture = createFirstHopFixture('memory');
        await sendOne(fixture, shape, 'none');
        await expectNoWait(fixture);
    });

    it.each([
        ['a hop unicast to a session', () => toSessionUnicast('none', { ack: { algo: 'hop' } })],
        ['a receiver unicast to the server', toServerUnicast]
    ])('%s keeps the receipt timer it has and holds no wait', async (_name, toMessage) => {
        const fixture = createFirstHopFixture('memory');
        const only = await admitAndDrain(fixture, toMessage());
        const pending = await fixture.stores.admissionStore.readPendingAck({
            originPeerId: SESSION_ID,
            msgId: only.id.msgId
        });
        expect(pending).toMatchObject({ expectedPeerIds: [SERVER_PEER_ID] });
        expect(await readWorkReadyAt(fixture)).toBe(START_MS + 2_000);
        expect(await readWorkStatus(fixture.stores, toALOutboundAckTimeoutEffectId(pending!))).toBe(EntityStatus.NEW);
        expect(
            await readWorkStatus(
                fixture.stores,
                toALOutboundFirstHopTimeoutEffectId({ msgId: only.id.msgId, attempts: 0, deadlineAtMs: START_MS + 2_000 })
            )
        ).toBeUndefined();
    });

    it('a composition without the plan field holds no wait', async () => {
        const stores = createDefaultOutboundTestStores();
        const written: string[] = [];
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            hopPeerIds: [SERVER_PEER_ID],
            settlements: (fact) => settlements.push(fact),
            planOutgoingMessage: (msg, authority) => ({
                ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
                ackTracking: { ...trackOutboundTestAcks([]), mode: 'receiver' }
            }),
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                written.push(lifecycle.canonicalMessage.id.msgId);
                return { status: 'sent', submissionAttempted: true };
            }
        });
        expect((await runtime.enqueueIfAbsent(toRoomBroadcast('receiver'))).verdict.kind).toBe('admitted');
        const drained = { runtime, stores };
        await advanceDrained(drained, 0);
        expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeUndefined();
        await advanceDrained(drained, 10_000);
        expect(written).toHaveLength(1);
        expect(settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
    });

    it('a timer a batch claimed before the receipt finds the wait ended', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        vi.setSystemTime(START_MS + 2_000);
        const [claim] = await claimOutboundTestWork(fixture.stores, 10);
        expect(claim?.payload).toEqual({ kind: 'first-hop-timeout', msgId: only.id.msgId });
        expect(await fixture.ws.acceptReceipt(createServerReceipt(only, 'admitted', ['peer-b']))).toEqual({
            kind: 'committed'
        });
        expect(await readWorkStatus(fixture.stores, claim!.effectId)).toBe(EntityStatus.RESERVED);

        await advance(fixture, OUTBOUND_LEASE_RECOVERY_BOUND_MS);

        expect(fixture.written).toHaveLength(1);
        expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
        expect(await readWorkStatus(fixture.stores, claim!.effectId)).toBe(EntityStatus.COMPLETED);
        expect(await readWorkReadyAt(fixture)).toBeUndefined();
    });

    it.each(SEND_SHAPES)('a terminal NACK from the server ends the wait of a %s', async (shape) => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, shape, 'receiver');
        expect(await fixture.ws.acceptControlMessage(toServerRefusal(only), 'trusted-server')).toEqual({
            kind: 'committed'
        });
        expect(await readWorkReadyAt(fixture)).toBeUndefined();
        await advance(fixture, 10_000);
        expect(fixture.written).toHaveLength(1);
        expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
    });

    it('a re-plan refused for good at a first-hop deadline ends the wait with the refusal alone', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        fixture.revokePublishGrant();

        await advance(fixture, 2_000);
        await advance(fixture, 10_000);

        expect(fixture.written).toHaveLength(1);
        expect(fixture.settlements.filter((fact) => fact.kind === 'admission' || fact.kind === 'receipt-exhausted'))
            .toEqual([
                expect.objectContaining({
                    kind: 'admission',
                    msgId: only.id.msgId,
                    verdict: expect.objectContaining({ kind: 'refused', reason: 'no-publish-grant' })
                })
            ]);
        expect(await readWorkReadyAt(fixture)).toBeUndefined();
        expect(await readFirstHopWait(fixture, only)).toBeUndefined();
    });

    it('writes no frame when the commit of the next attempt does not land', async () => {
        const fixture = createFirstHopFixture('memory');
        await sendOne(fixture, 'room broadcast', 'receiver');
        const commitBundle = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementation(async (bundle, observation) =>
            bundle.mutations.some((mutation) => mutation.kind === 'set-first-hop-wait')
                ? 'expired'
                : await commitBundle(bundle, observation)
        );

        await advance(fixture, 2_000);

        expect(fixture.written).toHaveLength(1);
    });

    it('a terminal NACK that refuses no relay hop still ends the wait', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        expect(await fixture.ws.acceptControlMessage(toServerRefusal(only, 'expired'), 'trusted-server')).toEqual({
            kind: 'committed'
        });
        expect(await readWorkReadyAt(fixture)).toBeUndefined();
        await advance(fixture, 10_000);
        expect(fixture.written).toHaveLength(1);
        expect(await readFirstHopWait(fixture, only)).toBeUndefined();
    });

    it('a repeated admitted after the wait ended is refused and writes nothing', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        const receipt = createServerReceipt(only, 'admitted', ['peer-b']);
        expect(await fixture.ws.acceptReceipt(receipt)).toEqual({ kind: 'committed' });

        expect(await fixture.ws.acceptReceipt(receipt)).toEqual({
            kind: 'rejected',
            reason: expect.stringContaining('moves no receipt')
        });
        await advance(fixture, 10_000);
        expect(fixture.written).toHaveLength(1);
    });
});

describe('a WS client\'s receipted unicast when the server answers not-yet-in-sync', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('is a room unicast, so the answer ends its wait as a room broadcast\'s does: one frame, no retry row, nothing stated, the row not ended', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room unicast', 'receiver');

        expect(await fixture.ws.acceptControlMessage(toServerNotYetInSync(only), 'trusted-server')).toEqual({ kind: 'committed' });

        expect(await readFirstHopWait(fixture, only)).toBeUndefined();
        expect(
            await readWorkStatus(
                fixture.stores,
                toALOutboundFirstHopTimeoutEffectId({ msgId: only.id.msgId, attempts: 0, deadlineAtMs: START_MS + 2_000 })
            )
        ).toBe(EntityStatus.COMPLETED);
        expect(await readWorkReadyAt(fixture)).toBeUndefined();
        for (let elapsedMs = 0; elapsedMs <= 30_000; elapsedMs += 1_000) {
            await advance(fixture, 1_000);
        }
        expect(fixture.written).toHaveLength(1);
        expect(fixture.settlements.filter((fact) => fact.kind === 'not-yet-in-sync-exhausted')).toEqual([]);
        expect(toTerminalKinds(fixture)).toEqual([]);
        expect(await readReceiptRow(fixture, only)).toBeUndefined();
        expect((await fixture.stores.admissionStore.readStoredMessage(only.id.msgId))?.ended).toBe(false);
    });

    it('has no form outside a room: a receiver unicast that names no room is refused at admission', async () => {
        const fixture = createFirstHopFixture('memory');
        const result = await fixture.ws.enqueueIfAbsent(
            newALUnicastMessage({
                createdAtEpochMs: Date.now(),
                senderId: SESSION_ID,
                route: newALRoute('command', 'context', 'to-peer-b'),
                toPeerId: 'peer-b',
                typeId: 'command.v1',
                resource: {},
                options: {
                    ttlMs: 30_000,
                    reliability: 'at-least-once',
                    ack: 'receiver'
                }
            })
        );

        expect(result.verdict).toMatchObject({ kind: 'refused' });
        expect(fixture.written).toEqual([]);
    });
});

describe('a WS client\'s first-hop wait once its message has ended', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(['admitted', 'complete', 'timed-out'] as const)(
        'a server receipt in phase %s that arrives after the first hop gave up rebuilds no receipt row and states nothing',
        async (phase) => {
            const fixture = createFirstHopFixture('memory');
            const only = await sendOne(fixture, 'room broadcast', 'receiver');
            for (let timeout = 0; timeout < 4; timeout += 1) {
                await advance(fixture, 2_000);
            }
            expect(toTerminalKinds(fixture)).toEqual(['receipt-exhausted']);

            expect(await fixture.ws.acceptReceipt(createServerReceipt(only, phase, ['peer-b']))).toEqual({
                kind: 'rejected',
                reason: expect.stringContaining('has ended')
            });
            expect(await readReceiptRow(fixture, only)).toBeUndefined();
            expect(toTerminalKinds(fixture)).toEqual(['receipt-exhausted']);
            await advance(fixture, 10_000);
            expect(fixture.written).toHaveLength(4);
        }
    );

    it.each(['admitted', 'complete', 'timed-out'] as const)(
        'a server receipt in phase %s that arrives after a re-plan refused for good at a first-hop deadline rebuilds no receipt row and states nothing',
        async (phase) => {
            const fixture = createFirstHopFixture('memory');
            const only = await sendOne(fixture, 'room broadcast', 'receiver');
            fixture.revokePublishGrant();
            await advance(fixture, 2_000);
            expect(toTerminalKinds(fixture)).toEqual(['admission']);

            expect(await fixture.ws.acceptReceipt(createServerReceipt(only, phase, ['peer-b']))).toEqual({
                kind: 'rejected',
                reason: expect.stringContaining('has ended')
            });
            expect(await readReceiptRow(fixture, only)).toBeUndefined();
            expect(toTerminalKinds(fixture)).toEqual(['admission']);
            await advance(fixture, 10_000);
            expect(fixture.written).toHaveLength(1);
        }
    );

    it('a terminal receipt that lands between a resend\'s two commits stops the resend\'s frame', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        admitBetweenResendCommits(
            fixture,
            createServerReceipt(only, 'complete', ['peer-b'], {
                controlMsgId: `receipt-complete-${only.id.msgId}`,
                confirmedRecipientPeerIds: ['peer-b']
            })
        );

        await advance(fixture, 2_000);

        expect(fixture.written).toHaveLength(1);
        expect(fixture.settlements.filter((fact) => fact.kind === 'acknowledgement' || fact.kind === 'receipt-exhausted'))
            .toEqual([expect.objectContaining({ kind: 'acknowledgement', msgId: only.id.msgId, complete: true })]);
    });

    it('an admitted receipt between a resend\'s two commits still lets that one frame out: admitted is not terminal', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        admitBetweenResendCommits(fixture, createServerReceipt(only, 'admitted', ['peer-b']));

        await advance(fixture, 2_000);

        expect(fixture.written).toHaveLength(2);
        expect(await readFirstHopWait(fixture, only)).toBeUndefined();
        expect(await readWorkReadyAt(fixture)).toBeUndefined();
        await advance(fixture, 10_000);
        expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
    });

    it('a wait whose message ended in a commit that did not read it is deleted at its deadline and states nothing', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        const read = await fixture.stores.admissionStore.readRepairMessage(only.id.msgId, createWsClientMintingPlanner(SESSION_ID));
        expect(
            await fixture.stores.admissionStore.commitBundle(toALOutboundMessageEndBundle({
                senderId: only.id.senderId,
                msgId: only.id.msgId,
                stored: read.storedMessage,
                expectedVersion: read.clientRecord?.version,
                messageVersion: read.messageVersion,
                openReceipt: read.pendingAck,
                firstHopWait: undefined
            }))
        ).toBe('committed');
        expect(await readFirstHopWait(fixture, only)).toBeDefined();

        await advance(fixture, 2_000);

        expect(await readFirstHopWait(fixture, only)).toBeUndefined();
        expect(fixture.written).toHaveLength(1);
        expect(toTerminalKinds(fixture)).toEqual([]);
    });
});

describe('a WS client\'s receipt row when the server answers admitted twice', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('a second admitted that counts no one more changes no state, states nothing and writes no frame', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        await advance(fixture, 2_000);
        expect(fixture.written).toHaveLength(2);
        expect(await fixture.ws.acceptReceipt(createServerReceipt(only, 'admitted', ['peer-b', 'peer-c']))).toEqual({
            kind: 'committed'
        });
        const first = await readReceiptRow(fixture, only);
        const factsBefore = fixture.settlements.length;
        vi.setSystemTime(Date.now() + 300);

        const second = createServerReceipt(only, 'admitted', ['peer-b', 'peer-c'], {
            controlMsgId: `receipt-admitted-again-${only.id.msgId}`,
            confirmedRecipientPeerIds: []
        });
        expect(await fixture.ws.acceptReceipt(second)).toEqual({
            kind: 'rejected',
            reason: 'AL receipt moves no receipt of its message'
        });

        expect(first).toMatchObject({
            expectedPeerIds: ['peer-b', 'peer-c'],
            ackedPeerIds: [],
            attempts: 0,
            deadlineAtMs: resolveALMessageExpireAtMs(only)
        });
        expect(await readReceiptRow(fixture, only)).toEqual(first);
        expect(await readFirstHopWait(fixture, only)).toBeUndefined();
        expect(await readWorkReadyAt(fixture)).toBeUndefined();
        await advance(fixture, 10_000);
        expect(fixture.written).toHaveLength(2);
        expect(fixture.settlements.slice(factsBefore)).toEqual([]);
    });

    it('a second admitted that counts a recipient moves the row to it, keeps its deadline and attempts, and states one partial fact', async () => {
        const fixture = createFirstHopFixture('memory');
        const only = await sendOne(fixture, 'room broadcast', 'receiver');
        expect(await fixture.ws.acceptReceipt(createServerReceipt(only, 'admitted', ['peer-b', 'peer-c']))).toEqual({
            kind: 'committed'
        });
        const first = await readReceiptRow(fixture, only);
        const factsBefore = fixture.settlements.length;

        const second = createServerReceipt(only, 'admitted', ['peer-b', 'peer-c'], {
            controlMsgId: `receipt-admitted-again-${only.id.msgId}`,
            confirmedRecipientPeerIds: ['peer-b']
        });
        expect(await fixture.ws.acceptReceipt(second)).toEqual({ kind: 'committed' });

        expect(await readReceiptRow(fixture, only)).toEqual({ ...first, ackedPeerIds: ['peer-b'] });
        expect(fixture.settlements.slice(factsBefore)).toEqual([
            expect.objectContaining({
                kind: 'acknowledgement',
                msgId: only.id.msgId,
                confirmedRecipientPeerIds: ['peer-b'],
                unconfirmedRecipientPeerIds: ['peer-c'],
                complete: false
            })
        ]);
        expect(await readFirstHopWait(fixture, only)).toBeUndefined();
        await advance(fixture, 10_000);
        expect(fixture.written).toHaveLength(1);
        expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
    });
});

/** The kinds of the facts stated that end the message: a terminal receipt, an end of its first hop, a settled refusal. */
function toTerminalKinds(fixture: FirstHopFixture): readonly string[] {
    return fixture.settlements.flatMap((fact) =>
        fact.kind === 'receipt-exhausted' || fact.kind === 'relay-rejected' ||
            (fact.kind === 'admission' && fact.verdict.kind === 'refused') ||
            (fact.kind === 'acknowledgement' && fact.complete)
            ? [fact.kind]
            : []
    );
}

/** Lands `receipt` right after the commit that holds a resend's next wait, before the resend's dispatch commits. */
function admitBetweenResendCommits(fixture: FirstHopFixture, receipt: ALMessage): void {
    const commitBundle = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
    vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementation(async (bundle, observation) => {
        const status = await commitBundle(bundle, observation);
        if (status === 'committed' && bundle.mutations.some((mutation) => mutation.kind === 'set-first-hop-wait')) {
            expect(await fixture.ws.acceptReceipt(receipt)).toEqual({ kind: 'committed' });
        }
        return status;
    });
}

function createFirstHopFixture(store: WsClientCarrierStoreKind, options: FirstHopFixtureOptions = {}): FirstHopFixture {
    const written: WrittenFrame[] = [];
    const settlements: ALDeliverySettlement[] = [];
    let transportReady = options.transport !== 'not-ready';
    let publishGranted = true;
    const stores = createWsClientCarrierStores(SESSION_ID, store);
    const plan = createWsClientMintingPlanner(SESSION_ID);
    const ws = createWsClientSender({
        stores,
        planOutgoingMessage: (msg, authority) =>
            publishGranted ? plan(msg, authority) : {
                ...plan(msg, authority),
                dropReason: 'The sender holds no publish grant any more',
                dropReasonCode: 'no-publish-grant',
                preparedMessages: []
            },
        settlements: (fact) => settlements.push(fact),
        // A dropped frame leaves the socket as a sent one does: the loss is in transit, after the write.
        sendPreparedMessage: async (_prepared, phase, lifecycle): Promise<ALOutboundPreparedSendResult> => {
            if (!transportReady) {
                return { status: 'not-ready', submissionAttempted: false, retryAfterMs: 500 };
            }
            written.push({ msgId: lifecycle.canonicalMessage.id.msgId, phase });
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return {
        ws,
        stores,
        written,
        settlements,
        releaseTransport: () => {
            transportReady = true;
        },
        revokePublishGrant: () => {
            publishGranted = false;
        }
    };
}

async function sendOne(
    fixture: FirstHopFixture,
    shape: SendShape,
    ack: ALAckMode,
    qos?: ALQosPolicyRequest
): Promise<ALMessage> {
    return await admitAndDrain(
        fixture,
        shape === 'room broadcast' ? toRoomBroadcast(ack, qos) : toSessionUnicast(ack, qos)
    );
}

async function admitAndDrain(fixture: FirstHopFixture, msg: ALMessage): Promise<ALMessage> {
    const result = await fixture.ws.enqueueIfAbsent(msg);
    expect(result.verdict.kind, result.reason).toBe('admitted');
    await advance(fixture, 0);
    return result.message;
}

/** One frame, no pending work, and still one frame and no settlement of an end ten seconds on. */
async function expectNoWait(fixture: FirstHopFixture): Promise<void> {
    expect(fixture.written).toHaveLength(1);
    expect(await readWorkReadyAt(fixture)).toBeUndefined();
    await advance(fixture, 10_000);
    expect(fixture.written).toHaveLength(1);
    expect(fixture.settlements.filter((fact) => fact.kind === 'receipt-exhausted')).toEqual([]);
}

async function advance(fixture: FirstHopFixture, ms: number): Promise<void> {
    await advanceDrained({ runtime: fixture.ws, stores: fixture.stores }, ms);
}

/** Moves the clock, then runs the owner's batches until it advertises nothing due now, as the engine's wakes would. */
async function advanceDrained<TPrepared>(drained: DrainedRuntime<TPrepared>, ms: number): Promise<void> {
    vi.setSystemTime(Date.now() + ms);
    await drainOutboundWorkDueNow(drained.runtime, drained.stores);
}

async function readWorkReadyAt(fixture: FirstHopFixture): Promise<number | undefined> {
    return await peekOutboundWorkReadyAt(fixture.stores.workQueue, fixture.stores.admissionStore.namespace);
}

async function readWorkStatus<TPrepared>(
    stores: ALOutboundRuntimeStores<TPrepared>,
    effectId: string
): Promise<string | undefined> {
    return (await stores.admissionStore.readWork(toALOutboundWorkKey(stores.admissionStore.namespace, effectId)))
        ?.status;
}

/** The WS server refuses the send: for the unicast, an addressee outside the audience its room admitted. */
function toServerRefusal(refused: ALMessage, reason: 'unauthorized' | 'expired' = 'unauthorized'): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `refusal-${refused.id.msgId}`, ts: 1, senderId: SERVER_PEER_ID, traceId: 'trace-first-hop-wait' },
        toTestALNackPayload({
            msgId: refused.id.msgId,
            fromPeerId: SERVER_PEER_ID,
            toPeerId: SESSION_ID,
            reason
        })
    );
}

/** The WS server's `not-yet-in-sync` for a send it retains behind its room view. */
function toServerNotYetInSync(retained: ALMessage): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `not-yet-in-sync-${retained.id.msgId}`, ts: 1, senderId: SERVER_PEER_ID, traceId: 'trace-first-hop-wait' },
        toTestALNackPayload({
            msgId: retained.id.msgId,
            fromPeerId: SERVER_PEER_ID,
            toPeerId: SESSION_ID,
            reason: 'not-yet-in-sync',
            serverSnapshotVersion: 1
        })
    );
}

async function readReceiptRow(fixture: FirstHopFixture, msg: ALMessage): Promise<ALOutboundPendingAckSnapshot | undefined> {
    return await fixture.stores.admissionStore.readPendingAck({ originPeerId: SESSION_ID, msgId: msg.id.msgId });
}

async function readFirstHopWait(
    fixture: FirstHopFixture,
    msg: ALMessage
): Promise<ALOutboundFirstHopWaitSnapshot | undefined> {
    return (await fixture.stores.admissionStore.readRepairMessage(msg.id.msgId, createWsClientMintingPlanner(SESSION_ID)))
        .firstHopWait;
}

function toRoomBroadcast(ack: ALAckMode, qos?: ALQosPolicyRequest): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: SESSION_ID,
        route: newALRoute('room.stream', ORIGIN_ROOM.groupId, 'only'),
        scope: 'room',
        typeId: 'stream.message.v1',
        resource: { name: 'only' },
        options: {
            groupRef: ORIGIN_ROOM,
            ttlMs: 30_000,
            reliability: 'at-least-once',
            ack,
            ordering: { orderingKey: 'stream' },
            ...(qos === undefined ? {} : { qos })
        }
    });
}

function toSessionUnicast(ack: ALAckMode, qos?: ALQosPolicyRequest): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: SESSION_ID,
        route: newALRoute('room.command', ORIGIN_ROOM.groupId, 'to-peer-b'),
        toPeerId: 'peer-b',
        typeId: 'command.v1',
        resource: {},
        options: {
            groupRef: ORIGIN_ROOM,
            ttlMs: 30_000,
            reliability: 'at-least-once',
            ack,
            ...(qos === undefined ? {} : { qos })
        }
    });
}

function toServerUnicast(): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: SESSION_ID,
        route: newALRoute('room.command', ORIGIN_ROOM.groupId, 'to-server'),
        toPeerId: SERVER_PEER_ID,
        typeId: 'command.v1',
        resource: {},
        options: { groupRef: ORIGIN_ROOM, ttlMs: 30_000, reliability: 'at-least-once', ack: 'receiver' }
    });
}

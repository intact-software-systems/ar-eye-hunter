import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundPreparedSendResult,
    ALOutboundRepairRequest,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow
} from '../../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../../outbound-test-payload.ts';
import {
    advanceOutboundClockTo,
    createReopenableOutboundTestStores,
    readPendingOutboundWorkKinds,
    readPendingOutboundWorkPayloads,
    toOutboundTerminalFacts,
    type OutboundTimelineStoreKind,
    type ReopenableOutboundTestStores
} from '../outbound-timeline-test-fixture.ts';

import { toTestALNackPayload } from '../../../../al-control-test-payloads.ts';

const START_MS = Date.UTC(2026, 10, 20, 12);
const NAMESPACE = 'outbound-receipt-first-attempt';
const STORES: readonly OutboundTimelineStoreKind[] = ['memory', 'indexeddb'];

/** What the transport double holds `not-ready`: every copy, the receipt's retry copies alone, or nothing. */
type TransportHold = 'all' | 'retries' | 'none';

/** The transport double: it records each copy it takes, with the cause its planner named and when, after the start. */
interface HeldSendTransport {
    readonly frames: (readonly [string, number])[];
    hold: TransportHold;
}

/** One sender of one message over one pair of stores; a reload replaces the runtime, its settlements and the stores. */
interface HeldSendFixture {
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    settlements: ALDeliverySettlement[];
    readonly reopenable: ReopenableOutboundTestStores;
    readonly message: ALMessage;
    readonly transport: HeldSendTransport;
}

interface HeldSendFixtureOptions {
    readonly hold: TransportHold;
    readonly ttlMs?: number;
}

const RECEIPT_TRACKING = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: ['peer-1'],
    nextHopPeerIds: ['peer-1'],
    mode: 'receiver'
} as const;

describe('a receipt waits for its first frame', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(STORES)(
        'on %s, a receipt whose first frame is held charges nothing and queues nothing; after a reload and the release that one frame leaves, and the budget runs from the next deadline',
        async (store) => {
            const fixture = await createHeldSendFixture(store, { hold: 'all' });
            await advanceTo(fixture, 9_000);
            expect(framesOf(fixture)).toEqual([]);
            expect(terminalFactsOf(fixture)).toEqual([]);
            expect(await pendingWorkOf(fixture)).toEqual(['ack-timeout', 'send-prepared']);
            expect(await readReceiptRow(fixture)).toMatchObject({
                attempts: 0,
                deadlineAtMs: START_MS + 10_000,
                firstAttempt: await readQueuedAttempt(fixture)
            });
            expect((await fixture.stores.admissionStore.readStoredMessage(fixture.message.id.msgId))?.ended).toBe(false);

            await reload(fixture);
            fixture.transport.hold = 'none';
            await advanceTo(fixture, 9_100);
            expect(framesOf(fixture).map(([cause]) => cause)).toEqual(['first-send']);
            await advanceTo(fixture, 15_999);
            expect(framesOf(fixture).slice(1)).toEqual([['receipt-retry', 10_000], ['receipt-retry', 12_000], [
                'receipt-retry',
                14_000
            ]]);
            expect(terminalFactsOf(fixture)).toEqual([]);
            await advanceTo(fixture, 16_000);
            expect(terminalFactsOf(fixture)).toEqual([['receipt-exhausted', 'budget']]);
            expect(framesOf(fixture)).toHaveLength(4);
            expect(await pendingWorkOf(fixture)).toEqual([]);
        }
    );

    it.each(STORES)(
        'on %s, a hold lifted inside the budget hands the carrier one frame, and the first charge is the first deadline after it left',
        async (store) => {
            const fixture = await createHeldSendFixture(store, { hold: 'all' });
            await advanceTo(fixture, 3_000);
            expect(await readReceiptRow(fixture)).toMatchObject({ attempts: 0, deadlineAtMs: START_MS + 4_000 });

            fixture.transport.hold = 'none';
            await advanceTo(fixture, 9_999);
            expect(framesOf(fixture).map(([cause]) => cause)).toEqual(['first-send', 'receipt-retry', 'receipt-retry', 'receipt-retry']);
            expect(framesOf(fixture)[0]![1]).toBeLessThanOrEqual(3_100);
            expect(framesOf(fixture).slice(1).map(([, atMs]) => atMs)).toEqual([4_000, 6_000, 8_000]);
            expect(terminalFactsOf(fixture)).toEqual([]);
            await advanceTo(fixture, 10_000);
            expect(terminalFactsOf(fixture)).toEqual([['receipt-exhausted', 'budget']]);
        }
    );

    it.each(STORES)(
        'on %s, a retry held after the first frame left is charged: the receipt ends on its budget and its held retries are never sent',
        async (store) => {
            const fixture = await createHeldSendFixture(store, { hold: 'retries' });
            await advanceTo(fixture, 7_999);
            expect(framesOf(fixture).map(([cause]) => cause)).toEqual(['first-send']);
            expect(await readReceiptRow(fixture)).toMatchObject({ attempts: 3 });
            expect(terminalFactsOf(fixture)).toEqual([]);
            await advanceTo(fixture, 8_000);
            expect(terminalFactsOf(fixture)).toEqual([['receipt-exhausted', 'budget']]);

            fixture.transport.hold = 'none';
            await advanceTo(fixture, 30_000);
            expect(framesOf(fixture).map(([cause]) => cause)).toEqual(['first-send']);
            expect(await pendingWorkOf(fixture)).toEqual([]);
        }
    );

    it.each(STORES)(
        'on %s, a message whose deadline passes while its first frame is held lapses with no frame, no exhaustion and no settlement of its own',
        async (store) => {
            const fixture = await createHeldSendFixture(store, { hold: 'all', ttlMs: 5_000 });
            await advanceTo(fixture, 4_999);
            expect(await pendingWorkOf(fixture)).toEqual(['ack-timeout', 'send-prepared']);
            expect(await readReceiptRow(fixture)).toMatchObject({ attempts: 0, deadlineAtMs: START_MS + 6_000 });

            await advanceTo(fixture, 5_100);
            fixture.transport.hold = 'none';
            await advanceTo(fixture, 30_000);
            expect(framesOf(fixture)).toEqual([]);
            expect(terminalFactsOf(fixture)).toEqual([]);
            expect(await pendingWorkOf(fixture)).toEqual([]);
            // The held copy's row lapses unclaimed at the deadline, which has no settlement of its own: an observer
            // applies it when it reads (`computeALDeliveryDeadline`).
            expect(fixture.settlements.filter((settlement) => settlement.kind === 'expired')).toEqual([]);
        }
    );

    it.each(STORES)(
        'on %s, a terminal settlement from elsewhere still ends a message whose first frame is held: the held copy is never sent',
        async (store) => {
            const fixture = await createHeldSendFixture(store, { hold: 'all' });
            await advanceTo(fixture, 3_000);
            expect(await refuseForGood(fixture)).toEqual({ kind: 'committed' });
            expect(terminalFactsOf(fixture)).toEqual([['receipt-exhausted', 'hop-refused']]);

            fixture.transport.hold = 'none';
            await advanceTo(fixture, 30_000);
            expect(framesOf(fixture)).toEqual([]);
            expect(await readReceiptRow(fixture)).toBeUndefined();
            expect(await pendingWorkOf(fixture)).toEqual([]);
            expect(terminalFactsOf(fixture)).toEqual([['receipt-exhausted', 'hop-refused']]);
        }
    );

    it('a wait decided before the message ended conflicts, and decided again it re-arms nothing', async () => {
        const fixture = await createHeldSendFixture('memory', { hold: 'all' });
        const commitBundle = fixture.stores.admissionStore.commitBundle.bind(fixture.stores.admissionStore);
        let refused = false;
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockImplementation(async (bundle, observation) => {
            const keepsAttempts = bundle.mutations.some((mutation) =>
                mutation.kind === 'set-pending-ack' && mutation.snapshot.attempts === 0 &&
                mutation.snapshot.deadlineAtMs > START_MS + RECEIPT_TRACKING.timeoutMs
            );
            if (keepsAttempts && !refused) {
                refused = true;
                expect(await refuseForGood(fixture)).toEqual({ kind: 'committed' });
            }
            return await commitBundle(bundle, observation);
        });

        await advanceTo(fixture, 2_100);

        expect(refused).toBe(true);
        expect(await readReceiptRow(fixture)).toBeUndefined();
        expect(await pendingWorkOf(fixture)).not.toContain('ack-timeout');
        expect(terminalFactsOf(fixture)).toEqual([['receipt-exhausted', 'hop-refused']]);
    });

    it('a receipt row that names no first attempt is charged at every deadline', async () => {
        const fixture = await createHeldSendFixture('memory', { hold: 'all' });
        await commitReceiptRowWithoutFirstAttempt(fixture);

        await advanceTo(fixture, 2_000);

        expect(await readReceiptRow(fixture)).toMatchObject({ attempts: 1 });
        expect(await pendingWorkOf(fixture)).toEqual(['ack-timeout', 'send-prepared', 'send-prepared']);
    });
});

async function createHeldSendFixture(
    store: OutboundTimelineStoreKind,
    options: HeldSendFixtureOptions
): Promise<HeldSendFixture> {
    const reopenable = createReopenableOutboundTestStores(store, NAMESPACE);
    const transport: HeldSendTransport = { frames: [], hold: options.hold };
    const settlements: ALDeliverySettlement[] = [];
    const fixture: HeldSendFixture = {
        runtime: createFixtureRuntime(reopenable.stores, settlements, transport),
        stores: reopenable.stores,
        settlements,
        reopenable,
        message: createOutboundMessage('held-original', { ttlMs: options.ttlMs ?? 60_000 }),
        transport
    };
    await enqueueOutboundOrThrow(fixture.runtime, fixture.message);
    return fixture;
}

function createFixtureRuntime(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    settlements: ALDeliverySettlement[],
    transport: HeldSendTransport
): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores,
        carrier: 'rtc',
        planOutgoingMessage: SEND_PLANNER,
        planRepairMessage,
        settlements: (settlement) => settlements.push(settlement),
        sendPreparedMessage: async (prepared): Promise<ALOutboundPreparedSendResult> => {
            if (transport.hold === 'all' || (transport.hold === 'retries' && prepared.kind === 'repair')) {
                return { status: 'not-ready', submissionAttempted: false, retryAfterMs: 50 };
            }
            transport.frames.push([prepared.cause!, Date.now() - START_MS]);
            return { status: 'sent', submissionAttempted: true };
        }
    });
}

const SEND_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    lane: 'durable',
    preparedMessages: [{ kind: 'send', msgId: msg.id.msgId, cause: 'first-send' }],
    ackTracking: RECEIPT_TRACKING,
    repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 4 }
});

/** As the RTC planner: a repair copy carries the receipt's tracking, whose receiver mode replaces the expected set. */
async function planRepairMessage(
    msg: ALMessage,
    request: ALOutboundRepairRequest
): Promise<ALOutboundDispatchPlan<OutboundTestPayload>> {
    return {
        msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId, cause: 'receipt-retry' }],
        ackTracking: { ...RECEIPT_TRACKING, expectedPeerIdsUpdate: 'replace' },
        repairTracking: request.repair
    };
}

async function reload(fixture: HeldSendFixture): Promise<void> {
    await fixture.runtime.dispose();
    fixture.stores = fixture.reopenable.reopen();
    fixture.settlements = [];
    fixture.runtime = createFixtureRuntime(fixture.stores, fixture.settlements, fixture.transport);
}

async function advanceTo(fixture: HeldSendFixture, ms: number): Promise<void> {
    await advanceOutboundClockTo(fixture, START_MS + ms);
}

function terminalFactsOf(fixture: HeldSendFixture): readonly (readonly [string, string])[] {
    return toOutboundTerminalFacts(fixture.settlements, fixture.message.id.msgId);
}

async function pendingWorkOf(fixture: HeldSendFixture): Promise<readonly string[]> {
    return await readPendingOutboundWorkKinds(fixture.stores, fixture.message.id.msgId);
}

function framesOf(fixture: HeldSendFixture): readonly (readonly [string, number])[] {
    return fixture.transport.frames;
}

async function readReceiptRow(fixture: HeldSendFixture): Promise<ALOutboundPendingAckSnapshot | undefined> {
    const { senderId, msgId } = fixture.message.id;
    return await fixture.stores.admissionStore.readReceiptState({ originPeerId: senderId, msgId });
}

/** The attempt of the one send still queued for the carrier, as its work row names it. */
async function readQueuedAttempt(fixture: HeldSendFixture): Promise<{ readonly attemptIdentity: string; readonly phase: string; }> {
    const sends = (await readPendingOutboundWorkPayloads(fixture.stores, fixture.message.id.msgId))
        .flatMap((payload) => payload.kind === 'send-prepared' ? [payload] : []);
    expect(sends).toHaveLength(1);
    return { attemptIdentity: sends[0]!.attemptIdentity, phase: sends[0]!.phase };
}

/** An `expired` NACK from the one expected receiver: a refusal for good, which ends the message. */
async function refuseForGood(fixture: HeldSendFixture): Promise<ALOutboundControlAdmissionResult> {
    const { msgId } = fixture.message.id;
    return await fixture.runtime.acceptControlMessage(
        newALNackControlMessage(
            { v: 4, msgId: `peer-1-nack:${msgId}`, senderId: 'peer-1', ts: Date.now(), traceId: 'trace-receipt-first-attempt' },
            toTestALNackPayload({
                msgId,
                fromPeerId: 'peer-1',
                logicalRecipientPeerId: 'peer-1',
                toPeerId: 'self',
                reason: 'expired',
                observedAtEpochMs: Date.now()
            })
        ),
        'peer'
    );
}

/** Commits the receipt row again without the attempt it names, fenced on the sender version a repair read sees. */
async function commitReceiptRowWithoutFirstAttempt(fixture: HeldSendFixture): Promise<void> {
    const { admissionStore } = fixture.stores;
    const read = await admissionStore.readRepairMessage(fixture.message.id.msgId, SEND_PLANNER);
    const { firstAttempt: _named, ...unnamed } = read.pendingAck!;
    expect(
        await admissionStore.commitBundle({
            senderId: fixture.message.id.senderId,
            expectedVersion: read.clientRecord?.version,
            mutations: [{
                kind: 'set-pending-ack',
                originPeerId: fixture.message.id.senderId,
                snapshot: unnamed,
                expireAtTimestamp: read.storedMessage!.reference.expiresAtMs
            }],
            durableEffects: []
        })
    ).toBe('committed');
}

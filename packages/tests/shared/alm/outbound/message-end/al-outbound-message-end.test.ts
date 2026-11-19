import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot
} from '@shared/alm/al-runtime-state-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundPlanner,
    ALOutboundRepairReadDto
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundPreparedSendResult,
    ALOutboundRepairRequest,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isPendingALOutboundWork } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { toALOutboundRepairRequesterKey } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createIndexedDbOutboundTestStores,
    createOutboundMessage,
    createServerReceipt,
    drainOutboundWorkDueNow,
    enqueueOutboundOrThrow
} from '../../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../../outbound-test-payload.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../../al-control-test-payloads.ts';

const START_MS = Date.UTC(2026, 10, 19, 12);
const STEP_MS = 25;
const RECEIVERS = ['peer-1', 'peer-2'];
const NAMESPACE = 'outbound-message-end';

type StoreKind = 'memory' | 'indexeddb';
const STORES: readonly StoreKind[] = ['memory', 'indexeddb'];

/** A pair whose stores a second runtime can open again, as a reload does. */
interface ReopenableStores {
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    reopen(): ALOutboundRuntimeStores<OutboundTestPayload>;
}

/** The transport double: it records every copy it takes, by sequence, with the cause its planner named. */
interface FixtureTransport {
    readonly frames: { readonly seq: string; readonly cause: string; }[];
    /** While true, it answers `not-ready` for every repair copy. */
    holdRepairs: boolean;
}

/** A sender over one pair of stores; a reload replaces the runtime, its settlements list and, on IndexedDB, the stores. */
interface EndedMessageFixture {
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    settlements: ALDeliverySettlement[];
    readonly reopenable: ReopenableStores;
    readonly messages: readonly ALMessage[];
    readonly transport: FixtureTransport;
    readonly maxRepairs: number;
}

interface EndedMessageFixtureOptions {
    readonly maxRepairs: number;
    readonly holdRepairs?: boolean;
    /** The sequences both receivers acknowledge; 1, 3, 4 and 5 unless stated. */
    readonly acknowledgedSeqs?: readonly number[];
}

describe('a terminal settlement ends its message', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(STORES)('on %s, repair-exhausted ends the message: no frame, no timer and no second fact follow it', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 1 });
        const second = fixture.messages[1]!;
        await exhaustSeqTwo(fixture);
        const settledFrames = framesOf(fixture, 2);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
        expect(await fixture.stores.admissionStore.readReceiptState({ originPeerId: second.id.senderId, msgId: second.id.msgId })).toBeUndefined();
        expect((await readRepairRead(fixture, second)).firstHopWait).toBeUndefined();
        // The timers of the deadlines earlier dispatches moved; the end commit ended the receipt's current timer.
        expect(await pendingWorkOf(fixture, 2)).toEqual(['ack-timeout', 'ack-timeout']);
        expect((await fixture.stores.admissionStore.readStoredMessage(second.id.msgId))?.ended).toBe(true);
        await advanceTo(fixture, 2_100);
        expect(await pendingWorkOf(fixture, 2)).toEqual([]);
        expect(framesOf(fixture, 2)).toEqual(settledFrames);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
        for (
            const [atMs, peer, number] of [[1_425, 'peer-1', 2], [3_825, 'peer-2', 3], [3_950, 'peer-1', 3], [8_825, 'peer-2', 4], [9_150, 'peer-1', 4], [
                20_000,
                'peer-1',
                5
            ]] as const
        ) {
            await advanceTo(fixture, atMs);
            expect(await requestSeqTwo(fixture, peer, number)).toEqual({ kind: 'committed' });
        }
        await advanceTo(fixture, 30_000);
        expect(framesOf(fixture, 2)).toEqual(['first-send', 'gap-repair(peer-1#1)', 'gap-repair(peer-2#1)']);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
        expect(await readRepairAttempt(fixture, second)).toBeUndefined();
        expect(await pendingWorkOf(fixture, 2)).toEqual([]);
        expect(terminalFactsOf(fixture, 3)).toEqual([['acknowledgement', 'complete']]);
    });

    it.each(STORES)('on %s, at the default budget a renewal landing after the receipt ended is served nothing and opens no second receipt', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 4 });
        const second = fixture.messages[1]!;
        for (const [atMs, number] of [[50, 1], [1_550, 2], [4_550, 3]] as const) {
            await advanceTo(fixture, atMs);
            await requestSeqTwo(fixture, 'peer-1', number);
        }
        while (terminalFactsOf(fixture, 2).length === 0 && Date.now() - START_MS < 30_000) {
            await advanceTo(fixture, Date.now() - START_MS + STEP_MS);
        }
        expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
        await advanceTo(fixture, Date.now() - START_MS + 100);
        expect(await requestSeqTwo(fixture, 'peer-1', 4)).toEqual({ kind: 'committed' });
        await advanceTo(fixture, 30_000);
        expect(framesOf(fixture, 2)).toEqual([
            'first-send',
            'gap-repair(peer-1#1)',
            'gap-repair(peer-1#2)',
            'receipt-retry',
            'gap-repair(peer-1#3)',
            'receipt-retry',
            'receipt-retry'
        ]);
        expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
        expect(await fixture.stores.admissionStore.readReceiptState({ originPeerId: second.id.senderId, msgId: second.id.msgId })).toBeUndefined();
        expect(await pendingWorkOf(fixture, 2)).toEqual([]);
        expect(await readRepairAttempt(fixture, second)).toBeUndefined();
    });

    it.each(STORES)('on %s, a reload between the settlement and a late request states nothing twice', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 1 });
        await exhaustSeqTwo(fixture);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
        await reload(fixture);
        for (const [atMs, number] of [[3_950, 3], [20_000, 5]] as const) {
            await advanceTo(fixture, atMs);
            expect(await requestSeqTwo(fixture, 'peer-1', number)).toEqual({ kind: 'committed' });
        }
        await advanceTo(fixture, 30_000);
        expect(fixture.settlements.filter((settlement) => settlement.msgId === fixture.messages[1]!.id.msgId)).toEqual([]);
        expect(framesOf(fixture, 2)).toEqual(['first-send', 'gap-repair(peer-1#1)', 'gap-repair(peer-2#1)']);
    });

    it.each(STORES)('on %s, a prepared send that was waiting when its message ended writes no frame', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 1, holdRepairs: true });
        await exhaustSeqTwo(fixture);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
        fixture.transport.holdRepairs = false;
        await advanceTo(fixture, 30_000);
        expect(framesOf(fixture, 2)).toEqual(['first-send']);
    });

    it.each(STORES)('on %s, a receipt\'s own exhaustion ends the message', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 4 });
        const second = fixture.messages[1]!;
        await advanceTo(fixture, 9_000);
        expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
        const framesBefore = framesOf(fixture, 2);
        expect(await requestSeqTwo(fixture, 'peer-1', 1)).toEqual({ kind: 'committed' });
        await advanceTo(fixture, 30_000);
        expect(framesOf(fixture, 2)).toEqual(framesBefore);
        expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
        expect(await fixture.stores.admissionStore.readReceiptState({ originPeerId: second.id.senderId, msgId: second.id.msgId })).toBeUndefined();
        expect(await pendingWorkOf(fixture, 2)).toEqual([]);
    });

    it.each(STORES)('on %s, a timed-out server receipt ends the message: its receipt timer rewrites nothing and states nothing after it', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 4 });
        const second = fixture.messages[1]!;
        const receipt = { originPeerId: second.id.senderId, msgId: second.id.msgId };
        await advanceTo(fixture, 50);
        const timedOut = createServerReceipt(second, 'timed-out', RECEIVERS, {
            controlMsgId: `receipt-timed-out-${second.id.msgId}`,
            confirmedRecipientPeerIds: ['peer-1']
        });
        expect(await fixture.runtime.acceptReceipt(timedOut)).toEqual({ kind: 'committed' });
        const kept = await fixture.stores.admissionStore.readReceiptState(receipt);

        await advanceTo(fixture, 30_000);

        expect(framesOf(fixture, 2)).toEqual(['first-send']);
        expect(await fixture.stores.admissionStore.readReceiptState(receipt)).toEqual(kept);
        expect(await pendingWorkOf(fixture, 2)).toEqual([]);
        expect(
            fixture.settlements.filter((settlement) =>
                settlement.msgId === second.id.msgId &&
                (settlement.kind === 'acknowledgement' || settlement.kind === 'receipt-exhausted')
            ).map((settlement) => settlement.kind)
        ).toEqual(['acknowledgement']);
    });

    it.each(STORES)(
        'on %s, a superseded receipt timer that runs in time re-writes the timer the terminal receipt completed, which stays completed',
        async (store) => {
            const fixture = await createEndedMessageFixture(store, { maxRepairs: 4 });
            const { second, kept } = await keepTimedOutReceiptOverSupersededTimers(fixture);

            await advanceTo(fixture, 30_000);

            expect(framesOf(fixture, 2)).toEqual(['first-send', 'gap-repair(peer-1#1)', 'gap-repair(peer-2#1)']);
            expect(await readReceiptRow(fixture, second)).toEqual(kept);
            expect(await pendingWorkOf(fixture, 2)).toEqual([]);
            expect(receiptFactKindsOf(fixture, second)).toEqual(['acknowledgement']);
        }
    );

    it.each(STORES)(
        'on %s, a superseded receipt timer that runs late, past the kept row\'s deadline, rewrites nothing and states nothing',
        async (store) => {
            const fixture = await createEndedMessageFixture(store, { maxRepairs: 4 });
            const { second, kept } = await keepTimedOutReceiptOverSupersededTimers(fixture);

            // The engine runs late: one drain once every deadline of the receipt has passed.
            vi.setSystemTime(START_MS + 2_200);
            await drainOutboundWorkDueNow(fixture.runtime, fixture.stores);
            expect(await readReceiptRow(fixture, second)).toEqual(kept);
            expect(await pendingWorkOf(fixture, 2)).toEqual([]);
            await advanceTo(fixture, 30_000);

            expect(framesOf(fixture, 2)).toEqual(['first-send', 'gap-repair(peer-1#1)', 'gap-repair(peer-2#1)']);
            expect(await readReceiptRow(fixture, second)).toEqual(kept);
            expect(await pendingWorkOf(fixture, 2)).toEqual([]);
            expect(receiptFactKindsOf(fixture, second)).toEqual(['acknowledgement']);
        }
    );

    it.each(STORES)('on %s, a request over an ended and a live sequence serves and charges the live one alone', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 1, acknowledgedSeqs: [3, 4, 5] });
        const [first, second] = fixture.messages as [ALMessage, ALMessage];
        await exhaustSeqTwo(fixture);
        expect((await fixture.stores.admissionStore.readStoredMessage(second.id.msgId))?.ended).toBe(true);
        expect((await fixture.stores.admissionStore.readStoredMessage(first.id.msgId))?.ended).toBe(false);
        const secondFrames = framesOf(fixture, 2);

        expect(await requestGap(fixture, { peer: 'peer-1', number: 2, from: 1 })).toEqual({ kind: 'committed' });
        await advanceTo(fixture, 1_425);

        expect(framesOf(fixture, 1)).toEqual(['first-send', 'gap-repair(peer-1#2)']);
        expect((await readRepairAttempt(fixture, first))?.attemptsByRequester).toEqual({
            [toALOutboundRepairRequesterKey({ requestedByPeerId: 'peer-1' })]: 1
        });
        expect(framesOf(fixture, 2)).toEqual(secondFrames);
        expect(await readRepairAttempt(fixture, second)).toBeUndefined();
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
    });
});

/**
 * Two gap repairs move seq 2's receipt deadline twice, so the first send's and the first repair's timers are
 * superseded; a `timed-out` server receipt at 100 ms then ends the message and its receipt's current timer, and keeps
 * the incomplete row.
 */
async function keepTimedOutReceiptOverSupersededTimers(
    fixture: EndedMessageFixture
): Promise<{ readonly second: ALMessage; readonly kept: ALOutboundPendingAckSnapshot | undefined; }> {
    const second = fixture.messages[1]!;
    await advanceTo(fixture, 50);
    await requestSeqTwo(fixture, 'peer-1', 1);
    await advanceTo(fixture, 75);
    await requestSeqTwo(fixture, 'peer-2', 1);
    await advanceTo(fixture, 100);
    expect(await pendingWorkOf(fixture, 2)).toEqual(['ack-timeout', 'ack-timeout', 'ack-timeout']);
    expect(
        await fixture.runtime.acceptReceipt(createServerReceipt(second, 'timed-out', RECEIVERS, {
            controlMsgId: `receipt-timed-out-${second.id.msgId}`,
            confirmedRecipientPeerIds: ['peer-1']
        }))
    ).toEqual({ kind: 'committed' });
    expect(await pendingWorkOf(fixture, 2)).toEqual(['ack-timeout', 'ack-timeout']);
    return { second, kept: await readReceiptRow(fixture, second) };
}

async function readReceiptRow(
    fixture: EndedMessageFixture,
    message: ALMessage
): Promise<ALOutboundPendingAckSnapshot | undefined> {
    return await fixture.stores.admissionStore.readReceiptState({ originPeerId: message.id.senderId, msgId: message.id.msgId });
}

/** The receipt facts stated for `message`: each acknowledgement and each `receipt-exhausted`, by kind. */
function receiptFactKindsOf(fixture: EndedMessageFixture, message: ALMessage): readonly string[] {
    return fixture.settlements.filter((settlement) =>
        settlement.msgId === message.id.msgId &&
        (settlement.kind === 'acknowledgement' || settlement.kind === 'receipt-exhausted')
    ).map((settlement) => settlement.kind);
}

/** Both receivers' first requests are served; peer-2's second finds its budget of one spent at 1 325 ms. */
async function exhaustSeqTwo(fixture: EndedMessageFixture): Promise<void> {
    await advanceTo(fixture, 50);
    await requestSeqTwo(fixture, 'peer-1', 1);
    await advanceTo(fixture, 75);
    await requestSeqTwo(fixture, 'peer-2', 1);
    await advanceTo(fixture, 1_325);
    await requestSeqTwo(fixture, 'peer-2', 2);
    await advanceTo(fixture, 1_400);
}

async function createEndedMessageFixture(
    store: StoreKind,
    options: EndedMessageFixtureOptions
): Promise<EndedMessageFixture> {
    const reopenable = createReopenableStores(store);
    const messages = [1, 2, 3, 4, 5].map((seq) => ({
        ...createOutboundMessage(`msg-seq-${seq}`, { ttlMs: 60_000 }),
        ordering: { orderingKey: 'conversation-1', epoch: 0, seq }
    }));
    const transport: FixtureTransport = { frames: [], holdRepairs: options.holdRepairs ?? false };
    const settlements: ALDeliverySettlement[] = [];
    const fixture: EndedMessageFixture = {
        runtime: createFixtureRuntime(reopenable.stores, settlements, transport, options.maxRepairs),
        stores: reopenable.stores,
        settlements,
        reopenable,
        messages,
        transport,
        maxRepairs: options.maxRepairs
    };
    for (const message of messages) {
        await enqueueOutboundOrThrow(fixture.runtime, message);
    }
    for (const peer of RECEIVERS) {
        for (const message of (options.acknowledgedSeqs ?? [1, 3, 4, 5]).map((seq) => messages[seq - 1]!)) {
            await fixture.runtime.acceptControlMessage(toAck(message, peer), 'peer');
        }
    }
    return fixture;
}

function createReopenableStores(store: StoreKind): ReopenableStores {
    if (store === 'memory') {
        const stores = createDefaultOutboundTestStores();
        return { stores, reopen: () => stores };
    }
    const dbName = `${NAMESPACE}-${crypto.randomUUID()}`;
    const open = () =>
        createIndexedDbOutboundTestStores({
            observer: createPassThroughIndexedDbOperationObserver(),
            namespace: NAMESPACE,
            dbName
        });
    return { stores: open(), reopen: open };
}

function createFixtureRuntime(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    settlements: ALDeliverySettlement[],
    transport: FixtureTransport,
    maxRepairs: number
): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores,
        carrier: 'rtc',
        planOutgoingMessage: toSendPlanner(maxRepairs),
        planRepairMessage,
        settlements: (settlement) => settlements.push(settlement),
        sendPreparedMessage: async (prepared): Promise<ALOutboundPreparedSendResult> => {
            if (transport.holdRepairs && prepared.kind === 'repair') {
                return { status: 'not-ready', submissionAttempted: false, retryAfterMs: 500 };
            }
            transport.frames.push({ seq: prepared.seq!, cause: prepared.cause! });
            return { status: 'sent', submissionAttempted: true };
        }
    });
}

async function reload(fixture: EndedMessageFixture): Promise<void> {
    await fixture.runtime.dispose();
    fixture.stores = fixture.reopenable.reopen();
    fixture.settlements = [];
    fixture.runtime = createFixtureRuntime(fixture.stores, fixture.settlements, fixture.transport, fixture.maxRepairs);
}

const RECEIPT_TRACKING = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: RECEIVERS,
    nextHopPeerIds: RECEIVERS,
    mode: 'receiver'
} as const;

function toSendPlanner(maxRepairs: number): ALOutboundPlanner<OutboundTestPayload> {
    return (msg) => ({
        msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId, seq: String(msg.ordering?.seq), cause: 'first-send' }],
        ackTracking: RECEIPT_TRACKING,
        repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: maxRepairs }
    });
}

/** As the RTC planner: a repair copy carries the receipt's tracking, whose receiver mode replaces the expected set. */
async function planRepairMessage(
    msg: ALMessage,
    request: ALOutboundRepairRequest
): Promise<ALOutboundDispatchPlan<OutboundTestPayload>> {
    return {
        msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [{
            kind: 'repair',
            msgId: msg.id.msgId,
            seq: String(msg.ordering?.seq),
            cause: request.trigger === 'ack-timeout'
                ? 'receipt-retry'
                // The hint's request number rides on the request the planner is handed, beyond its declared fields.
                : `gap-repair(${request.requestedByPeerId}#${'gapRequestNumber' in request ? String(request.gapRequestNumber) : '?'})`
        }],
        ackTracking: { ...RECEIPT_TRACKING, expectedPeerIdsUpdate: 'replace' },
        repairTracking: request.repair
    };
}

/** Moves the clock to `ms` after the start in 25 ms steps, draining the work due at each. */
async function advanceTo(fixture: EndedMessageFixture, ms: number): Promise<void> {
    while (Date.now() < START_MS + ms) {
        vi.setSystemTime(Math.min(Date.now() + STEP_MS, START_MS + ms));
        await drainOutboundWorkDueNow(fixture.runtime, fixture.stores);
    }
    await drainOutboundWorkDueNow(fixture.runtime, fixture.stores);
}

/** A gap NACK for sequence 2 that names sequence 3's message, the one whose arrival revealed the gap. */
async function requestSeqTwo(
    fixture: EndedMessageFixture,
    peer: string,
    number: number
): Promise<ALOutboundControlAdmissionResult> {
    return await requestGap(fixture, { peer, number, from: 2 });
}

/** A gap NACK for sequences `from` to 2 that names sequence 3's message, the one whose arrival revealed the gap. */
async function requestGap(
    fixture: EndedMessageFixture,
    request: { readonly peer: string; readonly number: number; readonly from: number; }
): Promise<ALOutboundControlAdmissionResult> {
    const { peer, number, from } = request;
    const revealing = fixture.messages[2]!;
    return await fixture.runtime.acceptControlMessage(
        newALNackControlMessage(
            { v: 4, msgId: `gap-${peer}-${number}-from-${from}`, ts: Date.now(), senderId: peer, traceId: 'trace-message-end' },
            toTestALNackPayload({
                msgId: revealing.id.msgId,
                fromPeerId: peer,
                toPeerId: 'self',
                reason: 'gap',
                orderingKey: toALOrderingTrackKey(revealing)!,
                expectedSeq: from,
                missingRanges: [{ from, to: 2 }],
                gapRequestNumber: number
            })
        ),
        'peer'
    );
}

function toAck(message: ALMessage, peer: string): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${peer}-${message.id.msgId}`, ts: Date.now(), senderId: peer, traceId: 'trace-message-end' },
        toTestALAckPayload({ ackedMsgId: message.id.msgId, fromPeerId: peer, toPeerId: 'self' })
    );
}

function framesOf(fixture: EndedMessageFixture, seq: number): readonly string[] {
    return fixture.transport.frames.filter((frame) => frame.seq === String(seq)).map((frame) => frame.cause);
}

/** The facts of sequence `seq`'s message that end it, each as a pair of its kind and its reason. */
function terminalFactsOf(fixture: EndedMessageFixture, seq: number): readonly (readonly [string, string])[] {
    const msgId = fixture.messages[seq - 1]!.id.msgId;
    return fixture.settlements.flatMap((settlement): (readonly [string, string])[] => {
        if (settlement.msgId !== msgId) {
            return [];
        }
        switch (settlement.kind) {
            case 'admission':
                return settlement.verdict.kind === 'skipped' || settlement.verdict.kind === 'refused'
                    ? [['admission', settlement.verdict.reason]]
                    : [];
            case 'receipt-exhausted':
                return [['receipt-exhausted', settlement.cause]];
            case 'relay-rejected':
                return [['relay-rejected', settlement.relayRejection.reason]];
            case 'acknowledgement':
                return settlement.complete ? [['acknowledgement', 'complete']] : [];
            default:
                return [];
        }
    });
}

/** The kinds of the pending work rows that name sequence `seq`'s message. */
async function pendingWorkOf(fixture: EndedMessageFixture, seq: number): Promise<readonly string[]> {
    const msgId = fixture.messages[seq - 1]!.id.msgId;
    const { stores } = fixture;
    const kinds: string[] = [];
    for (const key of await stores.workQueue.getAllKeys()) {
        const entry = await stores.workQueue.getItem(key);
        if (entry === undefined || !isPendingALOutboundWork(entry)) {
            continue;
        }
        const { payload } = await stores.admissionStore.readWorkSnapshot(entry, undefined);
        const named = 'message' in payload ? payload.message.msgId : 'msgId' in payload ? payload.msgId : undefined;
        if (named === msgId) {
            kinds.push(payload.kind);
        }
    }
    return kinds;
}

async function readRepairRead(
    fixture: EndedMessageFixture,
    message: ALMessage
): Promise<ALOutboundRepairReadDto<OutboundTestPayload>> {
    return await fixture.stores.admissionStore.readRepairMessage(message.id.msgId, toSendPlanner(fixture.maxRepairs));
}

async function readRepairAttempt(
    fixture: EndedMessageFixture,
    message: ALMessage
): Promise<ALOutboundRepairAttemptSnapshot | undefined> {
    return (await fixture.stores.admissionStore.readOutgoingMessage({
        msg: message,
        planner: toSendPlanner(fixture.maxRepairs),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    })).repairAttempt;
}

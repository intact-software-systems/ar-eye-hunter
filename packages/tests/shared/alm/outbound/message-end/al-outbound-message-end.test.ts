import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
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
    ALOutboundMessageRuntime,
    ALOutboundPreparedSendResult,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { toALOutboundReceiptClasses } from '@shared/alm/outbound/control/to-al-outbound-receipt-classes.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundRepairRequesterKey
} from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createOutboundMessage,
    createServerReceipt,
    drainOutboundWorkDueNow,
    enqueueOutboundOrThrow
} from '../../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../../outbound-test-payload.ts';
import {
    advanceOutboundClockTo,
    advanceOutboundClockToNextDue,
    createOutboundTimelineRuntime,
    createReopenableOutboundTestStores,
    OUTBOUND_TIMELINE_STEP_MS,
    readPendingOutboundWorkKinds,
    reloadOutboundTimelinePage,
    toOutboundTerminalFacts,
    toOutboundTimelineReceiptTracking,
    toOutboundTimelineRepairPlan,
    type OutboundTimelineSender,
    type OutboundTimelineStoreKind,
    type ReopenableOutboundTestStores
} from '../outbound-timeline-test-fixture.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../../al-control-test-payloads.ts';

const START_MS = Date.UTC(2026, 10, 19, 12);
const RECEIVERS = ['peer-1', 'peer-2'];
const NAMESPACE = 'outbound-message-end';

const STORES: readonly OutboundTimelineStoreKind[] = ['memory', 'indexeddb'];

/** The transport double: it records every copy it takes, by sequence, with the cause its planner named. */
interface FixtureTransport {
    readonly frames: { readonly msgId: string; readonly seq: string; readonly cause: string; }[];
    /** While true, it answers `not-ready` for every repair copy. */
    holdRepairs: boolean;
}

/** A sender over one pair of stores; a reload replaces the runtime, its settlements list and, on IndexedDB, the stores. */
interface EndedMessageFixture {
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    settlements: ALDeliverySettlement[];
    readonly reopenable: ReopenableOutboundTestStores;
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
        const kept = await exhaustSeqTwo(fixture);
        const settledFrames = framesOf(fixture, 2);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
        expect(kept).toBeDefined();
        expect(await readReceiptRow(fixture, second)).toEqual(kept);
        expect(await readRepairAttempt(fixture, second)).toBeUndefined();
        expect((await readRepairRead(fixture, second)).firstHopWait).toBeUndefined();
        // The timers of the deadlines earlier dispatches moved; the end commit ended the receipt's current timer.
        expect(await pendingWorkOf(fixture, 2)).toEqual(['ack-timeout', 'ack-timeout']);
        expect(await readReceiptTimerStatus(fixture, kept!)).toBe(EntityStatus.COMPLETED);
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
        const kept = await advanceUntilEnded(fixture, second);
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
        expect(kept).toBeDefined();
        expect(await readReceiptRow(fixture, second)).toEqual(kept);
        expect(await readReceiptTimerStatus(fixture, kept!)).toBe(EntityStatus.COMPLETED);
        expect(await pendingWorkOf(fixture, 2)).toEqual([]);
        expect(await readRepairAttempt(fixture, second)).toBeUndefined();
    });

    it.each(STORES)('on %s, a reload between the settlement and a late request states nothing twice', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 1 });
        await exhaustSeqTwo(fixture);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
        await reloadOutboundTimelinePage(fixture, toSender(fixture.transport, fixture.maxRepairs));
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
        const kept = await advanceUntilEnded(fixture, second);
        await advanceTo(fixture, 9_000);
        expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
        const framesBefore = framesOf(fixture, 2);
        expect(await requestSeqTwo(fixture, 'peer-1', 1)).toEqual({ kind: 'committed' });
        await advanceTo(fixture, 30_000);
        expect(framesOf(fixture, 2)).toEqual(framesBefore);
        expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
        expect(kept).toBeDefined();
        expect(await readReceiptRow(fixture, second)).toEqual(kept);
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
        'on %s, a superseded receipt timer that runs in time writes nothing for the kept row and states nothing',
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
        const kept = await exhaustSeqTwo(fixture);
        expect((await fixture.stores.admissionStore.readStoredMessage(second.id.msgId))?.ended).toBe(true);
        expect(kept).toBeDefined();
        expect(await readReceiptRow(fixture, second)).toEqual(kept);
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

describe('a terminal end keeps its incomplete receipt row as a final snapshot', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(STORES)('on %s, a queued receipt timer that meets the kept row writes nothing (D686)', async (store) => {
        const fixture = await createEndedMessageFixture(store, { maxRepairs: 1 });
        const second = fixture.messages[1]!;
        const kept = await exhaustSeqTwo(fixture);
        expect(await pendingWorkOf(fixture, 2)).toEqual(['ack-timeout', 'ack-timeout']);

        await advanceTo(fixture, 2_100);

        expect(kept).toBeDefined();
        expect(await readReceiptRow(fixture, second)).toEqual(kept);
        expect(await pendingWorkOf(fixture, 2)).toEqual([]);
        expect(framesOf(fixture, 2)).toEqual(['first-send', 'gap-repair(peer-1#1)', 'gap-repair(peer-2#1)']);
        expect(terminalFactsOf(fixture, 2)).toEqual([['admission', 'repair-exhausted']]);
    });

    it.each(STORES)(
        'on %s, a gap NACK naming a revealing message whose receipt ended is admitted, directly and relayed, and serves only sequences that have not ended',
        async (store) => {
            const fixture = await createEndedMessageFixture(store, { maxRepairs: 6, acknowledgedSeqs: [1, 4, 5] });
            const [, second, third] = fixture.messages as [ALMessage, ALMessage, ALMessage];
            // Repairs move seq 2's receipt deadline, so seq 3's receipt, which nothing moves, ends first.
            for (const [atMs, number] of [[50, 1], [1_550, 2], [4_550, 3]] as const) {
                await advanceTo(fixture, atMs);
                await requestSeqTwo(fixture, 'peer-1', number);
            }
            await advanceUntilEnded(fixture, third);
            expect(terminalFactsOf(fixture, 3)).toEqual([['receipt-exhausted', 'budget']]);
            expect(terminalFactsOf(fixture, 2)).toEqual([]);
            const kept = await readReceiptRow(fixture, third);
            expect(kept === undefined ? undefined : toALOutboundReceiptClasses(kept).unconfirmedPeerIds).toEqual(RECEIVERS);

            expect(await requestGapNaming(fixture, { peer: 'peer-1', recipient: 'peer-1', revealing: third, number: 4, from: 2 }))
                .toEqual({ kind: 'committed' });
            await advanceTo(fixture, Date.now() - START_MS + OUTBOUND_TIMELINE_STEP_MS);
            expect(await requestGapNaming(fixture, { peer: 'peer-2', recipient: 'peer-1', revealing: third, number: 5, from: 2 }))
                .toEqual({ kind: 'committed' });
            await advanceTo(fixture, Date.now() - START_MS + 100);

            expect(framesOf(fixture, 2).filter((cause) => cause.startsWith('gap-repair'))).toEqual([
                'gap-repair(peer-1#1)',
                'gap-repair(peer-1#2)',
                'gap-repair(peer-1#3)',
                'gap-repair(peer-1#4)',
                'gap-repair(peer-2#5)'
            ]);
            expect(await readReceiptRow(fixture, third)).toEqual(kept);

            await advanceUntilEnded(fixture, second);
            expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
            const settledFrames = framesOf(fixture, 2);
            expect(await requestGapNaming(fixture, { peer: 'peer-1', recipient: 'peer-1', revealing: third, number: 6, from: 2 }))
                .toEqual({ kind: 'committed' });
            await advanceTo(fixture, 30_000);

            expect(framesOf(fixture, 2)).toEqual(settledFrames);
            expect(terminalFactsOf(fixture, 2)).toEqual([['receipt-exhausted', 'budget']]);
        }
    );

    it.each(STORES)(
        'on %s, a late outside-audience NACK after receipt-exhausted, from the one recipient still owed, changes no row and states no fact',
        async (store) => {
            const fixture = await createEndedMessageFixture(store, { maxRepairs: 4, acknowledgedSeqs: [1, 2, 4, 5] });
            const third = fixture.messages[2]!;
            expect(await fixture.runtime.acceptControlMessage(toAck(third, 'peer-1'), 'peer')).toEqual({ kind: 'committed' });
            const kept = await advanceUntilEnded(fixture, third);
            expect(terminalFactsOf(fixture, 3)).toEqual([['receipt-exhausted', 'budget']]);
            expect(kept === undefined ? undefined : toALOutboundReceiptClasses(kept).unconfirmedPeerIds).toEqual(['peer-2']);
            const factsBefore = fixture.settlements.filter((settlement) => settlement.msgId === third.id.msgId);

            expect(await fixture.runtime.acceptControlMessage(toOutsideNack(third, 'peer-2', 'before-entry'), 'peer'))
                .toEqual({ kind: 'rejected', reason: 'AL control names a message that has ended' });
            await advanceTo(fixture, Date.now() - START_MS + 100);

            expect(await readReceiptRow(fixture, third)).toEqual(kept);
            expect(fixture.settlements.filter((settlement) => settlement.msgId === third.id.msgId)).toEqual(factsBefore);
        }
    );

    it.each(STORES)(
        'on %s, one track\'s kept row leaves another track\'s repair alone, refuses a late confirmation of its message, and a complete row still takes a late hop end',
        async (store) => {
            const fixture = await createEndedMessageFixture(store, { maxRepairs: 4, acknowledgedSeqs: [1, 2, 4, 5] });
            const third = fixture.messages[2]!;
            const kept = await advanceUntilEnded(fixture, third);
            expect(terminalFactsOf(fixture, 3)).toEqual([['receipt-exhausted', 'budget']]);
            expect(await readReceiptRow(fixture, third)).toEqual(kept);
            const [trackFirst, trackSecond, trackThird] = await enqueueSecondTrack(fixture) as [ALMessage, ALMessage, ALMessage];
            // The relay hop confirms itself at once; its hop ends only once its subtree answered.
            for (const ack of [toAck(trackFirst, RELAY_HOP, 'accepted'), ...RECEIVERS.map((peer) => toAck(trackFirst, peer))]) {
                expect(await fixture.runtime.acceptControlMessage(ack, 'peer')).toEqual({ kind: 'committed' });
            }
            expect(toOutboundTerminalFacts(fixture.settlements, trackFirst.id.msgId)).toEqual([['acknowledgement', 'complete']]);

            // (a) the second track's gap request names its own revealing message and builds its own hint.
            expect(await requestGapNaming(fixture, { peer: 'peer-1', recipient: 'peer-1', revealing: trackThird, number: 1, from: 2 }))
                .toEqual({ kind: 'committed' });
            await advanceTo(fixture, Date.now() - START_MS + 100);
            expect(framesOfMessage(fixture, trackSecond)).toEqual(['first-send', 'gap-repair(peer-1#1)']);

            // (b) a late `delivered` for the ended message is refused, and the kept row and its facts stay as they were.
            const factsBefore = fixture.settlements.filter((settlement) => settlement.msgId === third.id.msgId);
            expect(await fixture.runtime.acceptControlMessage(toAck(third, 'peer-1'), 'peer'))
                .toEqual({ kind: 'rejected', reason: 'AL control names a message that has ended' });
            await advanceTo(fixture, Date.now() - START_MS + 100);
            expect(await readReceiptRow(fixture, third)).toEqual(kept);
            expect(fixture.settlements.filter((settlement) => settlement.msgId === third.id.msgId)).toEqual(factsBefore);
            // (b') a late outside-audience NACK for it rewrites nothing and states nothing either.
            expect(await fixture.runtime.acceptControlMessage(toOutsideNack(third, 'peer-1', 'not-subscribed'), 'peer'))
                .toEqual({ kind: 'rejected', reason: 'AL control names a message that has ended' });
            await advanceTo(fixture, Date.now() - START_MS + 100);
            expect(await readReceiptRow(fixture, third)).toEqual(kept);
            expect(fixture.settlements.filter((settlement) => settlement.msgId === third.id.msgId)).toEqual(factsBefore);

            // (c) the second track runs through a relay hop: a complete row's late hop end is admitted as before.
            expect((await fixture.stores.admissionStore.readStoredMessage(trackFirst.id.msgId))?.ended).toBe(true);
            expect(await fixture.runtime.acceptControlMessage(toAck(trackFirst, RELAY_HOP, 'subtree-complete'), 'peer'))
                .toEqual({ kind: 'committed' });
        }
    );
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

/**
 * Both receivers' first requests are served; peer-2's second finds its budget of one spent at 1 325 ms. Returns seq 2's
 * receipt row as it stood just before that request ended the message.
 */
async function exhaustSeqTwo(fixture: EndedMessageFixture): Promise<ALOutboundPendingAckSnapshot | undefined> {
    await advanceTo(fixture, 50);
    await requestSeqTwo(fixture, 'peer-1', 1);
    await advanceTo(fixture, 75);
    await requestSeqTwo(fixture, 'peer-2', 1);
    await advanceTo(fixture, 1_325);
    const beforeTheEnd = await readReceiptRow(fixture, fixture.messages[1]!);
    await requestSeqTwo(fixture, 'peer-2', 2);
    await advanceTo(fixture, 1_400);
    return beforeTheEnd;
}

/**
 * Moves the clock from one due instant to the next until `message` has ended, at most to 30 s; the receipt row as it
 * stood just before the work that ended it ran.
 */
async function advanceUntilEnded(
    fixture: EndedMessageFixture,
    message: ALMessage
): Promise<ALOutboundPendingAckSnapshot | undefined> {
    let beforeTheEnd = await readReceiptRow(fixture, message);
    while (toOutboundTerminalFacts(fixture.settlements, message.id.msgId).length === 0 && Date.now() - START_MS < 30_000) {
        beforeTheEnd = await readReceiptRow(fixture, message);
        await advanceOutboundClockToNextDue(fixture, START_MS + 30_000);
    }
    return beforeTheEnd;
}

/** The status of the work row of the receipt timer `receipt`'s current deadline names. */
async function readReceiptTimerStatus(
    fixture: EndedMessageFixture,
    receipt: ALOutboundPendingAckSnapshot
): Promise<EntityStatus | undefined> {
    const { admissionStore } = fixture.stores;
    return (await admissionStore.readWork(toALOutboundWorkKey(admissionStore.namespace, toALOutboundAckTimeoutEffectId(receipt))))?.status;
}

async function createEndedMessageFixture(
    store: OutboundTimelineStoreKind,
    options: EndedMessageFixtureOptions
): Promise<EndedMessageFixture> {
    const reopenable = createReopenableOutboundTestStores(store, NAMESPACE);
    const messages = [1, 2, 3, 4, 5].map((seq) => ({
        ...createOutboundMessage(`msg-seq-${seq}`, { ttlMs: 60_000 }),
        ordering: { orderingKey: 'conversation-1', epoch: 0, seq }
    }));
    const transport: FixtureTransport = { frames: [], holdRepairs: options.holdRepairs ?? false };
    const settlements: ALDeliverySettlement[] = [];
    const fixture: EndedMessageFixture = {
        runtime: createOutboundTimelineRuntime(reopenable.stores, settlements, toSender(transport, options.maxRepairs)),
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

/** The planners of the five sends, and a transport that records each copy, holding repairs while asked to. */
function toSender(transport: FixtureTransport, maxRepairs: number): OutboundTimelineSender {
    return {
        planOutgoingMessage: toSendPlanner(maxRepairs),
        planRepairMessage: async (msg, request) =>
            toOutboundTimelineRepairPlan({
                msg,
                request,
                tracking: RECEIPT_TRACKING,
                copy: {
                    kind: 'repair',
                    msgId: msg.id.msgId,
                    seq: String(msg.ordering?.seq),
                    cause: request.trigger === 'ack-timeout'
                        ? 'receipt-retry'
                        // The hint's request number rides on the request the planner is handed, beyond its declared fields.
                        : `gap-repair(${request.requestedByPeerId}#${'gapRequestNumber' in request ? String(request.gapRequestNumber) : '?'})`
                }
            }),
        sendPreparedMessage: async (prepared): Promise<ALOutboundPreparedSendResult> => {
            if (transport.holdRepairs && prepared.kind === 'repair') {
                return { status: 'not-ready', submissionAttempted: false, retryAfterMs: 500 };
            }
            transport.frames.push({ msgId: prepared.msgId!, seq: prepared.seq!, cause: prepared.cause! });
            return { status: 'sent', submissionAttempted: true };
        }
    };
}

const RECEIPT_TRACKING = toOutboundTimelineReceiptTracking(RECEIVERS);

/** The relay hop the second track's sends pass through to both receivers, itself a receiver too. */
const RELAY_HOP = 'relay-1';

/** The second track's receipt: the relay hop and the receivers below it. */
const RELAYED_RECEIPT_TRACKING = { ...RECEIPT_TRACKING, expectedPeerIds: [...RECEIVERS, RELAY_HOP], nextHopPeerIds: [RELAY_HOP] };

function toSendPlanner(maxRepairs: number): ALOutboundPlanner<OutboundTestPayload> {
    return (msg) => ({
        msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId, seq: String(msg.ordering?.seq), cause: 'first-send' }],
        ackTracking: msg.ordering?.orderingKey === 'conversation-2' ? RELAYED_RECEIPT_TRACKING : RECEIPT_TRACKING,
        repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: maxRepairs }
    });
}

/** Moves the clock to `ms` after the start in 25 ms steps, draining the work due at each. */
async function advanceTo(fixture: EndedMessageFixture, ms: number): Promise<void> {
    await advanceOutboundClockTo(fixture, START_MS + ms);
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
    const { peer } = request;
    return await requestGapNaming(fixture, { ...request, recipient: peer, revealing: fixture.messages[2]! });
}

/** A gap request `peer` sends: the gap of `recipient` up to the sequence before `revealing`, numbered `number`. */
interface GapRequestNaming {
    readonly peer: string;
    /** The recipient the NACK speaks for: `peer` itself, or a recipient below `peer` it relays for. */
    readonly recipient: string;
    readonly revealing: ALMessage;
    readonly number: number;
    readonly from: number;
}

async function requestGapNaming(
    fixture: EndedMessageFixture,
    request: GapRequestNaming
): Promise<ALOutboundControlAdmissionResult> {
    const { peer, recipient, revealing, number, from } = request;
    const to = revealing.ordering!.seq! - 1;
    return await fixture.runtime.acceptControlMessage(
        newALNackControlMessage(
            {
                v: 4,
                msgId: `gap-${peer}-${recipient}-${revealing.id.msgId}-${number}-from-${from}`,
                ts: Date.now(),
                senderId: peer,
                traceId: 'trace-message-end'
            },
            toTestALNackPayload({
                msgId: revealing.id.msgId,
                fromPeerId: peer,
                toPeerId: 'self',
                logicalRecipientPeerId: recipient,
                reason: 'gap',
                orderingKey: toALOrderingTrackKey(revealing)!,
                expectedSeq: from,
                missingRanges: [{ from, to }],
                gapRequestNumber: number
            })
        ),
        'peer'
    );
}

function toAck(message: ALMessage, peer: string, status: ALAckStatus = 'delivered'): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${peer}-${status}-${message.id.msgId}`, ts: Date.now(), senderId: peer, traceId: 'trace-message-end' },
        toTestALAckPayload({ ackedMsgId: message.id.msgId, fromPeerId: peer, toPeerId: 'self', status })
    );
}

/** A NACK `peer` sends for itself placing it outside `message`'s audience, for `reason`. */
function toOutsideNack(message: ALMessage, peer: string, reason: 'before-entry' | 'not-subscribed'): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: `${reason}-${peer}-${message.id.msgId}`, ts: Date.now(), senderId: peer, traceId: 'trace-message-end' },
        toTestALNackPayload({ msgId: message.id.msgId, fromPeerId: peer, toPeerId: 'self', reason })
    );
}

/** The causes of the copies the transport took of `message`, in order. */
function framesOfMessage(fixture: EndedMessageFixture, message: ALMessage): readonly string[] {
    return fixture.transport.frames.filter((frame) => frame.msgId === message.id.msgId).map((frame) => frame.cause);
}

/** Three sends on a second ordered track of the same sender, `conversation-2`, through the relay hop, each enqueued now. */
async function enqueueSecondTrack(fixture: EndedMessageFixture): Promise<readonly ALMessage[]> {
    const messages = [1, 2, 3].map((seq) => ({
        ...createOutboundMessage(`msg-b-seq-${seq}`, { ttlMs: 60_000 }),
        ordering: { orderingKey: 'conversation-2', epoch: 0, seq }
    }));
    for (const message of messages) {
        await enqueueOutboundOrThrow(fixture.runtime, message);
    }
    return messages;
}

function framesOf(fixture: EndedMessageFixture, seq: number): readonly string[] {
    return fixture.transport.frames.filter((frame) => frame.seq === String(seq)).map((frame) => frame.cause);
}

/** The facts of sequence `seq`'s message that end it, each as a pair of its kind and its reason. */
function terminalFactsOf(fixture: EndedMessageFixture, seq: number): readonly (readonly [string, string])[] {
    return toOutboundTerminalFacts(fixture.settlements, fixture.messages[seq - 1]!.id.msgId);
}

/** The kinds of the pending work rows that name sequence `seq`'s message. */
async function pendingWorkOf(fixture: EndedMessageFixture, seq: number): Promise<readonly string[]> {
    return await readPendingOutboundWorkKinds(fixture.stores, fixture.messages[seq - 1]!.id.msgId);
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

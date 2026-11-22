import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';

import { newALMulticastMessage, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { toALOrderingTrackKey, type ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import type { ALRuntimeStoreRetentionConfig } from '@shared/alm/ALStoreRetention.ts';
import type { ALInboundCommitBundle } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { resolveALInboundWorkDueAtMs } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundGapRenewal } from '@shared/alm/inbound/gap-renewal/al-inbound-gap-renewal.ts';
import type { ALInboundReceiptProofs } from '@shared/alm/inbound/receipt-proof/sign-al-inbound-receipt-controls.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RtcReceiptProofSigner } from '@shared/multicast/receipt-proof/rtc-receipt-proof-signer.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';

import '../../../../setup-browser-indexeddb.ts';
import { verifyTestALReceiptControl } from '../../../../al-control-test-payloads.ts';
import { createAvailablePublicationCryptoFixture } from '../../../signature/publication-crypto-fixtures.ts';
import { readInboundTestWorkDueAtMs } from '../../../wait-for-al-inbound-work.ts';
import {
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_EFFECT_PREPARATION,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    planInboundTestMessage,
    readInboundTestWorkRows,
    runInboundWorkDueNow,
    setNextInboundCommitConflicted,
    type InboundTestRuntime,
    type InboundTestStorage
} from '../../inbound-runtime-test-fixture.ts';

const START_MS = Date.UTC(2026, 10, 19, 12);
const STORAGES: readonly InboundTestStorage[] = ['memory', 'indexeddb'];
/** How far one step moves the fake clock while a started engine runs by itself. */
const ENGINE_STEP_MS = 20;
/** A message lifetime shorter than the renewal schedule's 7 s at the fixture's stretch of 1. */
const SHORT_TTL_MS = 5_000;
/** A draw that stretches every interval as far as a stretch may: 1.5 s, 3 s and 6 s, the last timer due at 10.5 s. */
const MAXIMUM_STRETCH_DRAW = 0.999_999_9;
/** How long after its due time the engine claims the last timer under load. */
const LATE_CLAIM_MS = 100;
/** Turns of the event loop each step gives the store, more than one engine pass needs. */
const STORAGE_TURNS_PER_STEP = 100;
const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room' };
const RTC_SOURCE: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID };
const CRYPTO = await createAvailablePublicationCryptoFixture();
const SIGNED: ALInboundReceiptProofs = { kind: 'signed', signer: new RtcReceiptProofSigner({ crypto: CRYPTO }) };

/** What a gap request this receiver sent states: which control, which number, which sequences, about which arrival. */
interface GapControl {
    readonly type: 'nack' | 'repair';
    readonly gapRequestNumber: number | undefined;
    readonly missingRanges: readonly ALSeqRange[] | undefined;
    readonly msgId: string;
    readonly expectedSeq: number | undefined;
}

interface RenewalFixtureInput {
    readonly random?: () => number;
    readonly dbName?: string;
    readonly carrier?: 'ws' | 'rtc';
    readonly receiptProofs?: ALInboundReceiptProofs;
    readonly retention?: ALRuntimeStoreRetentionConfig;
}

interface OrderedMessageInput {
    readonly ack?: ALAckMode;
    /** Absent gives 60 s; `null` sends the message with no deadline of its own. */
    readonly ttlMs?: number | null;
}

let fixtureCount = 0;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START_MS);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('a receiver whose ordered track has a gap', () => {
    it.each(STORAGES)(
        'on %s, asks again for a sequence that stays missing at 1 s, 3 s and 7 s, numbered 2, 3 and 4, and then stops',
        async (storage) => {
            const fixture = createRenewalFixture(storage);
            const second = orderedMessage(2);
            await fixture.runtime.admitIncomingMessage(second, INBOUND_TEST_SOURCE);
            await advanceTo(fixture, 999);
            expect(gapControls(fixture).map((control) => control.gapRequestNumber)).toEqual([1, 1]);
            for (const [atMs, number] of [[1_000, 2], [3_000, 3], [7_000, 4]] as const) {
                await advanceTo(fixture, atMs - 1);
                expect(gapControls(fixture).filter((control) => control.gapRequestNumber === number)).toEqual([]);
                await advanceTo(fixture, atMs);
                expect(gapControls(fixture).filter((control) => control.gapRequestNumber === number)).toEqual([
                    { type: 'nack', gapRequestNumber: number, missingRanges: [{ from: 1, to: 1 }], msgId: second.id.msgId, expectedSeq: 1 },
                    { type: 'repair', gapRequestNumber: number, missingRanges: [{ from: 1, to: 1 }], msgId: second.id.msgId, expectedSeq: 1 }
                ]);
            }
            await advanceTo(fixture, 29_000);
            expect(gapControls(fixture)).toHaveLength(8);
            expect(await readPendingInboundWork(fixture)).toEqual([]);
        }
    );

    // Breaks when nothing wakes the lane for a timer that comes due with nothing else arriving: today the rotation's
    // per-round probe keeps the engine passing, and the due time it advertises at the end of a turn is the second path.
    // Without both, only the engine's idle backoff reaches the row, near 3 s; the 2 s ceiling tells the two apart. The
    // engine's own timers run on the fake clock, so the ceiling reads the engine's schedule, not the machine's speed.
    it.each(STORAGES)('on %s, a started engine runs the first renewal by itself, about a second after the gap', async (storage) => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(START_MS);
        const fixture = createRenewalFixture(storage);
        fixture.queueEngine.start();
        onTestFinished(async () => {
            await fixture.queueEngine.stop();
        });
        await fixture.runtime.ready();
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        while (renewedRanges(fixture, 2).length === 0 && Date.now() - START_MS <= 2_000) {
            await vi.advanceTimersByTimeAsync(ENGINE_STEP_MS);
            await yieldToStorage();
        }
        expect(renewedRanges(fixture, 2)).toEqual([[{ from: 1, to: 1 }], [{ from: 1, to: 1 }]]);
        expect(Date.now() - START_MS).toBeGreaterThanOrEqual(1_000);
        expect(Date.now() - START_MS).toBeLessThanOrEqual(2_000);
    });

    it('stops when the gap closes', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 500);
        await fixture.runtime.admitIncomingMessage(orderedMessage(1), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 29_000);
        expect(gapControls(fixture).map((control) => control.gapRequestNumber)).toEqual([1, 1]);
        expect(fixture.deliveredMessages.map((message) => message.id.msgId)).toEqual(['1', '2']);
        expect(await readPendingInboundWork(fixture)).toEqual([]);
    });

    it.each(STORAGES)('on %s, claims no timer before it is due and advertises its due time when its rotation passes it', async (storage) => {
        const fixture = createRenewalFixture(storage);
        const wakeAt = vi.spyOn(fixture.queueEngine, 'wakeAt');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 500);
        // The rotation reads one status per round; a full turn from NEW to RESERVED names the timer's due time.
        await expect.poll(async () => {
            await fixture.queueEngine.executeOnce();
            return wakeAt.mock.calls.some(([, readyAtMs]) => readyAtMs === START_MS + 1_000);
        }).toBe(true);
        expect(readRenewalClaims(fixture)).toEqual([]);
        await advanceTo(fixture, 1_000);
        expect(readRenewalClaims(fixture)).toEqual(['completed']);
    });

    it('a burst of later frames arms one timer', async () => {
        const fixture = createRenewalFixture('memory');
        for (const [seq, atMs] of [[2, 0], [3, 10], [4, 20], [5, 30]] as const) {
            await advanceTo(fixture, atMs);
            await fixture.runtime.admitIncomingMessage(orderedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceTo(fixture, 1_000);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 2)).toEqual([
            expect.objectContaining({ type: 'nack', missingRanges: [{ from: 1, to: 1 }] }),
            expect.objectContaining({ type: 'repair', missingRanges: [{ from: 1, to: 1 }] })
        ]);
    });

    it('two gaps of different ages are renewed each on its own schedule', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 800);
        await fixture.runtime.admitIncomingMessage(orderedMessage(5), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 1_000);
        expect(renewedRanges(fixture, 2)).toEqual([[{ from: 1, to: 1 }], [{ from: 1, to: 1 }]]);
        await advanceTo(fixture, 1_799);
        expect(renewedRanges(fixture, 2)).toHaveLength(2);
        await advanceTo(fixture, 1_800);
        expect(renewedRanges(fixture, 2).slice(2)).toEqual([[{ from: 3, to: 4 }], [{ from: 3, to: 4 }]]);
        await advanceTo(fixture, 3_000);
        expect(renewedRanges(fixture, 3)).toEqual([[{ from: 1, to: 1 }], [{ from: 1, to: 1 }]]);
    });

    it('a frame that is merely late draws no renewal', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 80);
        await fixture.runtime.admitIncomingMessage(orderedMessage(1), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 29_000);
        expect(gapControls(fixture).map((control) => control.gapRequestNumber)).toEqual([1, 1]);
    });

    it('a range that closes in part is renewed for the rest', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(5), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 500);
        await fixture.runtime.admitIncomingMessage(orderedMessage(1), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 1_000);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 2)).toEqual([
            expect.objectContaining({ type: 'nack', missingRanges: [{ from: 3, to: 4 }], expectedSeq: 3 }),
            expect.objectContaining({ type: 'repair', missingRanges: [{ from: 3, to: 4 }], expectedSeq: 3 })
        ]);
    });

    it('a later gap on the same track arms again', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(orderedMessage(1), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 10_000);
        await fixture.runtime.admitIncomingMessage(orderedMessage(9), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 10_999);
        expect(renewedRanges(fixture, 2)).toEqual([]);
        await advanceTo(fixture, 11_000);
        expect(renewedRanges(fixture, 2)).toEqual([[{ from: 3, to: 8 }], [{ from: 3, to: 8 }]]);
    });

    it('a stretched interval waits its factor', async () => {
        const fixture = createRenewalFixture('memory', { random: () => 0.5 });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 1_249);
        expect(renewedRanges(fixture, 2)).toEqual([]);
        await advanceTo(fixture, 1_250);
        expect(renewedRanges(fixture, 2)).toEqual([[{ from: 1, to: 1 }], [{ from: 1, to: 1 }]]);
    });

    it('a durable lane renews after a reload', async () => {
        const dbName = `gap-renewal-reload-${crypto.randomUUID()}`;
        const first = createRenewalFixture('indexeddb', { dbName });
        await first.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(first, 500);
        await first.runtime.dispose();
        const reloaded = createRenewalFixture('indexeddb', { dbName });
        await reloaded.runtime.ready();
        await advanceTo(reloaded, 1_000);
        expect(renewedRanges(reloaded, 2)).toEqual([[{ from: 1, to: 1 }], [{ from: 1, to: 1 }]]);
    });

    it('a volatile lane does not', async () => {
        const first = createRenewalFixture('memory');
        await first.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(first, 500);
        await first.runtime.dispose();
        // A memory pair lives and ends with its runtime: the next runtime starts over a pair of its own.
        const reloaded = createRenewalFixture('memory');
        await reloaded.runtime.ready();
        await advanceTo(reloaded, 29_000);
        expect(gapControls(first).map((control) => control.gapRequestNumber)).toEqual([1, 1]);
        expect(gapControls(reloaded)).toEqual([]);
    });

    it('a planned-again admission writes the timer once', async () => {
        const fixture = createRenewalFixture('memory');
        setNextInboundCommitConflicted(fixture.stores.admissionStore);
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 0);
        expect(await readRenewalDueTimes(fixture)).toEqual([START_MS + 1_000]);
    });

    it('a counted recipient\'s renewal NACK is signed over rtc', async () => {
        const fixture = createRenewalFixture('memory', { carrier: 'rtc', receiptProofs: SIGNED });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2, { ack: 'receiver' }), RTC_SOURCE);
        await advanceTo(fixture, 1_000);
        const renewal = readSentControls(fixture).find((msg) => {
            const control = decodeALPeerControlMessage(msg).right;
            return control?.type === 'nack' && control.payload.gapRequestNumber === 2;
        });
        expect(renewal).toBeDefined();
        expect(await verifyTestALReceiptControl(CRYPTO, renewal!)).toBe(true);
    });

    it('a timer run a lease recovery repeats writes nothing twice', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 500);
        const timer = (await readInboundTestWorkRows(fixture.stores)).find((effect) => effect.payload.kind === 'renew-gap');
        if (timer?.payload.kind !== 'renew-gap') {
            throw new Error('The gap admission armed no timer');
        }
        vi.setSystemTime(START_MS + 1_000);
        const renewal = new ALInboundGapRenewal({
            admissionStore: fixture.stores.admissionStore,
            workPort: createTestALInboundWorkPort({ ...fixture.stores, nowMs: Date.now, carrier: 'ws' }),
            clock: { nowMs: Date.now },
            orderingObserver: 'addressed',
            planIncomingMessage: planInboundTestMessage,
            effectPreparation: INBOUND_TEST_EFFECT_PREPARATION,
            stretch: 1,
            receiptProofs: { kind: 'carrier-authenticated' },
            diagnostics: undefined,
            effectWorkerId: 'al-inbound:gap-renewal-direct'
        });
        await renewal.renew(timer, timer.payload);
        const afterFirstRun = await readInboundTestWorkRows(fixture.stores);
        await renewal.renew(timer, timer.payload);
        expect(await readInboundTestWorkRows(fixture.stores)).toEqual(afterFirstRun);
        expect(afterFirstRun.map((effect) => effect.effectId).filter((effectId) => effectId.includes('renewal')))
            .toHaveLength(2);
    });

    it('a timer and its renewals expire with the message they name, not with a shorter durable-effect retention', async () => {
        const fixture = createRenewalFixture('memory', { retention: { durableEffectTtlMs: 500 } });
        const second = orderedMessage(2);
        await fixture.runtime.admitIncomingMessage(second, INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 1_000);
        expect(renewedRanges(fixture, 2)).toEqual([[{ from: 1, to: 1 }], [{ from: 1, to: 1 }]]);
        const renewalRows = (await readInboundTestWorkRows(fixture.stores)).filter((effect) =>
            effect.payload.kind === 'renew-gap' || effect.effectId.includes('renewal')
        );
        expect(renewalRows).toHaveLength(4);
        expect(renewalRows.map((effect) => effect.expireAtTimestamp)).toEqual(
            renewalRows.map(() => second.constraints?.expiresAtMs)
        );
    });

    it('a message with no deadline of its own under a durable-effect retention shorter than the first interval draws no renewal and leaves no work due', async () => {
        const fixture = createRenewalFixture('memory', { retention: { durableEffectTtlMs: 500 } });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2, { ttlMs: null }), INBOUND_TEST_SOURCE);
        expect(await readRenewalExpiries(fixture)).toEqual([START_MS + 500]);
        await advanceTo(fixture, 29_000);
        expect(renewedRanges(fixture, 2)).toEqual([]);
        expect(await readInboundTestWorkDueAtMs(fixture.stores.workQueue)).toBeUndefined();
    });

    it('no renewal follows the revealing message\'s deadline', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2, { ttlMs: 500 }), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 29_000);
        expect(renewedRanges(fixture, 2)).toEqual([]);
    });
});

describe('a receiver holding a recorded track at its start (the bounded hold)', () => {
    it.each(STORAGES)('on %s, enters at its lowest buffered copy when the last renewal falls due unanswered, at 7 s, delivering 2 then 3', async (storage) => {
        const fixture = createRenewalFixture(storage);
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000, 6_999]);
        expect(fixture.deliveredMessages).toEqual([]);
        expect(gapControls(fixture).map((control) => control.gapRequestNumber)).toEqual([1, 1, 1, 1, 2, 2, 3, 3]);

        await advanceTo(fixture, 7_000);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([2, 3]);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 4)).toEqual([]);
        expect(await readPendingInboundWork(fixture)).toEqual([]);
    });

    it('states one entered position for the copy it enters at, after its commit, as an entered admission states its own', async () => {
        const fixture = createRenewalFixture('memory');
        const workerId = `al-inbound:gap-renewal-${fixtureCount}`;
        const [second, third] = [recordedMessage(2), recordedMessage(3)];
        for (const message of [second, third]) {
            await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000, 6_999]);
        expect(readOrderingPositions(fixture)).toEqual([]);

        await advanceTo(fixture, 7_000);

        expect(readOrderingPositions(fixture)).toEqual([{
            kind: 'ordering-position',
            workerId,
            trackKey: toALOrderingTrackKey(second),
            seq: 2,
            priorSeq: 1,
            status: 'entered',
            carrier: 'ws',
            ...toALMessageTrace(second)
        }]);
    });

    it('states no position when every held copy expired and its end passes them', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq, { ttlMs: SHORT_TTL_MS }), INBOUND_TEST_SOURCE);
        }

        await advanceThrough(fixture, [1_000, 3_000, 7_000]);

        expect(await readPendingInboundWork(fixture)).toEqual([]);
        expect(readOrderingPositions(fixture)).toEqual([]);
    });

    it('refuses the late first copy as before its entry once the hold has ended', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000, 7_000]);

        await fixture.runtime.admitIncomingMessage(recordedMessage(1), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 7_000);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([2, 3]);
        expect(readNackReasons(fixture, '1')).toEqual(['before-entry']);
    });

    it('outlives a 5 s lifetime: with every held copy expired it passes them, sends no fourth request, and its next copy follows in order', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq, { ttlMs: SHORT_TTL_MS }), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000, 7_000]);
        expect(gapControls(fixture).map((control) => control.gapRequestNumber)).toEqual([1, 1, 1, 1, 2, 2, 3, 3]);

        await fixture.runtime.admitIncomingMessage(recordedMessage(4), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 7_000);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([4]);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 4)).toEqual([]);
    });

    it('enters at the lowest held copy still live when the copy that revealed the gap has expired', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(recordedMessage(2, { ttlMs: SHORT_TTL_MS }), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);

        await advanceThrough(fixture, [1_000, 3_000, 7_000]);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3]);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 4)).toEqual([]);
    });

    it('ends the hold at the maximum stretch even when the last timer is claimed after its due time', async () => {
        const fixture = createRenewalFixture('memory', { random: () => MAXIMUM_STRETCH_DRAW });
        await fixture.runtime.admitIncomingMessage(recordedMessage(2, { ttlMs: SHORT_TTL_MS }), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);

        await advanceThrough(fixture, [1_500, 4_500, 10_500 + LATE_CLAIM_MS]);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3]);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 4)).toEqual([]);
    });

    it('runs its last timer again when the end\'s commit is refused as expired, and then enters', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000]);
        const timer = (await readInboundTestWorkRows(fixture.stores))
            .find((effect) => effect.payload.kind === 'renew-gap' && effect.payload.requestNumber === 4);
        if (timer?.payload.kind !== 'renew-gap') {
            throw new Error('The schedule armed no last timer');
        }
        vi.setSystemTime(START_MS + 7_000);
        const admissionStore = fixture.stores.admissionStore;
        let refusals = 1;
        const renewal = new ALInboundGapRenewal({
            admissionStore: Object.assign(Object.create(admissionStore) as typeof admissionStore, {
                commitBundle: async (bundle: ALInboundCommitBundle) => {
                    refusals -= 1;
                    return refusals >= 0 ? 'expired' as const : await admissionStore.commitBundle(bundle);
                }
            }),
            workPort: createTestALInboundWorkPort({ ...fixture.stores, nowMs: Date.now, carrier: 'ws' }),
            clock: { nowMs: Date.now },
            orderingObserver: 'addressed',
            planIncomingMessage: planInboundTestMessage,
            effectPreparation: INBOUND_TEST_EFFECT_PREPARATION,
            stretch: 1,
            receiptProofs: { kind: 'carrier-authenticated' },
            diagnostics: undefined,
            effectWorkerId: 'al-inbound:gap-renewal-direct'
        });

        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'retry' }, wroteWork: false });
        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'completed' }, wroteWork: true });
        await advanceTo(fixture, 7_000);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([2, 3]);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 4)).toEqual([]);
    });

    it('passes an expired copy between live ones and releases the run past it', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(4, { ttlMs: SHORT_TTL_MS }), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(5), INBOUND_TEST_SOURCE);

        await advanceThrough(fixture, [1_000, 3_000, 7_000]);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3, 5]);
        expect(await readPendingInboundWork(fixture)).toEqual([]);
    });

    it('keeps asking, numbered 4, on a track that delivered something, and enters nowhere', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(recordedMessage(1), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);

        await advanceThrough(fixture, [1_000, 3_000, 7_000, 29_000]);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([1]);
        expect(renewedRanges(fixture, 4)).toEqual([[{ from: 2, to: 2 }], [{ from: 2, to: 2 }]]);
    });
});

function createRenewalFixture(storage: InboundTestStorage, input: RenewalFixtureInput = {}): InboundTestRuntime {
    fixtureCount += 1;
    return createInboundTestRuntime({
        stores: createInboundTestStores({
            namespace: 'gap-renewal',
            storage,
            observer: createPassThroughIndexedDbOperationObserver(),
            dbName: input.dbName,
            retention: input.retention
        }),
        carrier: input.carrier ?? 'ws',
        effectWorkerId: `al-inbound:gap-renewal-${fixtureCount}`,
        receiptProofs: input.receiptProofs,
        random: input.random ?? (() => 0)
    });
}

/** The sender's ordered room message at `seq`, at least once, frozen to this receiver. */
function orderedMessage(seq: number, input: OrderedMessageInput = {}): ALMessage {
    const message = newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: INBOUND_TEST_SENDER_PEER_ID,
        route: { topicId: 'chat', resourceId: String(seq), contextId: 'room' },
        groupRef: ROOM,
        typeId: 'chat.message.v1',
        resource: { text: String(seq) },
        options: { ack: input.ack ?? 'none', reliability: 'at-least-once', ttlMs: input.ttlMs === null ? undefined : input.ttlMs ?? 60_000 }
    });
    const frozen = toALFrozenMulticastMessage(
        { ...message, id: { ...message.id, msgId: String(seq) } },
        { recipientPeerIds: [INBOUND_TEST_SELF_PEER_ID], snapshotVersion: 1 }
    );
    return { ...frozen, ordering: { orderingKey: 'chat', seq } };
}

/** The same copy as its authority recorded it: this receiver, its frozen audience, was sent every sequence below. */
function recordedMessage(seq: number, input: OrderedMessageInput = {}): ALMessage {
    const message = orderedMessage(seq, input);
    return { ...message, ordering: { ...message.ordering!, priorSeqByRecipient: {} } };
}

/** The reasons of every NACK this receiver sent about the message `msgId`, in send order. */
function readNackReasons(fixture: InboundTestRuntime, msgId: string): readonly string[] {
    return readSentControls(fixture).flatMap((msg) => {
        const control = decodeALPeerControlMessage(msg).right;
        return control?.type === 'nack' && control.payload.msgId === msgId ? [control.payload.reason] : [];
    });
}

/**
 * Lets the engine's pass finish its IndexedDB requests before the fake clock moves on: the store schedules each step on
 * a real immediate, which the fake clock does not run. Counted in turns of the event loop, not in time.
 */
async function yieldToStorage(): Promise<void> {
    for (let turn = 0; turn < STORAGE_TURNS_PER_STEP; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

async function advanceTo(fixture: InboundTestRuntime, ms: number): Promise<void> {
    vi.setSystemTime(START_MS + ms);
    await runInboundWorkDueNow(fixture);
}

/** Runs the work due at each instant in turn, as the renewal schedule's own timers fall due. */
async function advanceThrough(fixture: InboundTestRuntime, instantsMs: readonly number[]): Promise<void> {
    for (const ms of instantsMs) {
        await advanceTo(fixture, ms);
    }
}

function readSentControls(fixture: InboundTestRuntime): readonly ALMessage[] {
    return fixture.controlSends.flat();
}

function gapControls(fixture: InboundTestRuntime): readonly GapControl[] {
    return readSentControls(fixture).flatMap((msg): GapControl[] => {
        const control = decodeALPeerControlMessage(msg).right;
        if (control?.type === 'nack' && control.payload.reason === 'gap') {
            return [toGapControl('nack', control.payload)];
        }
        return control?.type === 'repair' && control.payload.reason === 'missing-seq'
            ? [toGapControl('repair', control.payload)]
            : [];
    });
}

function toGapControl(
    type: GapControl['type'],
    payload: Readonly<{ gapRequestNumber?: number; missingRanges?: readonly ALSeqRange[]; msgId: string; expectedSeq?: number; }>
): GapControl {
    return {
        type,
        gapRequestNumber: payload.gapRequestNumber,
        missingRanges: payload.missingRanges,
        msgId: payload.msgId,
        expectedSeq: payload.expectedSeq
    };
}

function readOrderingPositions(fixture: InboundTestRuntime): readonly ALInboundRuntimeDiagnosticsEvent[] {
    return fixture.diagnostics.filter((event) => event.kind === 'ordering-position');
}

/** The outcome of each claim of a timer row, in claim order. */
function readRenewalClaims(fixture: InboundTestRuntime): readonly string[] {
    return fixture.diagnostics.flatMap((event) => event.kind === 'claim-settled' && event.payloadKind === 'renew-gap' ? [event.outcome] : []);
}

/** The ranges each control numbered `requestNumber` names, in send order. */
function renewedRanges(fixture: InboundTestRuntime, requestNumber: number): readonly (readonly ALSeqRange[] | undefined)[] {
    return gapControls(fixture)
        .filter((control) => control.gapRequestNumber === requestNumber)
        .map((control) => control.missingRanges);
}

/** The effect ids of every row the lane has still to run. */
async function readPendingInboundWork(fixture: InboundTestRuntime): Promise<readonly string[]> {
    return (await readInboundTestWorkRows(fixture.stores))
        .filter((effect) => NOT_COMPLETED_RETRYABLE_STATUSES.has(effect.entry.status))
        .map((effect) => effect.effectId);
}

async function readRenewalDueTimes(fixture: InboundTestRuntime): Promise<readonly number[]> {
    return (await readInboundTestWorkRows(fixture.stores))
        .filter((effect) => effect.payload.kind === 'renew-gap')
        .map((effect) => resolveALInboundWorkDueAtMs(effect.entry));
}

async function readRenewalExpiries(fixture: InboundTestRuntime): Promise<readonly number[]> {
    return (await readInboundTestWorkRows(fixture.stores))
        .filter((effect) => effect.payload.kind === 'renew-gap')
        .map((effect) => effect.expireAtTimestamp);
}

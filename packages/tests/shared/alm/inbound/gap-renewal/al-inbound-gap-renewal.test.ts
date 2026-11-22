import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';

import { newALMulticastMessage, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage, type ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import type { ALRuntimeStoreRetentionConfig } from '@shared/alm/ALStoreRetention.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { resolveALInboundWorkDueAtMs } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundGapRenewal } from '@shared/alm/inbound/gap-renewal/al-inbound-gap-renewal.ts';
import type { ALInboundReceiptProofs } from '@shared/alm/inbound/receipt-proof/sign-al-inbound-receipt-controls.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RtcReceiptProofSigner } from '@shared/multicast/receipt-proof/rtc-receipt-proof-signer.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';

import '../../../../setup-browser-indexeddb.ts';
import { verifyTestALReceiptControl } from '../../../../al-control-test-payloads.ts';
import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO
} from '../../../signature/publication-crypto-fixtures.ts';
import { readInboundTestWorkDueAtMs } from '../../../wait-for-al-inbound-work.ts';
import {
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_EFFECT_PREPARATION,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
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
/** Turns of the event loop each step gives the store, more than one engine pass needs. */
const STORAGE_TURNS_PER_STEP = 100;
const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room' };
const RTC_SOURCE: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID };
const CRYPTO = await createAvailablePublicationCryptoFixture();
const SIGNED: ALInboundReceiptProofs = { kind: 'signed', signer: new RtcReceiptProofSigner({ crypto: CRYPTO }) };
/** A page whose WebCrypto holds no key: every signature it tries fails. */
const UNSIGNABLE: ALInboundReceiptProofs = {
    kind: 'signed',
    signer: new RtcReceiptProofSigner({ crypto: UNAVAILABLE_PUBLICATION_CRYPTO })
};

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
    /** Absent, no upstream peer resolves, as on a runtime with no overlay. */
    readonly readUpstreamPeerId?: ALInboundMessageRuntime.Dependencies['readUpstreamPeerId'];
    /** Absent, the lane routes over no layout. */
    readonly isRoutedPeerReady?: ALInboundMessageRuntime.Dependencies['isRoutedPeerReady'];
}

/** How a timer run is composed outside its lane: which upstream peer resolves, and whether the revealing message is kept. */
interface DirectRenewalInput {
    readonly readUpstreamPeerId: ALInboundMessageRuntime.Dependencies['readUpstreamPeerId'];
    readonly keepsRevealingMessage: boolean;
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

    it('an unreceipted track\'s gap NACK and its renewal are signed over rtc (ruling 19)', async () => {
        const fixture = createRenewalFixture('memory', { carrier: 'rtc', receiptProofs: SIGNED });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), RTC_SOURCE);
        await advanceTo(fixture, 1_000);
        const nacks = readGapNacks(fixture);

        expect(nacks.map((nack) => nack.gapRequestNumber)).toEqual([1, 2]);
        expect(await Promise.all(nacks.map(async (nack) => await verifyTestALReceiptControl(CRYPTO, nack.msg)))).toEqual([true, true]);
    });

    it('a page that cannot sign sends an unreceipted track\'s gap NACK and its renewal unsigned (ruling 19)', async () => {
        const fixture = createRenewalFixture('memory', { carrier: 'rtc', receiptProofs: UNSIGNABLE });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), RTC_SOURCE);
        await advanceTo(fixture, 1_000);

        expect(readGapNacks(fixture).map((nack) => [nack.gapRequestNumber, nack.proof])).toEqual([[1, null], [2, null]]);
    });

    it('a page that cannot sign leaves out a counted recipient\'s gap NACK and its renewal, as before', async () => {
        const fixture = createRenewalFixture('memory', { carrier: 'rtc', receiptProofs: UNSIGNABLE });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2, { ack: 'receiver' }), RTC_SOURCE);
        await advanceTo(fixture, 1_000);

        expect(readGapNacks(fixture)).toEqual([]);
        expect(gapControls(fixture).map((control) => [control.type, control.gapRequestNumber])).toEqual([['repair', 1], ['repair', 2]]);
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
            effectPreparation: INBOUND_TEST_EFFECT_PREPARATION,
            stretch: 1,
            receiptProofs: { kind: 'carrier-authenticated' },
            diagnostics: undefined,
            readUpstreamPeerId: () => undefined
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

describe('a renewal of a gap whose upstream peer has changed since it was first reported (6d)', () => {
    /** The peer the gap was first reported to: the sender the revealing arrival came from. */
    const RECORDED_PEER_ID = INBOUND_TEST_SENDER_PEER_ID;

    it('asks the upstream peer that resolves when it fires, and arms the next number toward the recorded peer as before', async () => {
        const fixture = createRenewalFixture('memory', { readUpstreamPeerId: () => 'p2' });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 1_000);

        expect(readGapTargets(readSentControls(fixture))).toEqual([
            ['nack', 1, RECORDED_PEER_ID],
            ['repair', 1, RECORDED_PEER_ID],
            ['nack', 2, 'p2'],
            ['repair', 2, 'p2']
        ]);
        expect(await readRenewalTimer(fixture, 3)).toEqual({ toPeerId: RECORDED_PEER_ID, dueAtMs: START_MS + 3_000 });
    });

    it('keeps asking the recorded peer while the lane still routes over it, though another upstream peer resolves', async () => {
        const fixture = createRenewalFixture('memory', {
            readUpstreamPeerId: () => 'p2',
            isRoutedPeerReady: (_msg, peerId) => peerId === RECORDED_PEER_ID
        });
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 1_000);

        expect(readGapTargets(readSentControls(fixture)).filter(([, number]) => number === 2)).toEqual([
            ['nack', 2, RECORDED_PEER_ID],
            ['repair', 2, RECORDED_PEER_ID]
        ]);
    });

    it.each<[string, DirectRenewalInput]>([
        ['no upstream peer resolves', { readUpstreamPeerId: () => undefined, keepsRevealingMessage: true }],
        ['the revealing message is no longer kept', { readUpstreamPeerId: () => 'p2', keepsRevealingMessage: false }]
    ])('asks the recorded peer and still arms the next number when %s', async (_case, input) => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 500);
        const timer = await readFirstRenewalTimer(fixture);
        vi.setSystemTime(START_MS + 1_000);

        const result = await createDirectRenewal(fixture, input).renew(timer, timer.payload);

        expect(result).toEqual({ outcome: { status: 'completed' }, wroteWork: true });
        expect(readGapTargets(await readRetainedRenewalControls(fixture))).toEqual([
            ['nack', 2, RECORDED_PEER_ID],
            ['repair', 2, RECORDED_PEER_ID]
        ]);
        expect(await readRenewalTimer(fixture, 3)).toEqual({ toPeerId: RECORDED_PEER_ID, dueAtMs: START_MS + 3_000 });
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
        random: input.random ?? (() => 0),
        readUpstreamPeerId: input.readUpstreamPeerId,
        isRoutedPeerReady: input.isRoutedPeerReady
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

function readSentControls(fixture: InboundTestRuntime): readonly ALMessage[] {
    return fixture.controlSends.flat();
}

/** Each gap NACK this receiver sent, as sent: its number, its proof and the message that carried it. */
function readGapNacks(
    fixture: InboundTestRuntime
): readonly Readonly<{ gapRequestNumber: number | undefined; proof: ALNackPayload['proof']; msg: ALMessage; }>[] {
    return readSentControls(fixture).flatMap((msg) => {
        const control = decodeALPeerControlMessage(msg).right;
        return control?.type === 'nack' && control.payload.reason === 'gap'
            ? [{ gapRequestNumber: control.payload.gapRequestNumber, proof: control.payload.proof, msg }]
            : [];
    });
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

/** Each gap control as its type, its request number and the peer it is addressed to, in send order. */
function readGapTargets(controls: readonly ALMessage[]): readonly (readonly [string, number | undefined, string])[] {
    return controls.flatMap((msg): (readonly [string, number | undefined, string])[] => {
        const control = decodeALPeerControlMessage(msg).right;
        return control?.type === 'nack' || control?.type === 'repair'
            ? [[control.type, control.payload.gapRequestNumber, control.payload.toPeerId]]
            : [];
    });
}

/** The renewal controls a timer run retained, which its lane has not sent: the run here is outside the lane. */
async function readRetainedRenewalControls(fixture: InboundTestRuntime): Promise<readonly ALMessage[]> {
    return (await readInboundTestWorkRows(fixture.stores)).flatMap((effect) =>
        effect.payload.kind === 'send-control' && effect.effectId.includes('renewal') ? [effect.payload.msg] : []
    );
}

/** The timer numbered `requestNumber`, as the peer it records and when it is due; undefined when none is armed. */
async function readRenewalTimer(fixture: InboundTestRuntime, requestNumber: number) {
    const timer = (await readInboundTestWorkRows(fixture.stores)).find((effect) =>
        effect.payload.kind === 'renew-gap' && effect.payload.requestNumber === requestNumber
    );
    return timer?.payload.kind === 'renew-gap'
        ? { toPeerId: timer.payload.toPeerId, dueAtMs: resolveALInboundWorkDueAtMs(timer.entry) }
        : undefined;
}

async function readFirstRenewalTimer(fixture: InboundTestRuntime) {
    const timer = (await readInboundTestWorkRows(fixture.stores)).find((effect) => effect.payload.kind === 'renew-gap');
    if (timer?.payload.kind !== 'renew-gap') {
        throw new Error('The gap admission armed no timer');
    }
    return { ...timer, payload: timer.payload };
}

/** A timer run over the fixture's stores, composed as its lane composes it except for the dependencies `input` names. */
function createDirectRenewal(fixture: InboundTestRuntime, input: DirectRenewalInput): ALInboundGapRenewal {
    const { admissionStore } = fixture.stores;
    return new ALInboundGapRenewal({
        admissionStore: {
            namespace: admissionStore.namespace,
            readOrderingSnapshot: async (trackKey, nowMs) => await admissionStore.readOrderingSnapshot(trackKey, nowMs),
            readDeliverySurface: async (reference, nowMs) =>
                input.keepsRevealingMessage ? await admissionStore.readDeliverySurface(reference, nowMs) : undefined
        },
        workPort: createTestALInboundWorkPort({ ...fixture.stores, nowMs: Date.now, carrier: 'ws' }),
        clock: { nowMs: Date.now },
        effectPreparation: INBOUND_TEST_EFFECT_PREPARATION,
        stretch: 1,
        receiptProofs: { kind: 'carrier-authenticated' },
        diagnostics: undefined,
        readUpstreamPeerId: input.readUpstreamPeerId
    });
}

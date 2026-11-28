import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';

import { newALMulticastMessage, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage, type ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { AL_GAP_NACK_RELAY_HOP_LIMIT } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey, type ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import { toALMessageTrace } from '@shared/al-contracts/trace/to-al-message-trace.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import type { ALRuntimeStoreRetentionConfig } from '@shared/alm/ALStoreRetention.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundGapRenewalEffect
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALInboundMessageKey, toALInboundMessageReference } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import { toALInboundLocalDeliveryEffectId, toALInboundReleaseEffectId } from '@shared/alm/inbound/al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALPersistedInboundEffect } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundGapRenewal } from '@shared/alm/inbound/gap-renewal/al-inbound-gap-renewal.ts';
import type { ALInboundReceiptProofs } from '@shared/alm/inbound/receipt-proof/sign-al-inbound-receipt-controls.ts';
import { resolveALWorkEntryDueAtMs } from '@shared/alm/work/read-al-work-ready-at.ts';
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
    createInboundTestBackendStores,
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
    type CreateInboundTestRuntimeInput,
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
/** A copy lifetime that ends after the last timer's read at 7 s and before its commit. */
const COPY_EXPIRING_AT_END_TTL_MS = 7_050;
/** Turns of the event loop each step gives the store, more than one engine pass needs. */
const STORAGE_TURNS_PER_STEP = 100;
const RENEWAL_NAMESPACE = 'gap-renewal';
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
    /** Absent, every gap NACK is granted the wire limit, as on a runtime with no overlay. */
    readonly readGapNackRelayHops?: ALInboundMessageRuntime.Dependencies['readGapNackRelayHops'];
    /** Absent, the fixture opens its own stores over `storage`. */
    readonly stores?: ALInboundRuntimeStores;
    /** Absent, every message is dispatched as soon as it is released. */
    readonly canDispatchMessage?: (msg: ALMessage) => boolean;
    /** Absent leaves the policy's plan as it stands. */
    readonly plan?: CreateInboundTestRuntimeInput['plan'];
    /** Absent verifies no publication proof. */
    readonly verifyPublicationProof?: CreateInboundTestRuntimeInput['verifyPublicationProof'];
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

    it.each(['none', 'receiver'] as const)(
        'a %s track\'s gap NACK and its renewal each grant the relay hops its room\'s live sessions allow then (ruling 20)',
        async (ack) => {
            // An 8-session room grants 7; a session leaves before the renewal, which grants 6.
            const relayHopsBySession = [7, 6];
            const fixture = createRenewalFixture('memory', {
                carrier: 'rtc',
                receiptProofs: SIGNED,
                readGapNackRelayHops: () => relayHopsBySession[0]!
            });
            await fixture.runtime.admitIncomingMessage(orderedMessage(2, { ack }), RTC_SOURCE);
            relayHopsBySession.shift();
            await advanceTo(fixture, 1_000);
            const relayHops = readSentControls(fixture).flatMap((msg) => {
                const control = decodeALPeerControlMessage(msg).right;
                return control?.type === 'nack' ? [[control.payload.gapRequestNumber, control.payload.relayHopsLeft]] : [];
            });

            expect(relayHops).toEqual([[1, 7], [2, 6]]);
        }
    );

    it('reads the room\'s sessions only to build a gap NACK: never for an admission or an ordered release with no gap (ruling 20)', async () => {
        let sessionReads = 0;
        const fixture = createRenewalFixture('memory', {
            readGapNackRelayHops: () => {
                sessionReads += 1;
                return 7;
            }
        });
        await fixture.runtime.admitIncomingMessage(orderedMessage(1), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 100);
        const afterInOrderAdmission = sessionReads;
        await fixture.runtime.admitIncomingMessage(orderedMessage(3), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 200);
        const afterGap = sessionReads;
        // Seq 2 closes the gap before the first renewal is due, and releases the buffered seq 3 in order.
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 300);

        expect(fixture.deliveredMessages.map((message) => message.id.msgId)).toEqual(['1', '2', '3']);
        expect([afterInOrderAdmission, afterGap, sessionReads]).toEqual([0, 1, 1]);
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
        const { renewal } = createDirectRenewal(fixture, {});
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

    it.each<[string, DirectRenewalStore, DirectRenewalPlanning]>([
        ['no upstream peer resolves', {}, { readUpstreamPeerId: () => undefined }],
        ['the revealing message is no longer kept', { readDeliverySurface: async () => undefined }, { readUpstreamPeerId: () => 'p2' }]
    ])('asks the recorded peer and still arms the next number when %s', async (_case, store, planning) => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(orderedMessage(2), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 500);
        const timer = await readFirstRenewalTimer(fixture);
        vi.setSystemTime(START_MS + 1_000);

        const result = await createDirectRenewal(fixture, store, planning).renewal.renew(timer, timer.payload);

        expect(result).toEqual({ outcome: { status: 'completed' }, wroteWork: true });
        expect(readGapTargets(await readRetainedRenewalControls(fixture))).toEqual([
            ['nack', 2, RECORDED_PEER_ID],
            ['repair', 2, RECORDED_PEER_ID]
        ]);
        expect(await readRenewalTimer(fixture, 3)).toEqual({ toPeerId: RECORDED_PEER_ID, dueAtMs: START_MS + 3_000 });
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

    // A carrier whose planner reads a proof verdict per message object (a signed receipted RTC room copy, #887) plans a
    // copy no one verified as unauthorized: the hold's end verifies each copy it plans, as an admission and a release do.
    it('verifies the copy it enters at before planning it, as a carrier that signs its copies needs, and states the entry', async () => {
        const verified = new WeakSet<ALMessage>();
        const fixture = createRenewalFixture('memory', {
            verifyPublicationProof: async (msg) => {
                verified.add(msg);
                return true;
            },
            plan: (plan, msg) => verified.has(msg) ? plan : { ...plan, dropReason: 'unauthorized' }
        });
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }

        await advanceThrough(fixture, [1_000, 3_000, 7_000]);

        expect(readOrderingPositions(fixture)).toMatchObject([{ status: 'entered', seq: 2, priorSeq: 1 }]);
        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([2, 3]);
    });

    it('commits no end, states nothing and sends the last request when the copy it would enter at cannot be verified', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000]);
        const timer = await readLastRenewalTimer(fixture);
        vi.setSystemTime(START_MS + 7_000);
        const commits: ALInboundCommitBundle[] = [];
        const refused = new Set<ALMessage>();
        const admissionStore = fixture.stores.admissionStore;
        const { renewal, diagnostics } = createDirectRenewal(fixture, {
            commitBundle: async (bundle) => {
                commits.push(bundle);
                return await admissionStore.commitBundle(bundle);
            }
        }, {
            verifyPublicationProof: async (msg) => {
                refused.add(msg);
                return false;
            },
            // As the RTC carrier plans a signed copy: dropped exactly where its verification resolved false.
            planIncomingMessage: (msg, source, observations) => {
                const plan = planInboundTestMessage(msg, source, observations);
                return refused.has(msg) ? { ...plan, dropReason: 'unauthorized' } : plan;
            }
        });

        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'completed' }, wroteWork: true });

        expect(refused.size).toBe(1);
        expect(commits).toEqual([]);
        expect(diagnostics.filter((event) => event.kind === 'ordering-position')).toEqual([]);
        expect((await admissionStore.readOrderingSnapshot(timer.payload.trackKey, Date.now()))?.lastContiguousSeq).toBe(0);
        expect((await readInboundTestWorkRows(fixture.stores)).map((effect) => effect.effectId))
            .toEqual(expect.arrayContaining([expect.stringMatching(/^nack:.*:renewal:1:1:4/)]));
    });

    it('commits no end, states nothing and runs the timer again when the copy it would enter at may not be delivered yet', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000]);
        const timer = await readLastRenewalTimer(fixture);
        vi.setSystemTime(START_MS + 7_000);
        const commits: ALInboundCommitBundle[] = [];
        const admissionStore = fixture.stores.admissionStore;
        const { renewal, diagnostics } = createDirectRenewal(fixture, {
            commitBundle: async (bundle) => {
                commits.push(bundle);
                return await admissionStore.commitBundle(bundle);
            }
        }, {
            // The entry's plan, the one planned with an ordering observation, waits on its hop's sync.
            planIncomingMessage: (msg, source, observations) => {
                const plan = planInboundTestMessage(msg, source, observations);
                return observations?.orderingObservation === undefined
                    ? plan
                    : { ...plan, dropReason: 'not yet in sync', dropReasonCode: 'not-yet-in-sync' };
            }
        });

        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'retry' }, wroteWork: false });

        expect(commits).toEqual([]);
        expect(diagnostics.filter((event) => event.kind === 'ordering-position')).toEqual([]);
        expect((await admissionStore.readOrderingSnapshot(timer.payload.trackKey, Date.now()))?.lastContiguousSeq).toBe(0);
        expect((await readInboundTestWorkRows(fixture.stores)).map((effect) => effect.effectId))
            .not.toEqual(expect.arrayContaining([expect.stringMatching(/^nack:.*:renewal:1:1:4/)]));
    });

    it('commits the very copy it verified and planned, in the entered slot of its bundle', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [2, 3]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000]);
        const timer = await readLastRenewalTimer(fixture);
        vi.setSystemTime(START_MS + 7_000);
        const verified = new Set<ALMessage>();
        const planned = new Set<ALMessage>();
        const commits: ALInboundCommitBundle[] = [];
        const admissionStore = fixture.stores.admissionStore;
        const { renewal, diagnostics } = createDirectRenewal(fixture, {
            // A durable store decodes each row into its own object: the track's copies are not the copy read for itself.
            readIncomingMessage: async (input) => {
                const read = await admissionStore.readIncomingMessage(input);
                const ordering = read.observations.ordering;
                const decoded = ordering?.buffered.map((buffered) => ({ ...buffered, msg: { ...buffered.msg, id: { ...buffered.msg.id } } }));
                return ordering === undefined || decoded === undefined ? read : {
                    ...read,
                    bufferedSnapshots: decoded,
                    observations: { ...read.observations, ordering: { ...ordering, buffered: decoded } }
                };
            },
            commitBundle: async (bundle) => {
                commits.push(bundle);
                return await admissionStore.commitBundle(bundle);
            }
        }, {
            verifyPublicationProof: async (msg) => {
                verified.add(msg);
                return true;
            },
            planIncomingMessage: (msg, source, observations) => {
                planned.add(msg);
                return planInboundTestMessage(msg, source, observations);
            }
        });

        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'completed' }, wroteWork: true });

        const entered = commits.flatMap((bundle) => bundle.mutations)
            .flatMap((mutation) => mutation.kind === 'set-buffered' && mutation.snapshot.seq === 2 ? [mutation.snapshot.msg] : []);
        expect(entered).toHaveLength(1);
        expect(verified.has(entered[0]!)).toBe(true);
        expect([...planned].every((msg) => verified.has(msg))).toBe(true);
        expect(diagnostics.filter((event) => event.kind === 'ordering-position')).toMatchObject([{ status: 'entered', seq: 2 }]);
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

    it('retains the copy that revealed the start range for its own lifetime only, and its timer still ends the hold', async () => {
        const { backend, stores } = createInboundTestBackendStores({
            namespace: RENEWAL_NAMESPACE,
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const fixture = createRenewalFixture('memory', { stores });
        const second = recordedMessage(2, { ttlMs: SHORT_TTL_MS });
        await fixture.runtime.admitIncomingMessage(second, INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);
        const reference = toALInboundMessageReference(second);

        expect(readRowExpiry(backend, toALInboundMessageKey(RENEWAL_NAMESPACE, reference))).toBe(second.constraints?.expiresAtMs);
        await advanceThrough(fixture, [1_000, 3_000, 7_000]);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3]);
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

    // A commit refused as `conflict` is also what a PostgreSQL commit answers when another writer deleted a buffered
    // copy's rows between its reads of them.
    for (const refusal of ['expired', 'conflict'] as const) {
        it(`runs its last timer again when the end's commit is refused as ${refusal}, and then enters`, async () => {
            const fixture = createRenewalFixture('memory');
            for (const seq of [2, 3]) {
                await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
            }
            await advanceThrough(fixture, [1_000, 3_000]);
            const timer = await readLastRenewalTimer(fixture);
            vi.setSystemTime(START_MS + 7_000);
            const admissionStore = fixture.stores.admissionStore;
            let refusals = 1;
            const { renewal, diagnostics } = createDirectRenewal(fixture, {
                commitBundle: async (bundle) => {
                    refusals -= 1;
                    return refusals >= 0 ? refusal : await admissionStore.commitBundle(bundle);
                }
            });

            expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'retry' }, wroteWork: false });
            expect(diagnostics.filter((event) => event.kind === 'ordering-position')).toEqual([]);
            expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'completed' }, wroteWork: true });
            expect(diagnostics.filter((event) => event.kind === 'ordering-position')).toMatchObject([{ status: 'entered', seq: 2 }]);
            await advanceTo(fixture, 7_000);

            expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([2, 3]);
            expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 4)).toEqual([]);
        });
    }

    // The retry reads the track's live copies again: a buffered slot is written with its message's own expiry, and every
    // later rewrite of it takes a release row's, which is that expiry too, so a copy whose message expired is not live.
    it('reads a copy that expired between the end\'s read and its commit as no longer live on the retry, and enters past it', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(recordedMessage(2, { ttlMs: COPY_EXPIRING_AT_END_TTL_MS }), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);
        await advanceThrough(fixture, [1_000, 3_000]);
        const timer = await readLastRenewalTimer(fixture);
        vi.setSystemTime(START_MS + 7_000);
        const admissionStore = fixture.stores.admissionStore;
        const { renewal } = createDirectRenewal(fixture, {
            commitBundle: async (bundle) => {
                vi.setSystemTime(START_MS + COPY_EXPIRING_AT_END_TTL_MS + LATE_CLAIM_MS);
                return await admissionStore.commitBundle(bundle);
            }
        });

        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'retry' }, wroteWork: false });
        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'completed' }, wroteWork: true });
        await advanceTo(fixture, COPY_EXPIRING_AT_END_TTL_MS + LATE_CLAIM_MS);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3]);
        expect(gapControls(fixture).filter((control) => control.gapRequestNumber === 4)).toEqual([]);
    });

    it('runs again when a lower copy is buffered between the track\'s read and the read of its lowest copy, which the hold then enters at', async () => {
        const fixture = createRenewalFixture('memory');
        for (const seq of [3, 4]) {
            await fixture.runtime.admitIncomingMessage(recordedMessage(seq), INBOUND_TEST_SOURCE);
        }
        await advanceThrough(fixture, [1_000, 3_000]);
        const timer = await readLastRenewalTimer(fixture);
        vi.setSystemTime(START_MS + 7_000);
        const admissionStore = fixture.stores.admissionStore;
        let lowerArrived = false;
        const { renewal } = createDirectRenewal(fixture, {
            readIncomingMessage: async (input) => {
                if (!lowerArrived) {
                    lowerArrived = true;
                    await fixture.runtime.admitIncomingMessage(recordedMessage(2), INBOUND_TEST_SOURCE);
                }
                return await admissionStore.readIncomingMessage(input);
            }
        });

        expect(await renewal.renew(timer, timer.payload)).toEqual({ outcome: { status: 'retry' }, wroteWork: false });
        // The lane's own run of the same timer, due now, ends the hold at the lower copy.
        await advanceTo(fixture, 7_000);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([2, 3, 4]);
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

    it('passes an expired copy after the released run, so only the sequence never received stays missing, and delivers it and its successor when it arrives', async () => {
        const fixture = createRenewalFixture('memory');
        await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(4, { ttlMs: SHORT_TTL_MS }), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(recordedMessage(6), INBOUND_TEST_SOURCE);
        await advanceThrough(fixture, [1_000, 3_000, 7_000]);
        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3]);
        const askedBefore = gapControls(fixture).length;

        await fixture.runtime.admitIncomingMessage(recordedMessage(5), INBOUND_TEST_SOURCE);
        await advanceTo(fixture, 7_000);

        expect(gapControls(fixture).slice(askedBefore)).toEqual([]);
        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3, 5, 6]);
        expect(['5', '6'].flatMap((msgId) => readNackReasons(fixture, msgId))).not.toContain('resync-required');
        expect(await readPendingInboundWork(fixture)).toEqual([]);
    });

    it('waits for the run\'s last delivery when the sequence after the passed copies arrives before it completed', async () => {
        const { fixture, askedBefore, releaseThird } = await admitPastPassedCopiesBehindHeldThird();
        expect(fixture.deliveredMessages).toEqual([]);
        releaseThird();
        await advanceThrough(fixture, [8_000, 10_000]);

        expect(gapControls(fixture).slice(askedBefore)).toEqual([]);
        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3, 5, 6]);
        expect(['5', '6'].flatMap((msgId) => readNackReasons(fixture, msgId))).not.toContain('resync-required');
        expect(await readPendingInboundWork(fixture)).toEqual([]);
    });

    // Pins a hand-on after a completion that moves its track past several sequences: the run's last delivery (3) reaches
    // past the passed copy (4), so its completion states 4, the slot read at 5 names message 5's row, and the batch
    // that ran 3 hands on 5 and then 6, where a read at 3's own sequence plus one would find no slot.
    it('hands on the message after the passed copies in the batch that completed the run\'s last delivery', async () => {
        const { fixture, releaseThird } = await admitPastPassedCopiesBehindHeldThird();
        const before = fixture.diagnostics.length;
        releaseThird();

        await advanceThrough(fixture, [8_000, 10_000]);

        expect(fixture.deliveredMessages.map((message) => message.ordering?.seq)).toEqual([3, 5, 6]);
        const drains = fixture.diagnostics.slice(before).flatMap((event) => event.kind === 'effect-drain' && event.claimedCount > 0 ? [event] : []);
        const trackKey = toALOrderingTrackKey(recordedMessage(3))!;
        expect(drains.map((drain) => [drain.claimedEffectIds, drain.promoted])).toEqual([[
            [
                toALInboundReleaseEffectId(trackKey, 3),
                toALInboundLocalDeliveryEffectId(recordedMessage(5), false),
                toALInboundReleaseEffectId(trackKey, 6)
            ],
            2
        ]]);
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
        stores: input.stores ?? createInboundTestStores({
            namespace: RENEWAL_NAMESPACE,
            storage,
            observer: createPassThroughIndexedDbOperationObserver(),
            dbName: input.dbName,
            retention: input.retention
        }),
        carrier: input.carrier ?? 'ws',
        effectWorkerId: `al-inbound:gap-renewal-${fixtureCount}`,
        receiptProofs: input.receiptProofs,
        canDispatchMessage: input.canDispatchMessage,
        plan: input.plan,
        verifyPublicationProof: input.verifyPublicationProof,
        random: input.random ?? (() => 0),
        readUpstreamPeerId: input.readUpstreamPeerId,
        isRoutedPeerReady: input.isRoutedPeerReady,
        readGapNackRelayHops: input.readGapNackRelayHops
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

interface PassedCopiesBehindHeldThird {
    readonly fixture: InboundTestRuntime;
    /** The gap controls sent before message 5 arrived. */
    readonly askedBefore: number;
    /** Lets message 3's delivery read ready. */
    readonly releaseThird: () => void;
}

/**
 * Recorded copies 3, 4 (short-lived) and 6 with message 3 held at its readiness, run until 4 has passed, then 5, run
 * again at 7 s: message 3 is the run's last delivery, still undelivered, and 5 and 6 wait behind it.
 */
async function admitPastPassedCopiesBehindHeldThird(): Promise<PassedCopiesBehindHeldThird> {
    let thirdHeld = true;
    const fixture = createRenewalFixture('memory', {
        canDispatchMessage: (msg) => !thirdHeld || msg.ordering?.seq !== 3
    });
    await fixture.runtime.admitIncomingMessage(recordedMessage(3), INBOUND_TEST_SOURCE);
    await fixture.runtime.admitIncomingMessage(recordedMessage(4, { ttlMs: SHORT_TTL_MS }), INBOUND_TEST_SOURCE);
    await fixture.runtime.admitIncomingMessage(recordedMessage(6), INBOUND_TEST_SOURCE);
    await advanceThrough(fixture, [1_000, 3_000, 7_000]);
    const askedBefore = gapControls(fixture).length;
    await fixture.runtime.admitIncomingMessage(recordedMessage(5), INBOUND_TEST_SOURCE);
    await advanceTo(fixture, 7_000);
    return {
        fixture,
        askedBefore,
        releaseThird: () => {
            thirdHeld = false;
        }
    };
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

/** The start range's last timer, armed by the run at 3 s. */
async function readLastRenewalTimer(
    fixture: InboundTestRuntime
): Promise<ALPersistedInboundEffect & { readonly payload: ALInboundGapRenewalEffect; }> {
    const timer = (await readInboundTestWorkRows(fixture.stores))
        .find((effect) => effect.payload.kind === 'renew-gap' && effect.payload.requestNumber === 4);
    if (timer?.payload.kind !== 'renew-gap') {
        throw new Error('The schedule armed no last timer');
    }
    return { ...timer, payload: timer.payload };
}

/** A renewal over the fixture's stores, with `store`'s reads and commits in place of theirs, and the events it states. */
interface DirectRenewal {
    readonly renewal: ALInboundGapRenewal;
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
}

/** The admission-store reads and commits a direct renewal replaces. */
type DirectRenewalStore = Partial<Pick<ALInboundAdmissionStore, 'commitBundle' | 'readIncomingMessage' | 'readDeliverySurface'>>;

/** The dependencies a direct renewal replaces; absent, no upstream peer resolves and the lane routes over no layout. */
type DirectRenewalPlanning = Partial<Pick<ALInboundGapRenewal.Dependencies, 'planIncomingMessage' | 'verifyPublicationProof' | 'readUpstreamPeerId'>>;

function createDirectRenewal(
    fixture: InboundTestRuntime,
    store: DirectRenewalStore,
    planning: DirectRenewalPlanning = {}
): DirectRenewal {
    const admissionStore = fixture.stores.admissionStore;
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const renewal = new ALInboundGapRenewal({
        admissionStore: Object.assign(Object.create(admissionStore) as typeof admissionStore, store),
        workPort: createTestALInboundWorkPort({ ...fixture.stores, nowMs: Date.now, carrier: 'ws' }),
        clock: { nowMs: Date.now },
        orderingObserver: 'addressed',
        planIncomingMessage: planInboundTestMessage,
        effectPreparation: INBOUND_TEST_EFFECT_PREPARATION,
        stretch: 1,
        receiptProofs: { kind: 'carrier-authenticated' },
        diagnostics: (event) => {
            diagnostics.push(event);
        },
        effectWorkerId: 'al-inbound:gap-renewal-direct',
        readUpstreamPeerId: () => undefined,
        readGapNackRelayHops: () => AL_GAP_NACK_RELAY_HOP_LIMIT,
        isRoutedPeerReady: () => false,
        ...planning
    });
    return { renewal, diagnostics };
}

/** When the memory backend drops a row, read without expiring it. */
function readRowExpiry(backend: ALAdmissionWorkBackend, key: string): number | undefined {
    return backend instanceof InMemoryAdmissionBackend ? backend.peek(key)?.expireAtTimestamp : undefined;
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
        .map((effect) => resolveALWorkEntryDueAtMs(effect.entry));
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
        ? { toPeerId: timer.payload.toPeerId, dueAtMs: resolveALWorkEntryDueAtMs(timer.entry) }
        : undefined;
}

async function readFirstRenewalTimer(fixture: InboundTestRuntime) {
    const timer = (await readInboundTestWorkRows(fixture.stores)).find((effect) => effect.payload.kind === 'renew-gap');
    if (timer?.payload.kind !== 'renew-gap') {
        throw new Error('The gap admission armed no timer');
    }
    return { ...timer, payload: timer.payload };
}

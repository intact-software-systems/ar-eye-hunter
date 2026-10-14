import '../../../setup-browser-indexeddb.ts';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { AL_INBOUND_WORK_PAGE_SIZE } from '@shared/alm/inbound/read-al-inbound-work-selection.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    type CreateInboundTestRuntimeInput,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

type EffectDrain = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;

/**
 * Measured on the in-memory runtime: the batch that delivers seq 1 promotes nothing (seq 1 is a
 * dispatch, not a release), and each later batch runs the release its page cleared plus the 15
 * successors it promotes. One release per batch took 65 batches here before promotion.
 */
const BUFFERED_64_DRAIN_BATCHES = 5;
const BUFFERED_64_PROMOTED_PER_BATCH = [0, 15, 15, 15, 15];
const DRAIN_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

describe('promotion of a buffered track\'s next release', () => {
    it('delivers a buffered track in sequence order, each release promoted only after its predecessor delivered', async () => {
        const deliveredSeqs: (number | undefined)[] = [];
        const fixture = await startInboundRuntime('promotion-order', {
            gateDispatch: async (msg) => {
                deliveredSeqs.push(msg.ordering?.seq);
            }
        });

        const drains = await admitBufferedTrack(fixture, { buffered: 20 });

        expect(deliveredSeqs).toEqual(toSequence(1, 21));
        expect(sumPromoted(drains)).toBeGreaterThan(0);
        for (const drain of drains) {
            expect(drain.promoted).toBeLessThanOrEqual(countReleasesBehindTheirPredecessor(drain));
        }
    });

    it(`drains a 64-message buffered track in ${BUFFERED_64_DRAIN_BATCHES} batches, none running more than a page`, async () => {
        const fixture = await startInboundRuntime('promotion-batches', {});

        const drains = await admitBufferedTrack(fixture, { buffered: 64 });

        expect(fixture.delivered).toHaveLength(65);
        expect(drains).toHaveLength(BUFFERED_64_DRAIN_BATCHES);
        expect(drains.map((drain) => drain.claimedCount)).toEqual([1, ...Array(4).fill(AL_INBOUND_WORK_PAGE_SIZE)]);
        expect(drains.map((drain) => drain.promoted)).toEqual(BUFFERED_64_PROMOTED_PER_BATCH);
    }, TEST_TIMEOUT_MS);

    it('promotes a release only behind its own track\'s predecessor, with two tracks draining together', async () => {
        const delivered: string[] = [];
        const fixture = await startInboundRuntime('promotion-tracks', {
            gateDispatch: async (msg) => {
                delivered.push(`${msg.ordering?.orderingKey}:${msg.ordering?.seq}`);
            }
        });
        for (let seq = 2; seq <= 12; seq += 1) {
            await fixture.runtime.admitIncomingMessage(createTrackMessage('chat', seq), INBOUND_TEST_SOURCE);
            await fixture.runtime.admitIncomingMessage(createTrackMessage('other', seq), INBOUND_TEST_SOURCE);
        }
        const before = fixture.diagnostics.length;

        await fixture.runtime.admitIncomingMessage(createTrackMessage('chat', 1), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(createTrackMessage('other', 1), INBOUND_TEST_SOURCE);
        await vi.waitFor(
            () => expect(sumCompleted(readClaimingDrains(fixture.diagnostics.slice(before)))).toBe(24),
            { timeout: DRAIN_TIMEOUT_MS, interval: 5 }
        );

        const drains = readClaimingDrains(fixture.diagnostics.slice(before));
        expect(delivered.filter((track) => track.startsWith('chat:'))).toEqual(toSequence(1, 12).map((seq) => `chat:${seq}`));
        expect(delivered.filter((track) => track.startsWith('other:'))).toEqual(toSequence(1, 12).map((seq) => `other:${seq}`));
        expect(sumPromoted(drains)).toBeGreaterThan(0);
        for (const drain of drains) {
            expect(drain.promoted).toBeLessThanOrEqual(countReleasesBehindTheirPredecessor(drain));
        }
    });

    it('promotes nothing behind a release that did not complete, and delivers it on its retry before its successor', async () => {
        const deliveredSeqs: (number | undefined)[] = [];
        let failedOnce = false;
        const fixture = await startInboundRuntime('promotion-failed-predecessor', {
            gateDispatch: async (msg) => {
                if (msg.ordering?.seq === 5 && !failedOnce) {
                    failedOnce = true;
                    throw new Error('The consumer failed this delivery once');
                }
                deliveredSeqs.push(msg.ordering?.seq);
            }
        });

        const drains = await admitBufferedTrack(fixture, { buffered: 9 });

        expect(deliveredSeqs).toEqual(toSequence(1, 10));
        const failedDrain = drains.find((drain) => drain.rescheduledCount > 0);
        expect(failedDrain).toBeDefined();
        const failedRunOrder = failedDrain!.claimedEffectIds.map(toReleaseSeq);
        expect(failedRunOrder).toContain(5);
        expect(failedRunOrder).not.toContain(6);
    });
});

async function startInboundRuntime(
    namespace: string,
    ports: Pick<CreateInboundTestRuntimeInput, 'gateDispatch'>
): Promise<InboundTestRuntime> {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace,
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: `al-inbound:${namespace}`,
        ...ports
    });
    await fixture.runtime.ready();
    fixture.queueEngine.start();
    onTestFinished(() => fixture.queueEngine.stop());
    return fixture;
}

/** Seq 2 to `buffered + 1` first, then seq 1: every drain from seq 1's admission until the whole track is delivered. */
async function admitBufferedTrack(
    fixture: InboundTestRuntime,
    input: { readonly buffered: number; }
): Promise<readonly EffectDrain[]> {
    for (let seq = 2; seq <= input.buffered + 1; seq += 1) {
        await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: `m-${seq}`, seq }), INBOUND_TEST_SOURCE);
    }
    const before = fixture.diagnostics.length;
    await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'm-1', seq: 1 }), INBOUND_TEST_SOURCE);
    // A batch states its drain after its releases flush, so the last delivery lands before its drain does.
    await vi.waitFor(
        () => expect(sumCompleted(readClaimingDrains(fixture.diagnostics.slice(before)))).toBe(input.buffered + 1),
        { timeout: DRAIN_TIMEOUT_MS, interval: 5 }
    );
    return readClaimingDrains(fixture.diagnostics.slice(before));
}

function createTrackMessage(orderingKey: string, seq: number): ALMessage {
    const message = createInboundTestMessage({ msgId: `${orderingKey}-${seq}`, seq });
    return { ...message, ordering: { orderingKey, seq } };
}

function readClaimingDrains(events: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly EffectDrain[] {
    return events.filter((event): event is EffectDrain => event.kind === 'effect-drain' && event.claimedCount > 0);
}

function sumCompleted(drains: readonly EffectDrain[]): number {
    return drains.reduce((sum, drain) => sum + drain.completedCount, 0);
}

function sumPromoted(drains: readonly EffectDrain[]): number {
    return drains.reduce((sum, drain) => sum + drain.promoted, 0);
}

/** A release the batch ran after its own track's previous release: the only kind a promotion may add. */
function countReleasesBehindTheirPredecessor(drain: EffectDrain): number {
    return drain.claimedEffectIds.filter((effectId, index) => {
        const release = toRelease(effectId);
        return release !== undefined &&
            drain.claimedEffectIds.slice(0, index).some((earlier) => {
                const previous = toRelease(earlier);
                return previous?.track === release.track && previous.seq === release.seq - 1;
            });
    }).length;
}

function toRelease(effectId: string): { readonly track: string; readonly seq: number; } | undefined {
    const parts = effectId.split(':');
    return parts[0] === 'release' && parts.length >= 3
        ? { track: parts.slice(1, -1).join(':'), seq: Number(parts.at(-1)) }
        : undefined;
}

function toReleaseSeq(effectId: string): number | undefined {
    return toRelease(effectId)?.seq;
}

function toSequence(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

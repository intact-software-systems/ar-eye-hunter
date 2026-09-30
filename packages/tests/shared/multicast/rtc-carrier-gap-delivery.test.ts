import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    computeALDeliveryDeadline,
    computeALDeliveryLifecycle
} from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import { AL_FALLBACK_NOT_READY_ATTEMPTS } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';

import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

type AttemptSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>>;

const DEADLINE_MS = 2_000;

describe('an RTC origin room send in a carrier gap', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('holds an rtc-only durable send, states one not-ready attempt for the gap, and ends it expired at its deadline', async () => {
        const fixture = createGapFixture();
        const message = createDurableRoomMulticast('rtc-only-gap');

        const admitted = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100);

        expect(admitted.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 0 });
        expect(readAttemptOutcomes(fixture, message)).toEqual(['not-ready']);
        const lifecycle = toLifecycle(fixture, message, admitted);
        expect(lifecycle.state).toBe('expired');
        expect(lifecycle.evidence.failure).toEqual({ kind: 'expired' });
        expect(lifecycle.evidence.admittedDurable).toBe(true);
        expect(lifecycle.evidence.attempts).toEqual([
            expect.objectContaining({
                carrier: 'rtc',
                outcome: 'not-ready',
                submissionAttempted: false
            })
        ]);
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('sends a held send once the exact accepted overlay returns inside its deadline', async () => {
        const fixture = createGapFixture();
        const message = createDurableRoomMulticast('rtc-only-recovered');

        const admitted = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(200);
        fixture.overlays.accept('room', createOriginOverlay(['b', 'c']));
        await vi.advanceTimersByTimeAsync(200);

        expect(admitted.verdict.kind).toBe('admitted');
        expect(fixture.channels.b!.sent.map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
        expect(fixture.channels.c!.sent.map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
        expect(toLifecycle(fixture, message, admitted).state).toBe('transport-accepted');
    });

    it('answers a leg with a fallback carrier no-route at once, admitting nothing', async () => {
        const fixture = createGapFixture();
        const message = createDurableRoomMulticast('handed-over');

        const handedOver = await fixture.manager.enqueueLegIfAbsent(message, 'hand-over');
        await vi.advanceTimersByTimeAsync(200);

        expect(handedOver.verdict).toMatchObject({ kind: 'unroutable', reason: 'no-route' });
        expect(handedOver.entries).toEqual([]);
        expect(await fixture.resources.workQueue.getAllKeys()).toEqual([]);
        expect(fixture.settlements).toEqual([]);
    });

    it('settles every attempt of admitted copies not-ready while their overlay is missing', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
            nextHopPeerIds: ['b', 'c']
        });
        const message = createDurableRoomMulticast('dispatch-gap');

        const admitted = await fixture.manager.enqueueLegIfAbsent(message, 'hand-over');
        fixture.overlays.delete('room');
        await vi.advanceTimersByTimeAsync(1_000);

        expect(admitted.verdict.kind).toBe('admitted');
        const outcomes = readAttemptOutcomes(fixture, message);
        expect(outcomes.filter((outcome) => outcome === 'not-ready').length)
            .toBeGreaterThanOrEqual(AL_FALLBACK_NOT_READY_ATTEMPTS);
        expect(outcomes).not.toContain('no-targets');
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it.each(['hold', 'hand-over'] as const)(
        'refuses a send whose selected overlay belongs to another scope as unauthorized on a %s leg',
        async (carrierGap: RtcCarrierGapAdmission) => {
            const fixture = createGapFixture();
            fixture.overlays.accept('room', {
                ...createOriginOverlay(['b', 'c']),
                groupRef: { ...ORIGIN_ROOM, workspaceId: 'other' }
            });
            const message = createDurableRoomMulticast(`foreign-${carrierGap}`);

            const refused = await fixture.manager.enqueueLegIfAbsent(message, carrierGap);

            expect(refused.verdict).toMatchObject({ kind: 'refused', reason: 'unauthorized' });
            expect(toLifecycle(fixture, message, refused)).toMatchObject({
                state: 'rejected',
                evidence: { failure: { kind: 'refused', reason: 'unauthorized' } }
            });
        }
    );

    it('ends admitted copies no-targets when their overlay turns foreign before the attempt', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
            nextHopPeerIds: ['b', 'c']
        });
        const message = createDurableRoomMulticast('foreign-at-dispatch');

        const admitted = await fixture.manager.enqueueLegIfAbsent(message, 'hold');
        fixture.overlays.accept('room', {
            ...createOriginOverlay(['b', 'c']),
            groupRef: { ...ORIGIN_ROOM, workspaceId: 'other' }
        });
        await vi.advanceTimersByTimeAsync(200);

        expect(admitted.verdict.kind).toBe('admitted');
        expect(new Set(readAttemptOutcomes(fixture, message))).toEqual(new Set(['no-targets']));
        expect(toLifecycle(fixture, message, admitted)).toMatchObject({
            state: 'failed',
            evidence: { failure: { kind: 'attempt-failed', outcome: 'no-targets' } }
        });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });
});

/** The origin `a` whose room is observed and flowing while its accepted overlay is missing from the cache. */
function createGapFixture(): RtcOriginOverlayFixture {
    const fixture = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c']
    });
    fixture.overlays.delete('room');
    return fixture;
}

function createDurableRoomMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        {
            ack: 'all-logical-recipients',
            reliability: 'at-least-once',
            ttlMs: DEADLINE_MS,
            qos: { durability: { algo: 'local-outbox' } }
        }
    );
}

function readAttemptOutcomes(
    fixture: RtcOriginOverlayFixture,
    message: ALMessage
): readonly string[] {
    return fixture.settlements
        .filter((settlement): settlement is AttemptSettlement => settlement.kind === 'attempt-settled')
        .filter((settlement) => settlement.msgId === message.id.msgId)
        .map((settlement) => settlement.outcome);
}

/** The handle a browser sender reads: its admission, then every settlement the owner stated, read at now. */
function toLifecycle(
    fixture: RtcOriginOverlayFixture,
    message: ALMessage,
    admission: ALOutboundEnqueueResult
): ALDeliveryLifecycle {
    const opened = createInitialALDeliveryLifecycle({
        msgId: message.id.msgId,
        typeId: message.payload.typeId,
        ackMode: 'all-logical-recipients',
        receiptAlgo: 'receiver',
        expiresAtMs: message.constraints?.expiresAtMs,
        submittedAtMs: Date.now()
    });
    const settled: readonly ALDeliverySettlement[] = [
        {
            kind: 'admission',
            msgId: message.id.msgId,
            carrier: 'rtc',
            atMs: Date.now(),
            verdict: admission.verdict,
            trackedReceiptAlgo: admission.trackedReceiptAlgo
        },
        ...fixture.settlements.filter((settlement) => settlement.msgId === message.id.msgId)
    ];
    return computeALDeliveryDeadline(
        settled.reduce(computeALDeliveryLifecycle, opened),
        Date.now()
    );
}

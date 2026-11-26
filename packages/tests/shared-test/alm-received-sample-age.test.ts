import { describe, expect, it } from 'vitest';

import { computeAlmReceivedSampleAge } from '@shared-test/rallar-bb-test/alm/messages-received/compute-alm-received-sample-age.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const SENT_AT_EPOCH_MS = 1_800_000_000_000;

/** The publication stage's age bounds, written out: the two figures compare bucket by bucket only on the same bounds. */
const AGE_BOUNDS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000];

/** One copy recorded `ageMs` after the instant its payload names under `sentAtEpochMs`. */
function toStampedArrival(ageMs: number) {
    return {
        atEpochMs: SENT_AT_EPOCH_MS + ageMs,
        copy: { typeId: 'chat', payload: { sentAtEpochMs: SENT_AT_EPOCH_MS } }
    };
}

describe('the sample age of the copies a messages.received count matched', () => {
    it('records one age per copy, the arrival less the payload stamp, on the publication age bounds', () => {
        const sampleAge = computeAlmReceivedSampleAge(
            [0, 1, 3, 150, 60_001].map(toStampedArrival),
            'sentAtEpochMs'
        );

        expect(sampleAge).toEqual({
            from: 'sentAtEpochMs',
            ageMs: {
                upperBounds: AGE_BOUNDS_MS,
                bucketCounts: [2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
                count: 5,
                sum: 60_155,
                min: 0,
                max: 60_001
            },
            unrecordedSamples: 0
        });
    });

    it.each([
        ['lacks the field', { seq: 1 }],
        ['holds the text of an unresolved placeholder there', { sentAtEpochMs: '{loop.atEpochMs}' }],
        ['holds a numeric text there', { sentAtEpochMs: String(SENT_AT_EPOCH_MS) }],
        ['holds null there', { sentAtEpochMs: null }],
        ['holds NaN there', { sentAtEpochMs: Number.NaN }],
        ['holds positive infinity there', { sentAtEpochMs: Number.POSITIVE_INFINITY }],
        ['holds negative infinity there', { sentAtEpochMs: Number.NEGATIVE_INFINITY }],
        ['was stamped after it arrived', { sentAtEpochMs: SENT_AT_EPOCH_MS + 21 }],
        ['carries a payload that is no record', 'sentAtEpochMs']
    ])('counts a copy that %s as unrecorded, never as an age', (_label, payload) => {
        const sampleAge = computeAlmReceivedSampleAge(
            [
                toStampedArrival(20),
                { atEpochMs: SENT_AT_EPOCH_MS + 20, copy: { typeId: 'chat', payload } },
                toStampedArrival(20)
            ],
            'sentAtEpochMs'
        );

        expect(sampleAge.unrecordedSamples).toBe(1);
        expect(sampleAge.ageMs).toMatchObject({
            bucketCounts: [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            count: 2,
            sum: 40,
            min: 20,
            max: 20
        });
    });

    it('reads an empty histogram and no unrecorded sample when no copy arrived', () => {
        expect(computeAlmReceivedSampleAge([], 'sentAtEpochMs')).toEqual({
            from: 'sentAtEpochMs',
            ageMs: {
                upperBounds: AGE_BOUNDS_MS,
                bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                count: 0,
                sum: 0,
                min: null,
                max: null
            },
            unrecordedSamples: 0
        });
    });
});

describe('a messages.received command that names ageFrom', () => {
    const count = {
        kind: 'messages.received',
        connection: 'aliceRtc',
        typeId: 'alm.conformance',
        count: 3,
        windowMs: 40
    } as const;

    /** A runtime on a controlled clock whose event log recorded one copy per stamp, each at its own instant. */
    function createRuntimeHoldingCopies(copies: readonly { atEpochMs: number; sentAtEpochMs: number | string; }[]) {
        let now = SENT_AT_EPOCH_MS;
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ now: () => now, readSession: () => undefined });
        copies.forEach(({ atEpochMs, sentAtEpochMs }, index) => {
            now = atEpochMs;
            runtime.receiveRallarBrowserEvent({
                kind: 'message',
                topic: 'rallar.browser.ws.message',
                connection: 'aliceRtc',
                transport: 'ws',
                typeId: 'alm.conformance',
                data: {
                    msgId: `msg-${index}`,
                    typeId: 'alm.conformance',
                    transport: 'ws',
                    payload: { sentAtEpochMs },
                    traceId: 'trace-inbound-1',
                    corrId: `msg-${index}`
                }
            });
        });
        return runtime;
    }

    it('reads each copy\'s age from the runtime clock at its arrival, in its result and in its diagnostic', async () => {
        // Copies recorded 3 ms and 150 ms after their stamps, then one whose sender left its placeholder unresolved.
        const runtime = createRuntimeHoldingCopies([
            { atEpochMs: SENT_AT_EPOCH_MS + 3, sentAtEpochMs: SENT_AT_EPOCH_MS },
            { atEpochMs: SENT_AT_EPOCH_MS + 650, sentAtEpochMs: SENT_AT_EPOCH_MS + 500 },
            { atEpochMs: SENT_AT_EPOCH_MS + 1_000, sentAtEpochMs: '{loop.atEpochMs}' }
        ]);

        const aged = await runtime.execute({ ...count, commandId: 'aged', ageFrom: 'sentAtEpochMs' });

        const sampleAge = {
            from: 'sentAtEpochMs',
            ageMs: {
                upperBounds: AGE_BOUNDS_MS,
                bucketCounts: [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
                count: 2,
                sum: 153,
                min: 3,
                max: 150
            },
            unrecordedSamples: 1
        };
        expect(aged.ok, aged.error?.message).toBe(true);
        expect(aged.value).toMatchObject({ count: 3, observed: 3, sampleAge });
        const diagnostic = runtime.state().events.find((event) => event.commandId === 'aged' && event.topic === 'rallar.bb.messages.received');
        expect(isJsonRecordValue(diagnostic?.payload) ? diagnostic.payload.data : undefined).toMatchObject({ sampleAge });
    });

    it('names no sampleAge when the command names no ageFrom', async () => {
        const runtime = createRuntimeHoldingCopies([
            { atEpochMs: SENT_AT_EPOCH_MS + 3, sentAtEpochMs: SENT_AT_EPOCH_MS },
            { atEpochMs: SENT_AT_EPOCH_MS + 4, sentAtEpochMs: SENT_AT_EPOCH_MS },
            { atEpochMs: SENT_AT_EPOCH_MS + 5, sentAtEpochMs: SENT_AT_EPOCH_MS }
        ]);

        const plain = await runtime.execute({ ...count, commandId: 'plain' });

        expect(plain.ok, plain.error?.message).toBe(true);
        expect(plain.value).toMatchObject({ typeId: 'alm.conformance', count: 3, observed: 3, absent: false });
        expect(plain.value).not.toHaveProperty('sampleAge');
        const diagnostic = runtime.state().events.find((event) => event.commandId === 'plain' && event.topic === 'rallar.bb.messages.received');
        expect(isJsonRecordValue(diagnostic?.payload) ? diagnostic.payload.data : undefined)
            .toEqual({ typeId: 'alm.conformance', count: 3, observed: 3, absent: false });
    });
});

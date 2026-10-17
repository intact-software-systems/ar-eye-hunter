import { Temporal } from '@js-temporal/polyfill';
import { expect, it } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';

import { createCheckpointTestEntry } from '../alm/checkpoint/checkpoint-test-entry.ts';

it.each(['read', 'sweep'] as const)('uses the owner clock for %s expiry and emits removal only at expiry', async (operation) => {
    let now = Temporal.Instant.fromEpochMilliseconds(1_000);
    const source = createCheckpointTestEntry('owner-clock');
    const entry = { ...source, audit: { ...source.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(2_000) } };
    const queue = new InMemoryQueueBox(new Map([[entry.key, entry]]), () => now);
    const changes: string[] = [];
    queue.onChangeDo((key) => changes.push(key));

    if (operation === 'read') {
        expect(await queue.getItem(entry.key)).toMatchObject({ resource: '{"resourceId":"owner-clock"}' });
    }
    else {
        expect(await queue.deleteExpired()).toBe(0);
    }
    expect(queue.peek(toKeyAsString(entry.key))?.resource).toBe('{"resourceId":"owner-clock"}');
    expect(changes).toEqual([]);

    now = Temporal.Instant.fromEpochMilliseconds(2_000);
    if (operation === 'read') {
        expect(await queue.getItem(entry.key)).toBeUndefined();
    }
    else {
        expect(await queue.deleteExpired()).toBe(1);
    }
    expect(queue.peek(toKeyAsString(entry.key))).toBeUndefined();
    expect(changes).toEqual([toKeyAsString(entry.key)]);
});

it('advertises live work using the owner clock and stops advertising at expiry', async () => {
    let now = Temporal.Instant.fromEpochMilliseconds(1_000);
    const source = createCheckpointTestEntry('advertised');
    const entry = { ...source, audit: { ...source.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(2_000) } };
    const queue = new InMemoryQueueBox(new Map([[entry.key, entry]]), () => now);
    const options = { maxAttempts: 20, finalizationStaleAfterMs: 1_000, reservationLeaseMs: 1_000, staleDueThresholdMs: 1_000 };

    expect((await queue.readWorkAdvertisement(new Set(['checkpoint.work']), options)).NEW).toBe(true);
    now = Temporal.Instant.fromEpochMilliseconds(2_000);
    expect((await queue.readWorkAdvertisement(new Set(['checkpoint.work']), options)).NEW).toBe(false);
});

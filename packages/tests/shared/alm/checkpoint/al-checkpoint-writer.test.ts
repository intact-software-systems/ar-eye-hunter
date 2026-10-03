import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALCheckpointDirtySet } from '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts';
import { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
import type { ALCheckpointMutations } from '@shared/alm/checkpoint/compute-al-checkpoint-mutations.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    GLOBAL_CHECKPOINT_TIMERS,
    TEST_CHECKPOINT_SETTINGS
} from './al-checkpoint-test-support.ts';

const STORE_ID = 'browser-ws-client-checkpoint:session-1';
const QUOTA = new DOMException('full', 'QuotaExceededError');
const START_MS = 1_800_000_000_000;
const ROW_EXPIRY_MS = START_MS + 3_600_000;

beforeEach(() => {
    vi.useFakeTimers({ now: START_MS });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('ALCheckpointWriter', () => {
    it('arms one checkpoint an interval after the first change, and a later change never postpones it', async () => {
        const fixture = createWriterFixture();

        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(600);
        await fixture.change('b', 'two');
        await vi.advanceTimersByTimeAsync(399);
        expect(fixture.writes).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one', b: 'two' }]);
    });

    it('runs nothing while the pair is clean', async () => {
        const fixture = createWriterFixture();

        await vi.advanceTimersByTimeAsync(60_000);

        expect(fixture.writes).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps one write in flight, and a change made during it reaches the next one', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        await fixture.change('b', 'two');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fixture.writes).toHaveLength(1);
        fixture.writes[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { b: 'two' }]);
    });

    it('never marks a change made during a write saved when that write completes', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        await fixture.change('a', 'two');
        fixture.writes[0]!.resolve();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { a: 'two' }]);
    });

    it('writes a key removed since it changed as a removal', async () => {
        const fixture = createWriterFixture();

        await fixture.change('a', 'one');
        await fixture.change('a', undefined);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(fixture.writes.map((write) => write.mutations.mutations)).toEqual([[{ kind: 'remove', key: 'a' }]]);
    });

    it('keeps the keys of a failed write unsaved and writes them again an interval later', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        fixture.writes[0]!.reject(QUOTA);
        await vi.advanceTimersByTimeAsync(999);
        expect(fixture.writes).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { a: 'one' }]);
    });

    it('states delayed once, with the oldest unsaved age and the failure that delays it', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        await vi.advanceTimersByTimeAsync(200);
        fixture.writes[0]!.reject(QUOTA);
        await vi.advanceTimersByTimeAsync(1_000);
        fixture.writes[1]!.reject(QUOTA);
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.events).toEqual([{
            kind: 'health',
            storeId: STORE_ID,
            status: 'delayed',
            lastFailure: { cause: 'quota', detail: 'QuotaExceededError: full' },
            lastRecoveryPointAtMs: undefined,
            oldestUnsavedAgeMs: 1_200
        }]);
    });

    it('states failing with checkpoint-lag at the bound, naming the last failed write, and healthy when a checkpoint completes', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');

        for (let attempt = 0; attempt < 10; attempt += 1) {
            await vi.advanceTimersByTimeAsync(1_000);
            fixture.writes.at(-1)!.reject(QUOTA);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.events.map((event) => event.kind === 'health' && event.status)).toEqual(['delayed']);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(999);
        fixture.writes.at(-1)!.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.writes).toHaveLength(11);
        expect(fixture.events.slice(1)).toEqual([
            {
                kind: 'health',
                storeId: STORE_ID,
                status: 'failing',
                lastFailure: {
                    cause: 'checkpoint-lag',
                    detail: 'The oldest unsaved change is 10001 ms old, beyond the 10000 ms bound. ' +
                        'The last checkpoint failed: QuotaExceededError: full'
                },
                lastRecoveryPointAtMs: undefined,
                oldestUnsavedAgeMs: 10_001
            },
            {
                kind: 'health',
                storeId: STORE_ID,
                status: 'healthy',
                lastFailure: {
                    cause: 'checkpoint-lag',
                    detail: 'The oldest unsaved change is 10001 ms old, beyond the 10000 ms bound. ' +
                        'The last checkpoint failed: QuotaExceededError: full'
                },
                lastRecoveryPointAtMs: START_MS + 11_000,
                oldestUnsavedAgeMs: undefined
            }
        ]);
    });

    it('flushes now, and a flush during a write runs right after that write', async () => {
        const fixture = createWriterFixture();
        fixture.writer.flush();
        expect(fixture.writes).toHaveLength(0);

        await fixture.change('a', 'one');
        fixture.writer.flush();
        await fixture.change('b', 'two');
        fixture.writer.flush();
        expect(fixture.writes).toHaveLength(1);
        fixture.writes[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { b: 'two' }]);
    });

    it('cancels its armed checkpoint when disposed', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');

        fixture.writer.dispose();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(fixture.writes).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});

interface HeldWrite {
    readonly mutations: ALCheckpointMutations;
    resolve(): void;
    reject(error: Error): void;
}

function createWriterFixture(): Readonly<{
    writer: ALCheckpointWriter;
    writes: readonly HeldWrite[];
    events: readonly ALStorageEvent[];
    change(key: string, value: string | undefined): Promise<void>;
}> {
    const nowMs = () => Date.now();
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    const memory = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), nowMs);
    const writes: HeldWrite[] = [];
    const events: ALStorageEvent[] = [];
    const writer = new ALCheckpointWriter({
        memory,
        dirty: new ALCheckpointDirtySet({ backend: memory, nowMs }),
        write: (mutations) => {
            const held = Promise.withResolvers<void>();
            writes.push({ mutations, resolve: () => held.resolve(), reject: (error) => held.reject(error) });
            return held.promise;
        },
        health: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => events.push(event) }),
        settings: TEST_CHECKPOINT_SETTINGS,
        nowMs,
        timers: GLOBAL_CHECKPOINT_TIMERS
    });
    const change = async (key: string, value: string | undefined): Promise<void> => {
        await memory.write(async (tx) => value === undefined ? await tx.remove(key) : await tx.set(key, value, ROW_EXPIRY_MS));
    };
    return { writer, writes, events, change };
}

function toWrittenValues(write: HeldWrite): Readonly<Record<string, string>> {
    return Object.fromEntries(
        write.mutations.mutations.flatMap((mutation) => mutation.kind === 'set' ? [[mutation.stored.key, String(mutation.stored.value)]] : [])
    );
}

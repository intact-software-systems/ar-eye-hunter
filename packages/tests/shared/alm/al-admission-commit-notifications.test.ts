import { afterEach, expect, it, vi } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { decodeALAdmissionString } from '@shared/alm/al-admission-value-validation.ts';
import { ALCheckpointDirtySet } from '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts';
import { markTerminalVolatileAdmissionRow } from '@shared/alm/storage/in-memory-admission-work-write-buffer.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';

import { createCheckpointTestEntry } from './checkpoint/checkpoint-test-entry.ts';

afterEach(() => vi.restoreAllMocks());

it('finishes joint rows, queue index and terminal proof before any observer and isolates failures', async () => {
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const entry = createCheckpointTestEntry('joint');
    const seen: string[] = [];
    const views: boolean[][] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {
        throw new Error('reporter failed');
    });
    backend.workQueue.onChangeDo(() => {
        throw new Error('queue observer failed');
    });
    backend.onChangeDo(() => {
        throw new Error('admission observer failed');
    });
    const dirty = new ALCheckpointDirtySet({ backend, nowMs: Date.now });
    backend.workQueue.onChangeDo(() => {
        views.push([backend.peek('first')?.value === 'one', backend.peek('second')?.value === 'two', backend.isTerminalVolatileRow(backend.peek('first')!)]);
        seen.push('queue');
    });
    backend.onChangeDo((key) => {
        views.push([
            backend.peek('first')?.value === 'one',
            backend.peek('second')?.value === 'two',
            backend.workQueue.peek(toKeyAsString(entry.key))?.status === EntityStatus.NEW
        ]);
        seen.push(key);
    });

    await expect(backend.write(async (tx) => {
        await tx.set('first', 'one');
        markTerminalVolatileAdmissionRow(tx, 'first');
        await tx.set('second', 'two');
        await tx.readWork(entry.key);
        tx.writeWork(entry);
        return 'committed';
    })).resolves.toBe('committed');

    expect(seen).toEqual(['queue', 'first', 'second']);
    expect(views).toEqual([[true, true, true], [true, true, true], [true, true, true]]);
    expect(
        (await backend.workQueue.readWorkPage({ typeId: 'checkpoint.work', status: EntityStatus.NEW, maxToRead: 10, cursor: null })).entries.map((row) =>
            row.key.resourceId
        )
    ).toEqual(['joint']);
    expect(dirty.getSnapshot().marks.map(({ space, key }) => [space, key])).toEqual([
        ['admission', 'first'],
        ['admission', 'second'],
        ['queue', toKeyAsString(entry.key)]
    ]);
    dirty.dispose();
});

it('serializes observer-enqueued writes across wrappers without deadlock', async () => {
    const state = createInMemoryALAdmissionState();
    const first = new InMemoryAdmissionBackend(state, Date.now);
    const second = new InMemoryAdmissionBackend(state, Date.now);
    const pending: Promise<void>[] = [];
    first.onChangeDo(() => {
        pending.push(second.write(async (tx) => {
            expect(await tx.read('second', decodeALAdmissionString)).toBe('two');
            await tx.set('third', 'three');
        }));
    });
    await first.write(async (tx) => {
        await tx.set('first', 'one');
        await tx.set('second', 'two');
    });
    await Promise.all(pending);
    expect(second.peek('third')?.value).toBe('three');
});

it.each(['callback', 'deadline', 'conflict'] as const)('does not commit or publish authored state on %s failure', async (failure) => {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => 100);
    const entry = createCheckpointTestEntry('guard');
    const notifications: string[] = [];
    backend.onChangeDo((key) => notifications.push(key));
    backend.workQueue.onChangeDo((key) => notifications.push(key));
    const write = backend.write(async (tx) => {
        await tx.set('authored', 'value');
        await tx.readWork(entry.key);
        tx.writeWork(entry);
        if (failure === 'callback') {
            throw new Error('callback failed');
        }
        if (failure === 'conflict') {
            await backend.workQueue.enqueue({ ...entry, resource: 'other writer' });
            notifications.length = 0;
        }
    }, failure === 'deadline' ? 100 : null);
    await expect(write).rejects.toThrow();
    expect(backend.peek('authored')).toBeUndefined();
    expect(backend.workQueue.peek(toKeyAsString(entry.key))?.resource).toBe(failure === 'conflict' ? 'other writer' : undefined);
    expect(notifications).toEqual([]);
});

it('replaces and removes volatile proof before publishing cleanup', async () => {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    await backend.write(async (tx) => {
        await tx.set('row', 'volatile');
        markTerminalVolatileAdmissionRow(tx, 'row');
    });
    const original = backend.peek('row')!;
    const proof: boolean[] = [];
    backend.onChangeDo(() => proof.push(backend.isTerminalVolatileRow(original)));
    await backend.write(async (tx) => {
        await tx.set('row', 'replacement');
    });
    expect(backend.isTerminalVolatileRow(backend.peek('row')!)).toBe(false);
    expect(backend.removeObservedRowsIfNoWrites([backend.peek('row')!])).toBe(true);
    expect(proof).toEqual([false, false]);
    expect(backend.peek('row')).toBeUndefined();
});

it('restores a checkpoint completely before notifying either owner', () => {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const entry = createCheckpointTestEntry('restore');
    const views: boolean[][] = [];
    backend.onChangeDo(() =>
        views.push([
            backend.peek('a')?.value === 'one',
            backend.peek('b')?.value === 'two',
            backend.workQueue.peek(toKeyAsString(entry.key))?.resource === '{"resourceId":"restore"}'
        ])
    );
    backend.loadIfAbsent([
        { key: 'a', value: 'one', expireAtTimestamp: Number.MAX_SAFE_INTEGER },
        { key: 'b', value: 'two', expireAtTimestamp: Number.MAX_SAFE_INTEGER }
    ], [entry]);
    expect(views).toEqual([[true, true, true], [true, true, true]]);
});

it('delivers every checkpoint mark in the commit turn when an earlier mark observer throws', async () => {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const dirty = new ALCheckpointDirtySet({ backend, nowMs: Date.now });
    let notifications = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dirty.onMarkedDo(() => {
        throw new Error('mark observer failed');
    });
    dirty.onMarkedDo(() => {
        notifications += 1;
    });
    await backend.write(async (tx) => {
        await tx.set('a', 'one');
        await tx.set('b', 'two');
    });
    expect(notifications).toBe(2);
    expect(dirty.getSnapshot().marks.map((mark) => mark.key)).toEqual(['a', 'b']);
    dirty.dispose();
});

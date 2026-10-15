import '../../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionStoredValue
} from '@shared/alm/al-admission-backend.ts';
import { ALCheckpoint, type ALCheckpointStorage } from '@shared/alm/checkpoint/al-checkpoint.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { toALOutboundWorkKey, toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { ALRuntimeStorage } from '@shared/alm/storage/al-runtime-storage.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { IndexedDbAdmissionMutation } from '@shared/alm/write-indexed-db-admission-mutations.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toResourceEntryWithKey, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createTakeableDurableWorkOwnership,
    GLOBAL_CHECKPOINT_TIMERS,
    TEST_CHECKPOINT_SETTINGS,
    type TakeableDurableWorkOwnership
} from './al-checkpoint-test-support.ts';

const STORE_ID = 'browser-ws-client-checkpoint:session-1';
const NAMESPACE = `browser:${STORE_ID}`;
const ADMISSION_NAMESPACE = `${NAMESPACE}:outbound:admission`;
const ROW_KEY = `${ADMISSION_NAMESPACE}:row`;
const START_MS = 1_800_000_000_000;

describe('ALCheckpoint', () => {
    it('saves the changed rows in one readwrite, and another document\'s owner restores them without marking them unsaved', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('one');
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 60_000));
        saving.observer.reset();

        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));
        const restoring = openCheckpoint({ dbName, clock, owned: true });
        await restoring.checkpoint.restore();
        restoring.observer.reset();
        restoring.checkpoint.flush();

        expect(restoring.readRow()).toBe('one');
        expect(await restoring.memory.workQueue.getItem(workKey('effect-1'))).toMatchObject({ resource: '{"effectId":"effect-1"}' });
        expect(saving.observer.getCounts().total).toBe(1);
        expect(restoring.observer.getCounts().total).toBe(0);
    });

    // The readwrite aborts after its work row was put and before its admission row: neither lands.
    it('leaves the saved rows as they were when its readwrite aborts, and saves the same changes on its next attempt', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('one');
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 60_000));
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));

        await saving.writeRow('two');
        await saving.memory.workQueue.replaceIfObserved(
            (await saving.memory.workQueue.getItem(workKey('effect-1')))!,
            { ...workEntry('effect-1', START_MS + 60_000), resource: '{"effectId":"changed"}' }
        );
        const aborted = abortReadwriteAtAdmissionPut();
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(aborted.count).toBe(1));
        aborted.restore();
        expect(await readSaved(dbName, clock)).toEqual({ row: 'one', work: '{"effectId":"effect-1"}' });

        saving.checkpoint.flush();
        await vi.waitFor(async () => expect(await readSaved(dbName, clock)).toEqual({ row: 'two', work: '{"effectId":"changed"}' }));
    });

    // A corrupt row is no storage failure, yet the lane must open: the runtime's readiness awaits every lane.
    it('opens from memory when the saved rows cannot be decoded, and states the store failing with that error', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const restoring = openCheckpoint({ dbName, clock, owned: true });
        await restoring.writeRow('own');
        restoring.storage.saved.readNamespaceRows = async () => {
            throw new TypeError('Stored resource entry is malformed');
        };

        await restoring.checkpoint.restore();

        expect(restoring.readRow()).toBe('own');
        expect(await restoring.memory.workQueue.getItem(workKey('effect-1'))).toBeUndefined();
        await vi.waitFor(() =>
            expect(restoring.events).toEqual([
                expect.objectContaining({
                    kind: 'health',
                    storeId: STORE_ID,
                    status: 'failing',
                    lastFailure: { cause: 'transaction-failed', detail: 'Stored resource entry is malformed' }
                })
            ])
        );
    });

    // A disconnect disposes the checkpoint inside the interval; what the interval has not saved goes with it unless the dispose flushes.
    it('flushes its unsaved rows when disposed before the interval', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('one');

        await saving.checkpoint.dispose();

        expect(await readSaved(dbName, clock)).toMatchObject({ row: 'one' });
    });

    it('keeps the saved database open until an in-flight checkpoint and its final changes finish', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        const runtimeStorage = new ALRuntimeStorage();
        runtimeStorage.ownBackend(saving.storage.saved);
        runtimeStorage.ownCheckpoint(saving.checkpoint);
        await saving.checkpoint.restore();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const write = saving.storage.saved.writeUnfencedMutations.bind(saving.storage.saved);
        vi.spyOn(saving.storage.saved, 'writeUnfencedMutations').mockImplementation(async (mutations) => {
            entered.resolve();
            await release.promise;
            return await write(mutations);
        });
        onTestFinished(() => release.resolve());
        await saving.writeRow('first');
        saving.checkpoint.flush();
        await entered.promise;
        await saving.writeRow('final');
        let closed = false;
        const closing = runtimeStorage.close().then(() => {
            closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        release.resolve();
        await closing;
        expect(await readSaved(dbName, clock)).toMatchObject({ row: 'final' });
        await expect(saving.storage.saved.ready()).rejects.toThrow('closed');
    });

    it('saves owned admissions when disposal overlaps takeover restore and stays retired afterward', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const other = openCheckpoint({ dbName, clock, owned: false });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const scheduled = new Set<() => void>();
        vi.spyOn(GLOBAL_CHECKPOINT_TIMERS, 'schedule').mockImplementation((run) => {
            scheduled.add(run);
            return () => {
                scheduled.delete(run);
            };
        });
        const observe = other.observer.observe.bind(other.observer);
        vi.spyOn(other.observer, 'observe').mockImplementation(async (operation) => {
            observe(operation);
            if (operation.kind === 'list') {
                entered.resolve();
                await release.promise;
            }
        });
        const subscription = other.checkpoint.onTakenOverDo(() => {});
        onTestFinished(() => {
            release.resolve();
            subscription.unsubscribe();
            vi.restoreAllMocks();
        });
        const runtimeStorage = new ALRuntimeStorage();
        runtimeStorage.ownBackend(other.storage.saved);
        runtimeStorage.ownCheckpoint(other.checkpoint);
        other.ownership.take();
        await entered.promise;
        expect(other.checkpoint.isOwned()).toBe(true);
        await other.writeRow('accepted-while-owned');
        const closing = runtimeStorage.close();
        release.resolve();
        await closing;

        expect(await readSaved(dbName, clock)).toMatchObject({ row: 'accepted-while-owned' });
        expect(scheduled.size).toBe(0);
        await other.writeRow('after-retirement');
        await other.checkpoint.restore();
        other.checkpoint.flush();
        expect(scheduled.size).toBe(0);
        expect(await readSaved(dbName, clock)).toMatchObject({ row: 'accepted-while-owned' });
        await expect(other.storage.saved.ready()).rejects.toThrow('closed');
    });

    it('releases independent databases even when the final checkpoint fails', async () => {
        const clock = { nowMs: START_MS };
        const failure = new Error('final checkpoint failed');
        const first = openCheckpoint({ dbName: newDbName(), clock, owned: true, expectedDisposalFailure: failure });
        const second = openCheckpoint({ dbName: newDbName(), clock, owned: true });
        const runtimeStorage = new ALRuntimeStorage();
        for (const fixture of [first, second]) {
            runtimeStorage.ownBackend(fixture.storage.saved);
            runtimeStorage.ownCheckpoint(fixture.checkpoint);
            await fixture.checkpoint.restore();
        }
        await first.writeRow('cannot-save');
        vi.spyOn(first.storage.saved, 'writeUnfencedMutations').mockRejectedValue(failure);
        await expect(runtimeStorage.close()).rejects.toMatchObject({ errors: [failure] });
        await expect(first.storage.saved.ready()).rejects.toThrow('closed');
        await expect(second.storage.saved.ready()).rejects.toThrow('closed');
    });

    it('loads only live rows, and counts the work rows past their expiry on its first batch', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 1_000));
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));
        clock.nowMs = START_MS + 2_000;

        const restoring = openCheckpoint({ dbName, clock, owned: true });
        await restoring.checkpoint.restore();
        restoring.checkpoint.reportFirstBatch(0);

        expect(await restoring.memory.workQueue.getItem(workKey('effect-1'))).toBeUndefined();
        expect(restoring.events).toEqual([
            { kind: 'recovery', storeId: STORE_ID, outcome: { kind: 'expired-at-recovery', expired: 1 } }
        ]);
    });

    it('neither restores nor saves in a runtime that does not own the work, and restores when it takes over, keeping its own rows', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('saved');
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 60_000));
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));

        const other = openCheckpoint({ dbName, clock, owned: false });
        const takenOver: string[] = [];
        const subscription = other.checkpoint.onTakenOverDo(() => takenOver.push('restored'));
        onTestFinished(() => subscription.unsubscribe());
        await other.checkpoint.restore();
        await other.writeRow('own');
        other.checkpoint.flush();
        expect(other.observer.getCounts().total).toBe(0);
        other.ownership.take();

        await vi.waitFor(() => expect(takenOver).toEqual(['restored']));
        expect(other.readRow()).toBe('own');
        expect(await other.memory.workQueue.getItem(workKey('effect-1'))).toBeDefined();
        expect(other.observer.getCounts().byKind).toEqual({ list: 1 });
    });

    it('keeps no unsaved changes in a runtime that does not own the work, and its first checkpoint after a takeover saves every row it holds', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('saved');
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));

        const other = openCheckpoint({ dbName, clock, owned: false });
        const takenOver: string[] = [];
        const subscription = other.checkpoint.onTakenOverDo(() => takenOver.push('restored'));
        onTestFinished(() => subscription.unsubscribe());
        await other.writeRowAt(`${ADMISSION_NAMESPACE}:own`, 'own');
        await other.writeRowAt(`${ADMISSION_NAMESPACE}:gone`, 'gone');
        await other.removeRowAt(`${ADMISSION_NAMESPACE}:gone`);
        other.ownership.take();

        // No flush: the takeover's marking arms the interval checkpoint by itself.
        await vi.waitFor(() => expect(takenOver).toEqual(['restored']));
        expect(other.writes).toEqual([]);
        await vi.waitFor(() => expect(other.writes).toHaveLength(1), { timeout: 3_000 });
        expect(other.writes[0]).toEqual([`set ${ADMISSION_NAMESPACE}:own`, `set ${ROW_KEY}`]);
    });
});

interface OpenedCheckpoint {
    readonly memory: InMemoryAdmissionBackend;
    readonly storage: ALCheckpointStorage;
    readonly checkpoint: ALCheckpoint;
    readonly ownership: TakeableDurableWorkOwnership;
    readonly observer: CountingIndexedDbOperationObserver;
    readonly events: readonly ALStorageEvent[];
    /** Each checkpoint write's admission mutations, as `<kind> <key>` sorted by key. */
    readonly writes: readonly (readonly string[])[];
    writeRow(value: string): Promise<void>;
    writeRowAt(key: string, value: string): Promise<void>;
    removeRowAt(key: string): Promise<void>;
    readRow(): string | undefined;
}

interface OpenCheckpointInput {
    readonly dbName: string;
    readonly clock: { nowMs: number; };
    readonly owned: boolean;
    /** Only the explicit failed-save case expects disposal to reject again during cleanup. */
    readonly expectedDisposalFailure?: Error;
}

function openCheckpoint(input: OpenCheckpointInput): OpenedCheckpoint {
    const observer = createCountingIndexedDbOperationObserver();
    const events: ALStorageEvent[] = [];
    const nowMs = () => input.clock.nowMs;
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    const memory = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), nowMs);
    const saved = new IndexedDbAdmissionBackend({
        dbName: input.dbName,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        nowMs,
        newWriteToken: () => crypto.randomUUID(),
        observer,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => undefined
    });
    const writes: string[][] = [];
    const writeUnfencedMutations = saved.writeUnfencedMutations.bind(saved);
    saved.writeUnfencedMutations = async (mutations) => {
        writes.push(mutations.mutations.map((mutation) => `${mutation.kind} ${toMutationKey(mutation)}`).sort());
        return await writeUnfencedMutations(mutations);
    };
    const storage: ALCheckpointStorage = {
        memory,
        saved,
        selection: {
            keyPrefix: `${NAMESPACE}:`,
            workRanges: { namespacePrefixes: [ADMISSION_NAMESPACE], canonicalScopes: [NAMESPACE] }
        },
        health: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => events.push(event) }),
        settings: TEST_CHECKPOINT_SETTINGS,
        newWriteToken: () => crypto.randomUUID(),
        timers: GLOBAL_CHECKPOINT_TIMERS
    };
    const ownership = createTakeableDurableWorkOwnership(input.owned);
    const checkpoint = new ALCheckpoint({ storage, ownership, nowMs });
    onTestFinished(() => closeCheckpoint(checkpoint, saved, input.expectedDisposalFailure));
    return {
        memory,
        storage,
        checkpoint,
        ownership,
        observer,
        events,
        writes,
        writeRow: async (value) => await memory.write(async (tx) => await tx.set(ROW_KEY, value, START_MS + 60_000)),
        writeRowAt: async (key, value) => await memory.write(async (tx) => await tx.set(key, value, START_MS + 60_000)),
        removeRowAt: async (key) => await memory.write(async (tx) => await tx.remove(key)),
        readRow: () => readStoredString(memory.peek(ROW_KEY))
    };
}

async function closeCheckpoint(
    checkpoint: ALCheckpoint,
    saved: IndexedDbAdmissionBackend,
    expectedFailure: Error | undefined
): Promise<void> {
    try {
        const disposed = checkpoint.dispose();
        if (expectedFailure === undefined) {
            await disposed;
        }
        else {
            await expect(disposed).rejects.toBe(expectedFailure);
        }
    }
    finally {
        await saved.close();
    }
}

function toMutationKey(mutation: IndexedDbAdmissionMutation): string {
    return mutation.kind === 'set' ? mutation.stored.key : mutation.key;
}

interface SavedCheckpointRows {
    readonly row: string | undefined;
    readonly work: string | undefined;
}

/** What another document of the session would restore: the saved admission row and work row. */
async function readSaved(
    dbName: string,
    clock: { nowMs: number; }
): Promise<SavedCheckpointRows> {
    const reader = openCheckpoint({ dbName, clock, owned: true });
    const read = await reader.storage.saved.readNamespaceRows(reader.storage.selection);
    return {
        row: readStoredString(read.rows.find((row) => row.key === ROW_KEY)),
        work: read.workRows.find((row) => row.key.contextId === 'effect-1')?.resource
    };
}

interface AdmissionPutAbort {
    readonly count: number;
    restore(): void;
}

/** Aborts the next readwrite when it puts an admission row, after its queue puts were issued. */
function abortReadwriteAtAdmissionPut(): AdmissionPutAbort {
    const put = IDBObjectStore.prototype.put;
    const aborted = { count: 0 };
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
    ) {
        if (this.name !== 'entries' || this.transaction.mode !== 'readwrite') {
            return put.apply(this, args);
        }
        aborted.count += 1;
        const request = this.get(IDBKeyRange.only(''));
        this.transaction.abort();
        return request;
    });
    return {
        get count() {
            return aborted.count;
        },
        restore: () => spy.mockRestore()
    };
}

function workEntry(effectId: string, expiresAtMs: number): ResourceEntry {
    return toResourceEntryWithKey(
        workKey(effectId),
        toALOutboundWorkType(ADMISSION_NAMESPACE),
        { effectId },
        Temporal.Instant.fromEpochMilliseconds(expiresAtMs)
    );
}

function workKey(effectId: string) {
    return toALOutboundWorkKey(ADMISSION_NAMESPACE, effectId);
}

function readStoredString(stored: Pick<ALAdmissionStoredValue, 'value'> | undefined): string | undefined {
    return typeof stored?.value === 'string' ? stored.value : undefined;
}

function newDbName(): string {
    return `al-checkpoint-${crypto.randomUUID()}`;
}

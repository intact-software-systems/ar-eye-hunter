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

function openCheckpoint(input: { dbName: string; clock: { nowMs: number; }; owned: boolean; }): OpenedCheckpoint {
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
        timers: GLOBAL_CHECKPOINT_TIMERS
    };
    const ownership = createTakeableDurableWorkOwnership(input.owned);
    const checkpoint = new ALCheckpoint({ storage, ownership, nowMs });
    onTestFinished(() => checkpoint.dispose());
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

function toMutationKey(mutation: IndexedDbAdmissionMutation): string {
    return mutation.kind === 'set' ? mutation.stored.key : mutation.key;
}

/** What another document of the session would restore: the saved admission row and work row. */
async function readSaved(
    dbName: string,
    clock: { nowMs: number; }
): Promise<Readonly<{ row: string | undefined; work: string | undefined; }>> {
    const reader = openCheckpoint({ dbName, clock, owned: true });
    const read = await reader.storage.saved.readNamespaceRows(reader.storage.selection);
    return {
        row: readStoredString(read.rows.find((row) => row.key === ROW_KEY)),
        work: read.workRows.find((row) => row.key.contextId === 'effect-1')?.resource
    };
}

/** Aborts the next readwrite when it puts an admission row, after its queue puts were issued. */
function abortReadwriteAtAdmissionPut(): Readonly<{ count: number; restore(): void; }> {
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

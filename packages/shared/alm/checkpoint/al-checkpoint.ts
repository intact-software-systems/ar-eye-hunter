import { Temporal } from '@js-temporal/polyfill';

import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import { decodeStoredResourceEntry } from '../../queuebox/indexed-db-queue-box-entry-codec.ts';
import { isStoredQueueEntryExpired } from '../../queuebox/indexed-db-queue-box-entry.ts';
import { toError } from '../../resilience/to-error.ts';
import type { InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { IndexedDbAdmissionBackend } from '../indexed-db-admission-backend.ts';
import { toALAdmissionStoredValue } from '../indexed-db-admission-row.ts';
import type { ALStorageOpening } from '../open-indexed-db-admission-database.ts';
import type { ALStorageHealth } from '../storage/al-storage-health.ts';
import {
    createALStorageRecoveryReporter,
    type ALStorageRecoveryReporter
} from '../storage/al-storage-recovery-reporter.ts';
import { toALStorageFailure } from '../storage/al-storage-unavailable.ts';
import type { ALDurableWorkOwnership } from '../work/al-durable-work-ownership.ts';
import { ALCheckpointDirtySet } from './al-checkpoint-dirty-set.ts';
import { ALCheckpointWriter } from './al-checkpoint-writer.ts';
import type { ALCheckpointMutations } from './compute-al-checkpoint-mutations.ts';

/** A memory pair and the IndexedDB rows its checkpoint saves it to, under the pair's own namespace. */
export interface ALCheckpointStorage {
    readonly memory: InMemoryAdmissionBackend;
    readonly saved: IndexedDbAdmissionBackend;
    readonly selection: IndexedDbAdmissionBackend.NamespaceSelection;
    readonly health: ALStorageHealth;
    readonly settings: ALCheckpointWriter.Settings;
    readonly newWriteToken: () => string;
    readonly timers: ALCheckpointWriter.Timers;
}

/**
 * What a checkpoint lane and the page lifecycle hold of a memory pair's checkpoint. `restore` and the
 * first-batch report run once; `flush` starts a checkpoint now and is never awaited, and `dispose`
 * flushes the same way before it stops the checkpoint.
 */
export interface ALCheckpointPort extends ALStorageRecoveryReporter {
    /** Never rejects: a store that cannot be read or decoded is stated on its health, and the lane opens from memory. */
    restore(): Promise<void>;
    flush(): void;
    dispose(): void;
    /** Whether this runtime saves the checkpoint, so its admissions outlive the document. */
    isOwned(): boolean;
    /** Restores when ownership turns to this runtime, then calls the listener. */
    onTakenOverDo(listener: () => void): Unsubscribe;
}

export namespace ALCheckpoint {
    export interface Input {
        readonly storage: ALCheckpointStorage;
        readonly ownership: ALDurableWorkOwnership;
        readonly nowMs: () => number;
    }
}

/** What the restore found: the database's opening, and the work rows past their expiry it left out. */
interface ALCheckpointRestore {
    readonly opening: ALStorageOpening | undefined;
    readonly expiredWorkCount: number;
}

/** The unsaved changes of the pair and the writer that saves them, held only while this runtime owns the work. */
interface ALCheckpointTracking {
    readonly dirty: ALCheckpointDirtySet;
    readonly writer: ALCheckpointWriter;
}

/**
 * One memory pair's checkpoint in one runtime of a session. Only the runtime that owns the session's
 * durable work tracks, saves and restores it: the restore loads the saved rows into the pair, keeping
 * every key the pair already holds, before the lane's first work batch or when ownership is taken over.
 * A runtime that owned the work from construction marks none of the restored rows unsaved; one that
 * took it over keeps no unsaved changes while it waited, and marks every row it holds once its restore
 * ran, so its first checkpoint saves the live state.
 */
export class ALCheckpoint implements ALCheckpointPort {
    private readonly input: ALCheckpoint.Input;
    private readonly recovery: ALStorageRecoveryReporter;
    private tracking: ALCheckpointTracking | undefined;
    private restoring: Promise<void> | undefined;
    private restored: ALCheckpointRestore | undefined;
    private disposed = false;

    constructor(input: ALCheckpoint.Input) {
        this.input = input;
        const { storage } = input;
        this.tracking = input.ownership.isOwned() ? this.createTracking() : undefined;
        this.recovery = createALStorageRecoveryReporter({
            getStorageOpening: () => this.restored?.opening,
            getReservationExpiredDeleteCount: () => this.restored?.expiredWorkCount ?? 0,
            storageHealth: storage.health,
            lane: undefined
        });
    }

    isOwned(): boolean {
        return this.input.ownership.isOwned();
    }

    /** Owner only, once: a runtime that does not own the work restores when it takes ownership over. */
    async restore(): Promise<void> {
        if (!this.isOwned()) {
            return;
        }
        this.restoring ??= this.readAndLoad().finally(() => this.trackTakenOver());
        await this.restoring;
    }

    /** Ownership turned to this runtime after construction: the restore runs, then the lane is told it ran. */
    onTakenOverDo(listener: () => void): Unsubscribe {
        return this.input.ownership.owned.onChangeDo(() => {
            this.restore().then(listener, (error) => console.error('AL checkpoint restore failed', toError(error)));
        });
    }

    reportFirstBatch(claimedCount: number): void {
        this.recovery.reportFirstBatch(claimedCount);
    }

    flush(): void {
        this.tracking?.writer.flush();
    }

    /** A disconnect inside the interval still saves what the interval has not; the write is not awaited. */
    dispose(): void {
        this.disposed = true;
        if (this.tracking === undefined) {
            return;
        }
        this.tracking.writer.flush();
        this.tracking.writer.dispose();
        this.tracking.dirty.dispose();
    }

    private createTracking(): ALCheckpointTracking {
        const { storage, nowMs } = this.input;
        const dirty = new ALCheckpointDirtySet({ backend: storage.memory, nowMs });
        const writer = new ALCheckpointWriter({
            memory: storage.memory,
            dirty,
            write: (mutations) => this.write(mutations),
            health: storage.health,
            settings: storage.settings,
            nowMs,
            newWriteToken: storage.newWriteToken,
            timers: storage.timers
        });
        return { dirty, writer };
    }

    private trackTakenOver(): void {
        if (this.tracking !== undefined || this.disposed) {
            return;
        }
        this.tracking = this.createTracking();
        this.tracking.dirty.markHeld();
    }

    /**
     * A store that cannot be read, or a saved row that cannot be decoded, is stated on the store's health
     * and the lane runs from what memory holds: the runtime's readiness awaits every lane, so a rejection
     * here would fail every send of the carrier.
     */
    private async readAndLoad(): Promise<void> {
        const { saved, selection, health } = this.input.storage;
        try {
            const read = await saved.readNamespaceRows(selection);
            this.restored = { opening: saved.getStorageOpening(), expiredWorkCount: this.loadLiveRows(read) };
        }
        catch (error) {
            health.recordFailure(toALStorageFailure(toError(error)));
        }
    }

    /**
     * One synchronous turn: every live row is decoded before any loads, so a corrupt row leaves the pair
     * as it was; the live rows then load beside what the pair holds, and the expired work rows are counted.
     */
    private loadLiveRows(read: IndexedDbAdmissionBackend.NamespaceRows): number {
        const nowMs = this.input.nowMs();
        const now = Temporal.Instant.fromEpochMilliseconds(nowMs);
        const liveWorkRows = read.workRows.filter((row) => !isStoredQueueEntryExpired(row, now));
        const liveRows = read.rows.filter((row) => row.expireAtTimestamp > nowMs).map(toALAdmissionStoredValue);
        const liveEntries = liveWorkRows.map((row) => decodeStoredResourceEntry(row));
        const loadLive = () => this.input.storage.memory.loadIfAbsent(liveRows, liveEntries);
        if (this.tracking === undefined) {
            loadLive();
        }
        else {
            this.tracking.dirty.loadWithoutMarking(loadLive);
        }
        return read.workRows.filter((row) => row.key.topicId === 'AL_OUTBOUND' && !liveWorkRows.includes(row)).length;
    }

    private async write(mutations: ALCheckpointMutations): Promise<void> {
        if (!await this.input.storage.saved.writeUnfencedMutations(mutations)) {
            throw new ALAdmissionBackendConflictError('An AL checkpoint write conflicted');
        }
    }
}

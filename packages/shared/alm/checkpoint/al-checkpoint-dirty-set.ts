import { LatestRepository } from '../../cache/LatestRepository.ts';
import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import type { InMemoryAdmissionBackend } from '../al-admission-backend.ts';

export namespace ALCheckpointDirtySet {
    /** The object store a row lands in: an admission row of `entries`, or a queue entry of `alm-work`. */
    export type Space = 'admission' | 'queue';

    export interface Mark {
        readonly space: Space;
        readonly key: string;
        /** The set's change count at the key's latest change; a save clears the key only at this revision. */
        readonly revision: number;
    }

    export interface Snapshot {
        readonly marks: readonly Mark[];
        readonly takenAtMs: number;
    }

    export interface Input {
        /** The memory pair whose admission rows and work queue the set follows. */
        readonly backend: Pick<InMemoryAdmissionBackend, 'onChangeDo' | 'peekKeys' | 'workQueue'>;
        readonly nowMs: () => number;
    }
}

interface ALCheckpointDirtyRow {
    readonly revision: number;
    readonly dirtiedAtMs: number;
}

/**
 * The keys of one memory pair changed since its checkpoint last saved them. A key changed several
 * times is one mark at its latest revision, so a save that captured an older revision leaves it dirty.
 */
export class ALCheckpointDirtySet {
    private readonly backend: ALCheckpointDirtySet.Input['backend'];
    private readonly nowMs: () => number;
    private readonly admissionRows = new LatestRepository<string, ALCheckpointDirtyRow>();
    private readonly queueRows = new LatestRepository<string, ALCheckpointDirtyRow>();
    private readonly markedListeners = new Set<() => void>();
    private readonly subscriptions: readonly Unsubscribe[];
    private revision = 0;
    private loading = false;

    constructor(input: ALCheckpointDirtySet.Input) {
        this.backend = input.backend;
        this.nowMs = input.nowMs;
        this.subscriptions = [
            input.backend.onChangeDo((key) => this.mark(this.admissionRows, key)),
            input.backend.workQueue.onChangeDo((key) => this.mark(this.queueRows, key))
        ];
    }

    /** Called after every mark, in the turn of the change that made it. */
    onMarkedDo(listener: () => void): Unsubscribe {
        this.markedListeners.add(listener);
        return { unsubscribe: () => this.markedListeners.delete(listener) };
    }

    isClean(): boolean {
        return this.admissionRows.size() === 0 && this.queueRows.size() === 0;
    }

    /** When the longest-unsaved key last held saved state; undefined while the set is clean. */
    getOldestDirtiedAtMs(): number | undefined {
        return [...this.admissionRows.readAllValues(), ...this.queueRows.readAllValues()].reduce<number | undefined>(
            (oldest, row) => oldest === undefined ? row.dirtiedAtMs : Math.min(oldest, row.dirtiedAtMs),
            undefined
        );
    }

    getSnapshot(): ALCheckpointDirtySet.Snapshot {
        return {
            marks: [...toMarks('admission', this.admissionRows), ...toMarks('queue', this.queueRows)],
            takenAtMs: this.nowMs()
        };
    }

    /**
     * Clears every key a completed save captured at its latest revision. A key changed since stays
     * dirty, and is counted unsaved from the snapshot on: its newer change came after it.
     */
    clearSaved(snapshot: ALCheckpointDirtySet.Snapshot): void {
        for (const mark of snapshot.marks) {
            const rows = mark.space === 'admission' ? this.admissionRows : this.queueRows;
            const row = rows.peek(mark.key);
            if (row?.revision === mark.revision) {
                rows.delete(mark.key);
            }
            else if (row !== undefined) {
                rows.set(mark.key, { ...row, dirtiedAtMs: Math.max(row.dirtiedAtMs, snapshot.takenAtMs) });
            }
        }
    }

    /** Runs a synchronous load of rows the checkpoint already holds: the changes it makes mark nothing. */
    loadWithoutMarking(load: () => void): void {
        this.loading = true;
        try {
            load();
        }
        finally {
            this.loading = false;
        }
    }

    /** Marks every row the pair holds now, so the next save writes all of them. */
    markHeld(): void {
        for (const key of this.backend.peekKeys()) {
            this.mark(this.admissionRows, key);
        }
        for (const key of this.backend.workQueue.peekKeys()) {
            this.mark(this.queueRows, key);
        }
    }

    dispose(): void {
        for (const subscription of this.subscriptions) {
            subscription.unsubscribe();
        }
    }

    private mark(rows: LatestRepository<string, ALCheckpointDirtyRow>, key: string): void {
        if (this.loading) {
            return;
        }
        this.revision += 1;
        const dirtiedAtMs = rows.peek(key)?.dirtiedAtMs ?? this.nowMs();
        rows.set(key, { revision: this.revision, dirtiedAtMs });
        for (const listener of this.markedListeners) {
            listener();
        }
    }
}

function toMarks(
    space: ALCheckpointDirtySet.Space,
    rows: LatestRepository<string, ALCheckpointDirtyRow>
): ALCheckpointDirtySet.Mark[] {
    return [...rows.entriesView()].flatMap(([key, entry]) => {
        const row = entry.peek();
        return row === undefined ? [] : [{ space, key, revision: row.revision }];
    });
}

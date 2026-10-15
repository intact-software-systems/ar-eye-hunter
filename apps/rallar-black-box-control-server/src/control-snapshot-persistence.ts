import type { ControlRunSnapshotBounds, ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeArrayItems } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/artifact-json-value-guards.ts';
import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { validateControlFleetRunReportCollection } from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ControlSnapshotRevision } from './control-service-snapshots.ts';
import type { RallarBlackBoxControlService } from './control-service.ts';
import type { ControlTimers } from './control-timers.ts';

export interface ControlSnapshotPersistenceInput {
    readonly storageDir: string | undefined;
    readonly retentionMaxRuns: number;
    readonly snapshotBounds: ControlRunSnapshotBounds;
    /** The least time between two snapshot writes; a distributed-run lifecycle change writes at once. */
    readonly flushIntervalMs: number;
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        'applyRunRetention' | 'restoreSnapshot' | 'snapshotForPersistence' | 'snapshotRevision'
    >;
    readonly deleteRuns: (runIds: readonly string[]) => void;
    readonly timers: ControlTimers;
}

interface ScheduledSnapshotFlush {
    readonly dueEpochMs: number;
    readonly cancel: () => void;
}

const SNAPSHOT_FILE_SCHEMA_VERSION = 1;

/**
 * Writes the whole snapshot at most once per flush interval, trailing the last change, and skips the serialization
 * when the service revision has not moved since the last write. One write is in flight at a time.
 */
export class ControlSnapshotPersistence {
    private readonly input: ControlSnapshotPersistenceInput;
    private sequence = 0;
    private dirty = false;
    private lastFlushEpochMs = Number.NEGATIVE_INFINITY;
    private flushedLifecycle: string | undefined;
    private written: ControlSnapshotRevision | undefined;
    private flushing: Promise<void> | undefined;
    private scheduled: ScheduledSnapshotFlush | undefined;

    constructor(input: ControlSnapshotPersistenceInput) {
        this.input = input;
    }

    async restore(): Promise<void> {
        if (this.input.storageDir) {
            await restoreSnapshotFile(toSnapshotPath(this.input.storageDir), this.input.controlService);
        }
    }

    persist(): void {
        applyAutomaticRetention(this.input);
        if (!this.input.storageDir) {
            return;
        }
        this.dirty = true;
        if (!this.flushing) {
            this.scheduleFlush();
        }
    }

    /** Writes an unsaved change at once; shutdown awaits it. */
    async stop(): Promise<void> {
        await this.flushing;
        this.scheduled?.cancel();
        this.scheduled = undefined;
        if (this.dirty) {
            await this.flush();
        }
    }

    private scheduleFlush(): void {
        const nowEpochMs = this.input.timers.nowEpochMs();
        const lifecycleChanged = this.input.controlService.snapshotRevision().lifecycle !== this.flushedLifecycle;
        const dueEpochMs = lifecycleChanged
            ? nowEpochMs
            : Math.max(nowEpochMs, this.lastFlushEpochMs + this.input.flushIntervalMs);
        if (this.scheduled !== undefined && this.scheduled.dueEpochMs <= dueEpochMs) {
            return;
        }
        this.scheduled?.cancel();
        this.scheduled = {
            dueEpochMs,
            cancel: this.input.timers.schedule(() => this.flush(), dueEpochMs - nowEpochMs)
        };
    }

    private async flush(): Promise<void> {
        this.scheduled = undefined;
        this.flushing = this.writeChangedSnapshot();
        await this.flushing;
        this.flushing = undefined;
        if (this.dirty) {
            this.scheduleFlush();
        }
    }

    private async writeChangedSnapshot(): Promise<void> {
        const { storageDir, controlService, snapshotBounds, timers } = this.input;
        this.dirty = false;
        this.lastFlushEpochMs = timers.nowEpochMs();
        const revision = controlService.snapshotRevision();
        this.flushedLifecycle = revision.lifecycle;
        if (!storageDir || revision.content === this.written?.content) {
            return;
        }
        const snapshotJson = JSON.stringify(controlService.snapshotForPersistence(snapshotBounds));
        const tempPath = `${toSnapshotPath(storageDir)}.tmp-${Deno.pid}-${this.lastFlushEpochMs}-${this.sequence += 1}`;
        if (await writeSnapshotFile(storageDir, tempPath, toSnapshotFileText(snapshotJson, this.lastFlushEpochMs))) {
            this.written = revision;
        }
    }
}

function applyAutomaticRetention(input: ControlSnapshotPersistenceInput): void {
    const deletedRunIds = input.controlService.applyRunRetention(input.retentionMaxRuns);
    if (deletedRunIds.length > 0) {
        input.deleteRuns(deletedRunIds);
    }
}

function toSnapshotPath(storageDir: string): string {
    return `${storageDir.replace(/\/+$/, '')}/control-snapshot.json`;
}

function toSnapshotFileText(snapshotJson: string, savedAtEpochMs: number): string {
    return `{"schemaVersion":${SNAPSHOT_FILE_SCHEMA_VERSION},"savedAtEpochMs":${savedAtEpochMs},"snapshot":${snapshotJson}}`;
}

async function writeSnapshotFile(storageDir: string, tempPath: string, payload: string): Promise<boolean> {
    const path = toSnapshotPath(storageDir);
    try {
        await Deno.mkdir(storageDir, { recursive: true });
        await Deno.writeTextFile(tempPath, payload);
        await Deno.rename(tempPath, path);
        return true;
    }
    catch (error) {
        Deno.remove(tempPath).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not persist control snapshot to ${path}: ${message}`);
        return false;
    }
}

async function restoreSnapshotFile(
    path: string,
    controlService: ControlSnapshotPersistenceInput['controlService']
): Promise<void> {
    try {
        decodeSnapshotFile(JSON.parse(await Deno.readTextFile(path))).fold(
            (issue) => console.warn(`Could not restore control snapshot from ${path}: ${issue}`),
            (snapshot) => {
                controlService.restoreSnapshot(snapshot);
                console.log(`Restored Rallar black-box control snapshot from ${path}`);
            }
        );
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not restore control snapshot from ${path}: ${message}`);
    }
}

/** A snapshot written before one of its fields became required does not decode and is not loaded. */
function decodeSnapshotFile(value: unknown): Either<string, ControlServerSnapshot> {
    if (!isJsonRecordValue(value) || !isJsonRecordValue(value.snapshot)) {
        return Either.ofLeft('the file holds no control snapshot object');
    }
    const { runs, distributedRuns, fleetReports } = value.snapshot;
    if (!Array.isArray(fleetReports)) {
        return Either.ofLeft('fleetReports must be an array');
    }
    const fleet = validateControlFleetRunReportCollection(fleetReports);
    const fleetIssue = fleet.issues[0];
    if (!fleet.ok) {
        return Either.ofLeft(`fleetReports${fleetIssue?.path.slice(1) ?? ''}: ${fleetIssue?.message ?? 'invalid'}`);
    }
    const decodedDistributedRuns = decodeArrayItems(
        distributedRuns,
        'distributedRuns',
        (run, runPath) => decodeControlDistributedRunSnapshot(run).mapLeft((issue) => `${runPath}: ${issue}`)
    );
    return decodeArrayItems(
        runs,
        'runs',
        (run, runPath) => decodeControlRunSnapshot(run).mapLeft((issue) => `${runPath}: ${issue}`)
    ).flatMap(
        (issue) => Either.ofLeft(issue),
        (restoredRuns) =>
            decodedDistributedRuns.mapRight((restoredDistributedRuns) => ({
                runs: restoredRuns,
                distributedRuns: restoredDistributedRuns,
                fleetReports: fleet.reports
            }))
    );
}

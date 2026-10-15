import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type {
    ControlRunSnapshot,
    ControlRunSnapshotBounds,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlRunCompletion } from '@shared-test/rallar-bb-test/control/control-run-completion.ts';
import { decodeArrayItems } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/artifact-json-value-guards.ts';
import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { validateControlFleetRunReportCollection } from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import { ThrottledFlush } from '@shared/resilience/throttled-flush.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import type { ControlSnapshotRevision } from './control-service-snapshots.ts';
import type { RallarBlackBoxControlService } from './control-service.ts';
import {
    toJsonPieces,
    writeSlicedJsonFile,
    type SlicedJsonFileWrite
} from './run-completion/control-sliced-json-file.ts';

export interface ControlSnapshotPersistenceInput {
    readonly storageDir: string | undefined;
    readonly retentionMaxRuns: number;
    readonly snapshotBounds: ControlRunSnapshotBounds;
    /** The least time between two snapshot writes; a distributed-run lifecycle change writes at once. */
    readonly flushIntervalMs: number;
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        | 'applyRunRetention'
        | 'restoreSnapshot'
        | 'snapshotForPersistence'
        | 'snapshotLifecycleRevision'
        | 'snapshotRevision'
    >;
    readonly deleteRuns: (runIds: readonly string[]) => void;
    readonly timers: Timers;
    /** Absent when flushes are not timed. */
    readonly timingSink: RallarTimingSink | undefined;
}

interface WriteControlSnapshotFileInput {
    readonly path: string;
    readonly tempPath: string;
    readonly savedAtEpochMs: number;
    readonly snapshot: ControlServerSnapshot;
}

const SNAPSHOT_FILE_SCHEMA_VERSION = 1;

/**
 * Writes the whole snapshot at most once per flush interval: at once when the interval has passed or the
 * distributed-run lifecycle moved since the last write, otherwise trailing the changes inside the interval. It skips the serialization when the service revision has not
 * moved since the last write. One write is in flight at a time.
 */
export class ControlSnapshotPersistence {
    private readonly input: ControlSnapshotPersistenceInput;
    private readonly flush: ThrottledFlush;
    private sequence = 0;
    private flushedLifecycle: string | undefined;
    private written: ControlSnapshotRevision | undefined;

    constructor(input: ControlSnapshotPersistenceInput) {
        this.input = input;
        this.flush = new ThrottledFlush(
            { timers: input.timers, write: () => this.writeChangedSnapshot() },
            { minIntervalMs: input.flushIntervalMs }
        );
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
        void this.flush.mark(this.input.controlService.snapshotLifecycleRevision() !== this.flushedLifecycle);
    }

    /** Writes an unsaved change at once; shutdown awaits it. */
    async stop(): Promise<void> {
        await this.flush.stop();
    }

    private async writeChangedSnapshot(): Promise<void> {
        const { storageDir, controlService, snapshotBounds, timers } = this.input;
        const savedAtEpochMs = timers.nowMs();
        const revision = controlService.snapshotRevision();
        this.flushedLifecycle = revision.lifecycle;
        if (!storageDir || revision.content === this.written?.content) {
            return;
        }
        const write = await writeControlSnapshotFile({
            path: toSnapshotPath(storageDir),
            tempPath: `${toSnapshotPath(storageDir)}.tmp-${Deno.pid}-${savedAtEpochMs}-${this.sequence += 1}`,
            savedAtEpochMs,
            snapshot: controlService.snapshotForPersistence(snapshotBounds)
        });
        recordSnapshotFlushTiming(this.input.timingSink, write);
        if (write.written) {
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

function recordSnapshotFlushTiming(sink: RallarTimingSink | undefined, write: SlicedJsonFileWrite): void {
    recordRallarTiming({
        sink,
        event: {
            component: 'rallar-black-box-control',
            operation: 'snapshot.flush',
            details: {
                bytes: write.bytes,
                serializeMs: Math.round(write.serializeMs),
                writeMs: Math.round(write.writeMs)
            }
        },
        status: write.written ? 'ok' : 'error',
        durationMs: write.serializeMs + write.writeMs
    });
}

/** The file holds the sliced snapshot inside a small envelope; see `writeSlicedJsonFile` for the slicing. */
async function writeControlSnapshotFile(input: WriteControlSnapshotFileInput): Promise<SlicedJsonFileWrite> {
    const write = await writeSlicedJsonFile({
        path: input.path,
        tempPath: input.tempPath,
        pieces: toSnapshotFilePieces(input.snapshot, input.savedAtEpochMs)
    });
    if (write.failure !== undefined) {
        console.warn(`Could not persist control snapshot to ${input.path}: ${write.failure}`);
    }
    return write;
}

function* toSnapshotFilePieces(snapshot: ControlServerSnapshot, savedAtEpochMs: number): Generator<string> {
    yield `{"schemaVersion":${SNAPSHOT_FILE_SCHEMA_VERSION},"savedAtEpochMs":${savedAtEpochMs},"snapshot":`;
    yield* toJsonPieces(snapshot, 0);
    yield '}';
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
        (run, runPath) => decodePersistedControlRun(run).mapLeft((issue) => `${runPath}: ${issue}`)
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

/** The run decoder keeps the collections; a completed run's index entry is decoded beside them. */
function decodePersistedControlRun(value: unknown): Either<string, ControlRunSnapshot> {
    const completion = isJsonRecordValue(value) ? value.completion : undefined;
    return decodeControlRunSnapshot(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (run) =>
            completion === undefined
                ? Either.ofRight(run)
                : decodeControlRunCompletion(completion).mapRight((decoded) => ({ ...run, completion: decoded }))
    );
}

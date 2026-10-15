import { nowMs, recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { ControlRunSnapshotBounds, ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeArrayItems } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/artifact-json-value-guards.ts';
import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { validateControlFleetRunReportCollection } from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import type { ControlSnapshotRevision } from './control-service-snapshots.ts';
import type { RallarBlackBoxControlService } from './control-service.ts';

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

interface ScheduledSnapshotFlush {
    readonly dueEpochMs: number;
    readonly cancel: () => void;
}

interface WriteControlSnapshotFileInput {
    readonly storageDir: string;
    readonly path: string;
    readonly tempPath: string;
    readonly savedAtEpochMs: number;
    readonly snapshot: ControlServerSnapshot;
}

interface ControlSnapshotFileWrite {
    readonly written: boolean;
    readonly bytes: number;
    /** Time spent serializing and encoding, summed over the slices; the event loop runs between slices. */
    readonly serializeMs: number;
    readonly writeMs: number;
}

/** A 50-agent snapshot is tens of megabytes; serializing it in one call held every agent frame for seconds on the VM. */
const SNAPSHOT_SLICE_LENGTH = 1024 * 1024;
/** Runs, their command/result/event lists and those lists' entries are serialized one entry at a time. */
const SLICED_DEPTH = 4;
const SNAPSHOT_FILE_SCHEMA_VERSION = 1;

type JsonPieceSource = string | number | boolean | bigint | symbol | null | undefined | object;

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
        const nowEpochMs = this.input.timers.nowMs();
        const lifecycleChanged = this.input.controlService.snapshotLifecycleRevision() !== this.flushedLifecycle;
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
        this.lastFlushEpochMs = timers.nowMs();
        const revision = controlService.snapshotRevision();
        this.flushedLifecycle = revision.lifecycle;
        if (!storageDir || revision.content === this.written?.content) {
            return;
        }
        const write = await writeControlSnapshotFile({
            storageDir,
            path: toSnapshotPath(storageDir),
            tempPath: `${toSnapshotPath(storageDir)}.tmp-${Deno.pid}-${this.lastFlushEpochMs}-${this.sequence += 1}`,
            savedAtEpochMs: this.lastFlushEpochMs,
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

function recordSnapshotFlushTiming(sink: RallarTimingSink | undefined, write: ControlSnapshotFileWrite): void {
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

/**
 * Streams the compact snapshot file into a temporary file one slice at a time and renames it over the snapshot. Each
 * slice write awaits the disk, so agent frames are handled between slices instead of after the whole serialization.
 */
async function writeControlSnapshotFile(
    input: WriteControlSnapshotFileInput
): Promise<ControlSnapshotFileWrite> {
    const encoder = new TextEncoder();
    let bytes = 0;
    let serializeMs = 0;
    let writeMs = 0;
    try {
        await Deno.mkdir(input.storageDir, { recursive: true });
        const file = await Deno.open(input.tempPath, { write: true, create: true, truncate: true });
        const writer = file.writable.getWriter();
        const slices = toSnapshotFileSlices(input.snapshot, input.savedAtEpochMs);
        for (let startedMs = nowMs(), slice = slices.next(); !slice.done; startedMs = nowMs(), slice = slices.next()) {
            const encoded = encoder.encode(slice.value);
            const encodedMs = nowMs();
            serializeMs += encodedMs - startedMs;
            await writer.write(encoded);
            writeMs += nowMs() - encodedMs;
            bytes += encoded.length;
        }
        await writer.close();
        await Deno.rename(input.tempPath, input.path);
        return { written: true, bytes, serializeMs, writeMs };
    }
    catch (error) {
        Deno.remove(input.tempPath).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not persist control snapshot to ${input.path}: ${message}`);
        return { written: false, bytes, serializeMs, writeMs };
    }
}

function* toSnapshotFileSlices(snapshot: ControlServerSnapshot, savedAtEpochMs: number): Generator<string> {
    let parts = [`{"schemaVersion":${SNAPSHOT_FILE_SCHEMA_VERSION},"savedAtEpochMs":${savedAtEpochMs},"snapshot":`];
    let length = parts[0].length;
    for (const piece of toJsonPieces(snapshot, 0)) {
        parts.push(piece);
        length += piece.length;
        if (length >= SNAPSHOT_SLICE_LENGTH) {
            yield parts.join('');
            parts = [];
            length = 0;
        }
    }
    parts.push('}');
    yield parts.join('');
}

/** The pieces concatenate to `JSON.stringify(value)`; containers above the sliced depth are split at their entries. */
export function* toJsonPieces(value: JsonPieceSource, depth: number): Generator<string> {
    if (depth >= SLICED_DEPTH || value === null || typeof value !== 'object' || 'toJSON' in value) {
        yield JSON.stringify(value) ?? 'null';
        return;
    }
    if (Array.isArray(value)) {
        yield '[';
        for (const [index, item] of value.entries()) {
            yield index === 0 ? '' : ',';
            yield* isSkippedJsonValue(item) ? ['null'] : toJsonPieces(item, depth + 1);
        }
        yield ']';
        return;
    }
    let separator = '';
    yield '{';
    for (const [key, item] of Object.entries(value)) {
        if (!isSkippedJsonValue(item)) {
            yield `${separator}${JSON.stringify(key)}:`;
            yield* toJsonPieces(item, depth + 1);
            separator = ',';
        }
    }
    yield '}';
}

function isSkippedJsonValue(value: JsonPieceSource): boolean {
    return value === undefined || typeof value === 'function' || typeof value === 'symbol';
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

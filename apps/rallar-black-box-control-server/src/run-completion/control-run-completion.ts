import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { ControlRunSnapshot, ControlRunSnapshotBounds } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    CONTROL_RUN_COMPLETION_FILE_NAME,
    type ControlRunCompletion,
    type ControlRunCompletionCounts
} from '@shared-test/rallar-bb-test/control/control-run-completion.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { isDistributedRunTerminalState } from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import { Either } from '@shared/resilience/Either.ts';
import { FailureBackoff } from '@shared/resilience/failure-backoff.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import { toArtifactRunDirectory, toRunDirectoryName } from '../control-artifact-storage.ts';
import { toBoundedTail } from '../control-runtime-retention.ts';
import { toControlServiceFailure, type ControlServiceFailure } from '../control-service-failure.ts';
import type { ControlDistributedRunState, ControlRunState } from '../control-service-state.ts';
import type { RallarBlackBoxControlService } from '../control-service.ts';
import type { ControlSnapshotPersistence } from '../control-snapshot-persistence.ts';
import { toJsonPieces, writeSlicedJsonFile, type SlicedJsonFileWrite } from './control-sliced-json-file.ts';

export interface ControlRunCompletionConfig {
    /** A run completes once its last change is at least this old, so an agent reconnecting right after a run is not refused. */
    readonly quietMs: number;
    readonly scanIntervalMs: number;
    /** The wait after a failed file write; the run stays live, in every flush, until a write succeeds. */
    readonly retryBackoff: FailureBackoff.Config;
}

export const DEFAULT_CONTROL_RUN_COMPLETION_CONFIG: ControlRunCompletionConfig = {
    quietMs: 5_000,
    scanIntervalMs: 1_000,
    retryBackoff: { baseMs: 5_000, maxMs: 60_000 }
};

export interface ControlCompletableRunInput {
    readonly run: ControlRunState;
    readonly distributedRuns: Iterable<ControlDistributedRunState>;
    readonly quietSinceEpochMs: number;
}

export interface ControlCompletableRunsInput {
    readonly runs: Iterable<ControlRunState>;
    readonly distributedRuns: Iterable<ControlDistributedRunState>;
    readonly quietSinceEpochMs: number;
}

/** A completable run's every row, read while they are still in memory, and the revision they belong to. */
export interface ControlRunCompletionSnapshot {
    readonly snapshot: ControlRunSnapshot;
    readonly retentionRevision: number;
}

export interface ArchiveCompletedRunInput {
    readonly runId: string;
    /** The revision the file was written from; a run that moved on since is archived on a later pass. */
    readonly retentionRevision: number;
    readonly completion: ControlRunCompletion;
}

export type ControlRunReadIssueCode = 'run-not-found' | 'completed-run-file-missing' | 'completed-run-file-invalid';

export interface ControlRunReadIssue {
    readonly code: ControlRunReadIssueCode;
    readonly message: string;
}

export interface ControlCompletedRunArchiveDependencies {
    readonly storageDir: string | undefined;
    readonly controlService: Pick<
        RallarBlackBoxControlService,
        | 'archiveCompletedRun'
        | 'markCompletedRunFileMissing'
        | 'resolveCompletableRunIds'
        | 'snapshot'
        | 'snapshotRun'
        | 'snapshotRunForCompletion'
    >;
    readonly persistence: Pick<ControlSnapshotPersistence, 'persist'>;
    readonly timers: Timers;
    /** Absent when completion writes are not timed. */
    readonly timingSink: RallarTimingSink | undefined;
    readonly config: ControlRunCompletionConfig;
}

/**
 * A live run is completable once every distributed run it hosts is terminal, every agent has left and nothing
 * changed it since the quiet instant; a run without a distributed run is a plain command queue and stays live.
 */
export function isCompletableControlRun(
    { run, distributedRuns, quietSinceEpochMs }: ControlCompletableRunInput
): boolean {
    if (run.completion !== undefined || run.updatedAtEpochMs > quietSinceEpochMs) {
        return false;
    }
    let hosted = 0;
    for (const distributedRun of distributedRuns) {
        if (distributedRun.controlRunId !== run.runId) {
            continue;
        }
        if (!isDistributedRunTerminalState(distributedRun.state)) {
            return false;
        }
        hosted += 1;
    }
    return hosted > 0 && Array.from(run.agents.values()).every((agent) => !agent.connected);
}

export function resolveCompletableControlRunIds(input: ControlCompletableRunsInput): readonly string[] {
    const distributedRuns = Array.from(input.distributedRuns);
    return Array.from(input.runs)
        .filter((run) => isCompletableControlRun({ run, distributedRuns, quietSinceEpochMs: input.quietSinceEpochMs }))
        .map((run) => run.runId);
}

/** The run may be archived only from the revision its file was written from; a run that moved on keeps its rows. */
export function resolveArchivableControlRun(
    run: ControlRunState | undefined,
    input: ArchiveCompletedRunInput
): Either<ControlServiceFailure, ControlRunState> {
    if (run === undefined) {
        return toControlServiceFailure('run-not-found', `Run not found: ${input.runId}.`);
    }
    if (run.retentionRevision !== input.retentionRevision) {
        return toControlServiceFailure('run-changed', `Run ${input.runId} changed while its rows were being written.`);
    }
    return Either.ofRight(run);
}

/** The run itself while it is live; undefined once completed or unknown. */
export function resolveLiveControlRun(run: ControlRunState | undefined): ControlRunState | undefined {
    return run?.completion === undefined ? run : undefined;
}

/** The index entry reports the loss and moves the retention revision; the retention order is unchanged. */
export function markControlRunFileMissing(run: ControlRunState | undefined): void {
    if (run?.completion === undefined || run.completion.file.state === 'missing') {
        return;
    }
    run.completion = { ...run.completion, file: { ...run.completion.file, state: 'missing' } };
    run.retentionRevision += 1;
}

/** Empties the run's rows in place and records where they went; the agents and their counters stay as the index. */
export function completeControlRun(run: ControlRunState, completion: ControlRunCompletion): void {
    run.commands.clear();
    run.results.clear();
    run.events = [];
    run.stats = [];
    run.reports = [];
    run.reportKeys.clear();
    run.heartbeats = [];
    run.barriers.clear();
    run.completion = completion;
}

/**
 * Moves each completed run's rows out of the live snapshot into its own file, once, and serves every run read:
 * a live run from memory, a completed run from its file. One write per run is in flight at a time, and a run
 * whose write failed waits its backoff before the next attempt.
 */
export class ControlCompletedRunArchive {
    private readonly dependencies: ControlCompletedRunArchiveDependencies;
    private readonly writes = new SingleFlight<string, boolean>();
    private readonly retries = new Map<string, FailureBackoff>();
    private sequence = 0;

    constructor(dependencies: ControlCompletedRunArchiveDependencies) {
        this.dependencies = dependencies;
    }

    /** Answers the stop of the completion sweep. */
    start(): () => void {
        return startRepeating({
            timers: this.dependencies.timers,
            intervalMs: this.dependencies.config.scanIntervalMs,
            firstRun: 'after-interval',
            run: () => this.completeRuns().then(() => undefined)
        });
    }

    /** One sweep: writes every completable run's rows and archives the runs whose write succeeded; answers their ids. */
    async completeRuns(): Promise<readonly string[]> {
        const { storageDir, controlService, timers, config } = this.dependencies;
        if (!storageDir) {
            return [];
        }
        const nowEpochMs = timers.nowMs();
        const archived: string[] = [];
        for (const runId of controlService.resolveCompletableRunIds(nowEpochMs - config.quietMs)) {
            if (this.retries.get(runId)?.getRetryAtMs(nowEpochMs) !== undefined) {
                continue;
            }
            if (await this.writes.run(runId, () => this.completeRun(storageDir, runId))) {
                archived.push(runId);
            }
        }
        if (archived.length > 0) {
            this.dependencies.persistence.persist();
        }
        return archived;
    }

    /** A live run from memory, a completed run from its file, both bounded alike. */
    async readRun(
        runId: string,
        bounds: ControlRunSnapshotBounds
    ): Promise<Either<ControlRunReadIssue, ControlRunSnapshot>> {
        const { storageDir, controlService } = this.dependencies;
        const snapshot = controlService.snapshotRun(runId, bounds);
        if (!snapshot) {
            return Either.ofLeft({ code: 'run-not-found', message: 'Run not found.' });
        }
        if (snapshot.completion === undefined || !storageDir) {
            return Either.ofRight(snapshot);
        }
        return (await this.readCompletionFile(storageDir, runId, snapshot.completion))
            .mapRight((rows) => toBoundedCompletedRunSnapshot(rows, snapshot, bounds));
    }

    /** After a restart: each completed run whose file is gone is reported on its index entry, the others are served. */
    async restore(): Promise<void> {
        const { storageDir, controlService } = this.dependencies;
        if (!storageDir) {
            return;
        }
        for (const { runId, completion } of controlService.snapshot().runs) {
            if (
                completion?.file.state === 'present' && !(await isPresentFile(`${storageDir}/${completion.file.path}`))
            ) {
                this.reportMissingFile(runId, completion);
            }
        }
    }

    /** Awaits the writes in flight; shutdown waits for them, a run mid-write is archived or stays live. */
    async stop(): Promise<void> {
        await Promise.all(this.writes.completions());
    }

    private async completeRun(storageDir: string, runId: string): Promise<boolean> {
        const { controlService, timers, timingSink } = this.dependencies;
        const candidate = controlService.snapshotRunForCompletion(runId);
        if (!candidate) {
            return false;
        }
        const path = toCompletionFilePath(storageDir, runId);
        const write = await writeSlicedJsonFile({
            path,
            tempPath: `${path}.tmp-${Deno.pid}-${this.sequence += 1}`,
            pieces: toJsonPieces(candidate.snapshot, 0)
        });
        recordCompletionTiming(timingSink, runId, write);
        if (!write.written) {
            const retryAtEpochMs = this.toRetryBackoff(runId).recordFailure(timers.nowMs());
            console.warn(
                `Could not write the completed run ${runId} to ${path}: ${write.failure}; ` +
                    `the run stays live until the retry at ${new Date(retryAtEpochMs).toISOString()}.`
            );
            return false;
        }
        this.retries.delete(runId);
        const completedAtEpochMs = timers.nowMs();
        return controlService.archiveCompletedRun({
            runId,
            retentionRevision: candidate.retentionRevision,
            completion: {
                completedAtEpochMs,
                retentionRevision: candidate.retentionRevision,
                counts: toCompletionCounts(candidate.snapshot),
                file: {
                    path: toRelativeCompletionFilePath(runId),
                    bytes: write.bytes,
                    writtenAtEpochMs: completedAtEpochMs,
                    state: 'present'
                }
            }
        }).right !== undefined;
    }

    private toRetryBackoff(runId: string): FailureBackoff {
        const existing = this.retries.get(runId);
        if (existing) {
            return existing;
        }
        const backoff = new FailureBackoff(this.dependencies.config.retryBackoff);
        this.retries.set(runId, backoff);
        return backoff;
    }

    private async readCompletionFile(
        storageDir: string,
        runId: string,
        completion: ControlRunCompletion
    ): Promise<Either<ControlRunReadIssue, ControlRunSnapshot>> {
        if (completion.file.state === 'missing') {
            return Either.ofLeft(toMissingFileIssue(runId, completion));
        }
        const path = `${storageDir}/${completion.file.path}`;
        try {
            return decodeControlRunSnapshot(JSON.parse(await Deno.readTextFile(path))).mapLeft((issue) => ({
                code: 'completed-run-file-invalid' as const,
                message: `The completed run ${runId} could not be read from ${completion.file.path}: ${issue}`
            }));
        }
        catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
                const message = error instanceof Error ? error.message : String(error);
                return Either.ofLeft({
                    code: 'completed-run-file-invalid',
                    message: `The completed run ${runId} could not be read from ${completion.file.path}: ${message}`
                });
            }
            this.reportMissingFile(runId, completion);
            return Either.ofLeft(toMissingFileIssue(runId, completion));
        }
    }

    private reportMissingFile(runId: string, completion: ControlRunCompletion): void {
        this.dependencies.controlService.markCompletedRunFileMissing(runId);
        console.warn(`The completed run ${runId} has no file at ${completion.file.path}; its index entry reports it.`);
    }
}

function toMissingFileIssue(runId: string, completion: ControlRunCompletion): ControlRunReadIssue {
    return {
        code: 'completed-run-file-missing',
        message: `The completed run ${runId} has no file at ${completion.file.path}; only its index entry remains.`
    };
}

/** The file's rows under the index entry's agents, timestamps and completion, which the live state keeps current. */
function toBoundedCompletedRunSnapshot(
    rows: ControlRunSnapshot,
    index: ControlRunSnapshot,
    bounds: ControlRunSnapshotBounds
): ControlRunSnapshot {
    return {
        ...index,
        commands: toBoundedTail(rows.commands, bounds.commands),
        results: toBoundedTail(rows.results, bounds.results),
        events: toBoundedTail(rows.events, bounds.events),
        stats: toBoundedTail(rows.stats, bounds.stats),
        reports: toBoundedTail(rows.reports, bounds.reports),
        heartbeats: toBoundedTail(rows.heartbeats, bounds.heartbeats)
    };
}

function toCompletionCounts(snapshot: ControlRunSnapshot): ControlRunCompletionCounts {
    return {
        commands: snapshot.commands.length,
        results: snapshot.results.length,
        events: snapshot.events.length,
        stats: snapshot.stats.length,
        reports: snapshot.reports.length,
        heartbeats: snapshot.heartbeats.length
    };
}

function toCompletionFilePath(storageDir: string, runId: string): string {
    return `${toArtifactRunDirectory(storageDir, runId)}/${CONTROL_RUN_COMPLETION_FILE_NAME}`;
}

function toRelativeCompletionFilePath(runId: string): string {
    return `runs/${toRunDirectoryName(runId)}/${CONTROL_RUN_COMPLETION_FILE_NAME}`;
}

async function isPresentFile(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    }
    catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false;
        }
        throw error;
    }
}

function recordCompletionTiming(sink: RallarTimingSink | undefined, runId: string, write: SlicedJsonFileWrite): void {
    recordRallarTiming({
        sink,
        event: {
            component: 'rallar-black-box-control',
            operation: 'run.completion',
            details: {
                runId,
                bytes: write.bytes,
                serializeMs: Math.round(write.serializeMs),
                writeMs: Math.round(write.writeMs)
            }
        },
        status: write.written ? 'ok' : 'error',
        durationMs: write.serializeMs + write.writeMs
    });
}

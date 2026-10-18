import type { ControlClientIdentity } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    toControlArtifactOverflowRow,
    type ControlArtifactOverflowCounts
} from '@shared-test/rallar-bb-test/control/control-artifact-overflow.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { ResultCaptureReceipt } from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { Either } from '@shared/resilience/Either.ts';
import { ThrottledFlush } from '@shared/resilience/throttled-flush.ts';
import type { Timers } from '@shared/resilience/timers.ts';

import {
    ControlArtifactStorage,
    type ControlArtifactCaptureEntry,
    type ControlArtifactRunWrite
} from './control-artifact-storage.ts';
import {
    controlEventArtifactJsonl,
    controlRunEventsJsonl,
    controlRunResultsJsonl,
    toControlResultArtifactLines
} from './control-artifacts.ts';
import type { RallarBlackBoxControlService } from './control-service.ts';
import { createControlResponseHeaders } from './cors.ts';

export type ControlArtifactJsonlKind = 'events' | 'results';

export interface ControlArtifactResponseInput {
    readonly runId: string;
    readonly kind: ControlArtifactJsonlKind;
    readonly fallbackRun: ControlRunSnapshot;
    readonly corsOrigins: readonly string[];
}

export interface ControlArtifactRecorderConfig {
    /** Delay from the first pending row before a batch starts; later rows join without postponing it. */
    readonly flushIntervalMs: number;
    /**
     * Beyond this many pending bytes a run's oldest pending rows are dropped and the gap is recorded. Rows are counted
     * in UTF-16 code units, which equal bytes for the ASCII JSON the recorder writes.
     */
    readonly maxPendingBytes: number;
}

export interface ControlArtifactRecorderDependencies {
    readonly storageDir: string | undefined;
    readonly commandSnapshots: Pick<RallarBlackBoxControlService, 'snapshotCommand'>;
    readonly timers: Timers;
    readonly config: ControlArtifactRecorderConfig;
}

/**
 * A 50-agent run sends about 75 MB of start results within seconds, and each result is written to both files, so about
 * 150 MB of rows; 160 MiB holds that burst while the disk stalls. Rows stay pending while a batch is being written, so
 * the recorder holds at most about twice the cap: the pending rows plus the one batch in flight.
 */
export const DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG: ControlArtifactRecorderConfig = {
    flushIntervalMs: 250,
    maxPendingBytes: 160 * 1024 * 1024
};

/** One accepted envelope's rows: a result's two rows are kept or dropped together. */
interface PendingArtifactEntry extends ControlArtifactCaptureEntry {
    readonly bytes: number;
}

interface PendingRunArtifacts {
    readonly entries: PendingArtifactEntry[];
    readonly omitted: { omittedResults: number; omittedEventRows: number; omittedBytes: number; };
}

const JSONL_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

/** Appends JSONL rows per run in batches; one batch, delete or read barrier runs at a time, in order. */
export class ControlArtifactRecorder {
    private readonly dependencies: ControlArtifactRecorderDependencies;
    private readonly storage: ControlArtifactStorage | undefined;
    private pendingByRun = new Map<string, PendingRunArtifacts>();
    private pendingBytes = 0;
    private readonly flush: ThrottledFlush;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(dependencies: ControlArtifactRecorderDependencies) {
        this.dependencies = dependencies;
        this.storage = dependencies.storageDir ? new ControlArtifactStorage(dependencies.storageDir) : undefined;
        this.flush = new ThrottledFlush(
            { timers: dependencies.timers, write: () => this.writePending() },
            { minIntervalMs: 0, firstMarkDelayMs: dependencies.config.flushIntervalMs }
        );
    }

    record(
        envelope: ControlClientEnvelope,
        commandBeforeAcceptance?: ControlQueuedCommandSnapshot
    ): Promise<Either<string, readonly ResultCaptureReceipt[]>> {
        if (envelope.kind === 'register' || envelope.kind === 'heartbeat') {
            return Promise.resolve(Either.ofRight([]));
        }
        if (!this.storage) {
            return Promise.resolve(Either.ofLeft('Durable artifact storage is not configured.'));
        }
        const commandId = toArtifactCommandId(envelope);
        const command = commandBeforeAcceptance ??
            (commandId ? this.dependencies.commandSnapshots.snapshotCommand(envelope.runId, commandId) : undefined);
        return new Promise((finish) => {
            const pending = this.pendingByRun.get(envelope.runId) ??
                { entries: [], omitted: { omittedResults: 0, omittedEventRows: 0, omittedBytes: 0 } };
            const entry = toPendingArtifactEntry(envelope, command, finish);
            pending.entries.push(entry);
            this.pendingByRun.set(envelope.runId, pending);
            this.pendingBytes += entry.bytes;
            this.dropOldestOverCap(pending);
            void this.flush.mark();
        });
    }

    async readResultReceipts(
        identity: ControlClientIdentity,
        commandIds: readonly string[]
    ): Promise<Either<string, readonly ResultCaptureReceipt[]>> {
        if (!this.storage) {
            return Either.ofLeft('Durable artifact storage is not configured.');
        }
        await this.stop();
        return await this.storage.readResultReceipts(identity, commandIds);
    }

    deleteRun(runId: string): void {
        const storage = this.storage;
        if (!storage) {
            return;
        }
        const pending = this.pendingByRun.get(runId);
        for (const entry of pending?.entries ?? []) {
            entry.finish(Either.ofLeft('The run was deleted before durable capture completed.'));
        }
        this.pendingBytes -= toPendingBytes(pending);
        this.pendingByRun.delete(runId);
        this.writeQueue = this.writeQueue
            .then(() => storage.deleteRun(runId))
            .catch(() => undefined);
    }

    /** Writes every pending row once the batch in flight is written; reads and shutdown await it. */
    async stop(): Promise<void> {
        await this.flush.drain();
        await this.writeQueue;
    }

    async response({ runId, kind, fallbackRun, corsOrigins }: ControlArtifactResponseInput): Promise<Response> {
        const headers = createControlResponseHeaders(undefined, { contentType: JSONL_CONTENT_TYPE, corsOrigins });
        if (this.storage) {
            await this.stop();
            const readable = await this.storage.openRunFile(runId, `${kind}.jsonl`);
            if (readable) {
                return new Response(readable, { status: 200, headers });
            }
        }

        const text = kind === 'events' ? controlRunEventsJsonl(fallbackRun) : controlRunResultsJsonl(fallbackRun);
        return new Response(text, { status: 200, headers });
    }

    /** Only the recording run gives up rows, oldest first, so one run's burst never erases another run's evidence. */
    private dropOldestOverCap(pending: PendingRunArtifacts): void {
        let dropCount = 0;
        while (this.pendingBytes > this.dependencies.config.maxPendingBytes && dropCount < pending.entries.length) {
            const entry = pending.entries[dropCount];
            this.pendingBytes -= entry.bytes;
            this.storage?.invalidateCapture(entry.identity.runId);
            entry.finish(Either.ofLeft('Artifact rows were dropped before durable capture.'));
            pending.omitted.omittedResults += entry.resultLine === undefined ? 0 : 1;
            pending.omitted.omittedEventRows += 1;
            pending.omitted.omittedBytes += entry.bytes;
            dropCount += 1;
        }
        pending.entries.splice(0, dropCount);
    }

    private writePending(): Promise<void> {
        const storage = this.storage;
        for (const [runId, pending] of this.pendingByRun) {
            if (pending.omitted.omittedEventRows > 0) {
                console.warn(
                    `Control artifact recorder dropped ${pending.omitted.omittedEventRows} pending rows (${pending.omitted.omittedBytes} bytes) for ${runId}.`
                );
            }
        }
        const batch = toArtifactWriteBatch(this.pendingByRun, {
            maxPendingBytes: this.dependencies.config.maxPendingBytes,
            atEpochMs: this.dependencies.timers.nowMs()
        });
        this.pendingByRun = new Map();
        this.pendingBytes = 0;
        if (!storage || batch.length === 0) {
            return this.writeQueue;
        }
        this.writeQueue = this.writeQueue
            .then(() => storage.writeBatch(batch))
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`Could not append control artifact JSONL: ${message}`);
            });
        return this.writeQueue;
    }
}

function toPendingArtifactEntry(
    envelope: Exclude<ControlClientEnvelope, { kind: 'register' | 'heartbeat'; }>,
    command: ControlQueuedCommandSnapshot | undefined,
    finish: PendingArtifactEntry['finish']
): PendingArtifactEntry {
    const lines = envelope.kind === 'result'
        ? toFullResultArtifactLines(envelope, command)
        : { resultLine: undefined, eventLine: controlEventArtifactJsonl(envelope, command) };
    return {
        identity: { runId: envelope.runId, agentId: envelope.agentId },
        finish,
        ...lines,
        bytes: (lines.resultLine?.length ?? 0) + lines.eventLine.length
    };
}

function toPendingBytes(pending: PendingRunArtifacts | undefined): number {
    return pending?.entries.reduce((total, entry) => total + entry.bytes, 0) ?? 0;
}

interface ArtifactOverflowFacts {
    readonly maxPendingBytes: number;
    readonly atEpochMs: number;
}

/** One append per run file, in arrival order; a run that lost rows starts both files with the overflow row. */
function toArtifactWriteBatch(
    pendingByRun: ReadonlyMap<string, PendingRunArtifacts>,
    facts: ArtifactOverflowFacts
): readonly ControlArtifactRunWrite[] {
    return Array.from(pendingByRun, ([runId, pending]) => {
        const overflowLine = toArtifactOverflowLine({
            ...pending.omitted,
            maxPendingBytes: facts.maxPendingBytes
        }, facts.atEpochMs);
        const resultLines = pending.entries.flatMap((entry) =>
            entry.resultLine === undefined ? [] : [entry.resultLine]
        );
        return {
            runId,
            entries: pending.entries,
            resultsText: overflowLine + resultLines.join(''),
            eventsText: overflowLine + pending.entries.map((entry) => entry.eventLine).join('')
        };
    });
}

function toArtifactOverflowLine(counts: ControlArtifactOverflowCounts, atEpochMs: number): string {
    if (counts.omittedEventRows === 0) {
        return '';
    }
    return `${JSON.stringify(toControlArtifactOverflowRow(counts, atEpochMs))}\n`;
}

function toArtifactCommandId(envelope: ControlClientEnvelope): string | undefined {
    return 'commandId' in envelope && typeof envelope.commandId === 'string' ? envelope.commandId : undefined;
}

function toFullResultArtifactLines(
    envelope: Extract<ControlClientEnvelope, { kind: 'result'; }>,
    command: ControlQueuedCommandSnapshot | undefined
): ReturnType<typeof toControlResultArtifactLines> {
    const fullResultJson = JSON.stringify(redactRallarBlackBoxValue(envelope.result));
    const result = fullResultJson === undefined ? undefined : JSON.parse(fullResultJson);
    const lines = toControlResultArtifactLines({ ...envelope, result }, command);
    return fullResultJson === undefined ? lines : {
        ...lines,
        resultLine: `${lines.resultLine.trimEnd().slice(0, -1)},"fullResult":${fullResultJson}}\n`
    };
}

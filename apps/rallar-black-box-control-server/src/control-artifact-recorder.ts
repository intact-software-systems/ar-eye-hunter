import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    toControlArtifactOverflowRow,
    type ControlArtifactOverflowCounts
} from '@shared-test/rallar-bb-test/control/control-artifact-overflow.ts';
import type { Timers } from '@shared/resilience/timers.ts';

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
    /** Rows wait at most this long and are appended in one write per run file. */
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
interface PendingArtifactEntry {
    readonly resultLine: string | undefined;
    readonly eventLine: string;
    readonly bytes: number;
}

interface PendingRunArtifacts {
    readonly entries: PendingArtifactEntry[];
    readonly omitted: { omittedResults: number; omittedEventRows: number; omittedBytes: number; };
}

interface ArtifactRunWrite {
    readonly runId: string;
    readonly resultsText: string;
    readonly eventsText: string;
}

const JSONL_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
const RUN_DIRECTORY_NAME_LITERAL_CHARACTER = /^[a-z0-9-]$/;

/** Appends JSONL rows per run in batches; one batch, delete or read barrier runs at a time, in order. */
export class ControlArtifactRecorder {
    private readonly dependencies: ControlArtifactRecorderDependencies;
    private pendingByRun = new Map<string, PendingRunArtifacts>();
    private pendingBytes = 0;
    private writing = false;
    private cancelFlush: (() => void) | undefined;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(dependencies: ControlArtifactRecorderDependencies) {
        this.dependencies = dependencies;
    }

    record(envelope: ControlClientEnvelope, commandBeforeAcceptance?: ControlQueuedCommandSnapshot): void {
        if (!this.dependencies.storageDir || envelope.kind === 'register' || envelope.kind === 'heartbeat') {
            return;
        }
        const commandId = toArtifactCommandId(envelope);
        const command = commandBeforeAcceptance ??
            (commandId ? this.dependencies.commandSnapshots.snapshotCommand(envelope.runId, commandId) : undefined);
        const pending = this.pendingByRun.get(envelope.runId) ??
            { entries: [], omitted: { omittedResults: 0, omittedEventRows: 0, omittedBytes: 0 } };
        const entry = toPendingArtifactEntry(envelope, command);
        pending.entries.push(entry);
        this.pendingByRun.set(envelope.runId, pending);
        this.pendingBytes += entry.bytes;
        this.dropOldestOverCap(pending);
        this.armFlush();
    }

    deleteRun(runId: string): void {
        const storageDir = this.dependencies.storageDir;
        if (!storageDir) {
            return;
        }
        this.pendingBytes -= toPendingBytes(this.pendingByRun.get(runId));
        this.pendingByRun.delete(runId);
        this.writeQueue = this.writeQueue
            .then(() => Deno.remove(toArtifactRunDirectory(storageDir, runId), { recursive: true }))
            .catch(() => undefined);
    }

    /** Writes every pending row once the batch in flight is written; reads and shutdown await it. */
    async stop(): Promise<void> {
        this.cancelFlush?.();
        this.cancelFlush = undefined;
        await this.writeQueue;
        await this.writePending();
    }

    async response({ runId, kind, fallbackRun, corsOrigins }: ControlArtifactResponseInput): Promise<Response> {
        const headers = createControlResponseHeaders(undefined, { contentType: JSONL_CONTENT_TYPE, corsOrigins });
        const storageDir = this.dependencies.storageDir;
        const storedPath = storageDir ? `${toArtifactRunDirectory(storageDir, runId)}/${kind}.jsonl` : undefined;
        if (storedPath) {
            try {
                await this.stop();
                const file = await Deno.open(storedPath, { read: true });
                return new Response(file.readable, { status: 200, headers });
            }
            catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`Could not read control artifact ${storedPath}: ${message}`);
                }
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
            pending.omitted.omittedResults += entry.resultLine === undefined ? 0 : 1;
            pending.omitted.omittedEventRows += 1;
            pending.omitted.omittedBytes += entry.bytes;
            dropCount += 1;
        }
        pending.entries.splice(0, dropCount);
    }

    private armFlush(): void {
        this.cancelFlush ??= this.dependencies.timers.schedule(
            () => this.flushTick(),
            this.dependencies.config.flushIntervalMs
        );
    }

    /** While a batch is in flight the rows stay pending under the cap and the next tick tries again. */
    private flushTick(): void {
        this.cancelFlush = undefined;
        if (this.writing) {
            this.armFlush();
            return;
        }
        void this.writePending();
    }

    private writePending(): Promise<void> {
        const storageDir = this.dependencies.storageDir;
        const batch = toArtifactWriteBatch(this.pendingByRun, {
            maxPendingBytes: this.dependencies.config.maxPendingBytes,
            atEpochMs: this.dependencies.timers.nowMs()
        });
        this.pendingByRun = new Map();
        this.pendingBytes = 0;
        if (!storageDir || batch.length === 0) {
            return this.writeQueue;
        }
        this.writing = true;
        this.writeQueue = this.writeQueue
            .then(() => writeArtifactBatch(storageDir, batch))
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`Could not append control artifact JSONL: ${message}`);
            })
            .finally(() => {
                this.writing = false;
            });
        return this.writeQueue;
    }
}

// Injective over every JS string, including lone surrogates: literal characters are drawn only
// from [a-z0-9-], so the escaped `_` plus its fixed 4-hex-digit code unit can never be produced by
// a run of literal characters, and no other run ID can therefore encode to the same output.
export function toRunDirectoryName(runId: string): string {
    let name = '';
    for (let index = 0; index < runId.length; index += 1) {
        const character = runId[index];
        name += RUN_DIRECTORY_NAME_LITERAL_CHARACTER.test(character)
            ? character
            : `_${runId.charCodeAt(index).toString(16).padStart(4, '0')}`;
    }
    return name;
}

function toPendingArtifactEntry(
    envelope: Exclude<ControlClientEnvelope, { kind: 'register' | 'heartbeat'; }>,
    command: ControlQueuedCommandSnapshot | undefined
): PendingArtifactEntry {
    const lines = envelope.kind === 'result'
        ? toControlResultArtifactLines(envelope, command)
        : { resultLine: undefined, eventLine: controlEventArtifactJsonl(envelope, command) };
    return { ...lines, bytes: (lines.resultLine?.length ?? 0) + lines.eventLine.length };
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
): readonly ArtifactRunWrite[] {
    return Array.from(pendingByRun, ([runId, pending]) => {
        const overflowLine = toArtifactOverflowLine(runId, {
            ...pending.omitted,
            maxPendingBytes: facts.maxPendingBytes
        }, facts.atEpochMs);
        const resultLines = pending.entries.flatMap((entry) =>
            entry.resultLine === undefined ? [] : [entry.resultLine]
        );
        return {
            runId,
            resultsText: overflowLine + resultLines.join(''),
            eventsText: overflowLine + pending.entries.map((entry) => entry.eventLine).join('')
        };
    });
}

function toArtifactOverflowLine(runId: string, counts: ControlArtifactOverflowCounts, atEpochMs: number): string {
    if (counts.omittedEventRows === 0) {
        return '';
    }
    console.warn(
        `Control artifact recorder dropped ${counts.omittedEventRows} pending rows (${counts.omittedBytes} bytes) for ${runId}.`
    );
    return `${JSON.stringify(toControlArtifactOverflowRow(counts, atEpochMs))}\n`;
}

function toArtifactCommandId(envelope: ControlClientEnvelope): string | undefined {
    return 'commandId' in envelope && typeof envelope.commandId === 'string' ? envelope.commandId : undefined;
}

function toArtifactRunDirectory(storageDir: string, runId: string): string {
    return `${storageDir.replace(/\/+$/, '')}/runs/${toRunDirectoryName(runId)}`;
}

async function writeArtifactBatch(storageDir: string, batch: readonly ArtifactRunWrite[]): Promise<void> {
    for (const write of batch) {
        const runDirectory = toArtifactRunDirectory(storageDir, write.runId);
        await Deno.mkdir(runDirectory, { recursive: true });
        for (const [fileName, text] of [['results.jsonl', write.resultsText], ['events.jsonl', write.eventsText]]) {
            if (text.length > 0) {
                await Deno.writeTextFile(`${runDirectory}/${fileName}`, text, { append: true, create: true });
            }
        }
    }
}

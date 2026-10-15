import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';

import {
    controlEventArtifactJsonl,
    controlRunEventsJsonl,
    controlRunResultsJsonl,
    toControlResultArtifactLines
} from './control-artifacts.ts';
import type { RallarBlackBoxControlService } from './control-service.ts';
import type { ControlTimers } from './control-timers.ts';
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
     * Beyond this many pending bytes the oldest pending rows are dropped and the gap is recorded. Rows are counted in
     * UTF-16 code units, which equal bytes for the ASCII JSON the recorder writes.
     */
    readonly maxPendingBytes: number;
}

export interface ControlArtifactRecorderDependencies {
    readonly storageDir: string | undefined;
    readonly commandSnapshots: Pick<RallarBlackBoxControlService, 'snapshotCommand'>;
    readonly timers: ControlTimers;
    readonly config: ControlArtifactRecorderConfig;
}

/**
 * A 50-agent run sends about 75 MB of start results within seconds; 128 MiB holds that burst even if the disk stalls
 * through it, while the recorder's memory stays bounded near twice the cap (pending rows plus one batch being written).
 */
export const DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG: ControlArtifactRecorderConfig = {
    flushIntervalMs: 250,
    maxPendingBytes: 128 * 1024 * 1024
};

type ArtifactJsonlFileName = 'events.jsonl' | 'results.jsonl';

interface PendingArtifactRow {
    readonly runId: string;
    readonly fileName: ArtifactJsonlFileName;
    readonly text: string;
}

interface DroppedArtifactRows {
    rows: number;
    bytes: number;
}

const JSONL_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
const RUN_DIRECTORY_NAME_LITERAL_CHARACTER = /^[a-z0-9-]$/;

/** Appends JSONL rows per run in batches; one batch, delete or read barrier runs at a time, in order. */
export class ControlArtifactRecorder {
    private readonly dependencies: ControlArtifactRecorderDependencies;
    private pending: PendingArtifactRow[] = [];
    private pendingBytes = 0;
    private dropped = new Map<string, DroppedArtifactRows>();
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
        for (const row of toPendingArtifactRows(envelope, command)) {
            this.pending.push(row);
            this.pendingBytes += row.text.length;
        }
        this.dropOldestOverCap();
        this.cancelFlush ??= this.dependencies.timers.schedule(
            () => this.flush(),
            this.dependencies.config.flushIntervalMs
        );
    }

    deleteRun(runId: string): void {
        const storageDir = this.dependencies.storageDir;
        if (!storageDir) {
            return;
        }
        this.pending = this.pending.filter((row) => row.runId !== runId);
        this.pendingBytes = this.pending.reduce((total, row) => total + row.text.length, 0);
        this.dropped.delete(runId);
        this.writeQueue = this.writeQueue
            .then(() => Deno.remove(toArtifactRunDirectory(storageDir, runId), { recursive: true }))
            .catch(() => undefined);
    }

    /** Writes every pending row at once; shutdown awaits it. */
    stop(): Promise<void> {
        return this.flush();
    }

    async response({ runId, kind, fallbackRun, corsOrigins }: ControlArtifactResponseInput): Promise<Response> {
        const headers = createControlResponseHeaders(undefined, { contentType: JSONL_CONTENT_TYPE, corsOrigins });
        const storageDir = this.dependencies.storageDir;
        const storedPath = storageDir ? `${toArtifactRunDirectory(storageDir, runId)}/${kind}.jsonl` : undefined;
        if (storedPath) {
            try {
                await this.flush();
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

    private dropOldestOverCap(): void {
        const maxPendingBytes = this.dependencies.config.maxPendingBytes;
        let dropCount = 0;
        while (this.pendingBytes > maxPendingBytes && dropCount < this.pending.length) {
            const row = this.pending[dropCount];
            this.pendingBytes -= row.text.length;
            const dropped = this.dropped.get(row.runId) ?? { rows: 0, bytes: 0 };
            dropped.rows += 1;
            dropped.bytes += row.text.length;
            this.dropped.set(row.runId, dropped);
            dropCount += 1;
        }
        if (dropCount > 0) {
            this.pending.splice(0, dropCount);
        }
    }

    private flush(): Promise<void> {
        this.cancelFlush?.();
        this.cancelFlush = undefined;
        const storageDir = this.dependencies.storageDir;
        const batch = toArtifactWriteBatch(this.pending, this.dropped);
        this.pending = [];
        this.pendingBytes = 0;
        this.dropped = new Map();
        if (storageDir && batch.length > 0) {
            this.writeQueue = this.writeQueue
                .then(() => writeArtifactBatch(storageDir, batch))
                .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`Could not append control artifact JSONL: ${message}`);
                });
        }
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

function toPendingArtifactRows(
    envelope: Exclude<ControlClientEnvelope, { kind: 'register' | 'heartbeat'; }>,
    command: ControlQueuedCommandSnapshot | undefined
): readonly PendingArtifactRow[] {
    if (envelope.kind === 'result') {
        const lines = toControlResultArtifactLines(envelope, command);
        return [
            { runId: envelope.runId, fileName: 'results.jsonl', text: lines.resultLine },
            { runId: envelope.runId, fileName: 'events.jsonl', text: lines.eventLine }
        ];
    }
    return [{ runId: envelope.runId, fileName: 'events.jsonl', text: controlEventArtifactJsonl(envelope, command) }];
}

interface ArtifactRunWrite {
    readonly runId: string;
    readonly files: ReadonlyMap<ArtifactJsonlFileName, string>;
}

/** One append per run file, in arrival order; a run that lost rows starts its events with the gap record. */
function toArtifactWriteBatch(
    rows: readonly PendingArtifactRow[],
    dropped: ReadonlyMap<string, DroppedArtifactRows>
): readonly ArtifactRunWrite[] {
    const textByRun = new Map<string, Map<ArtifactJsonlFileName, string[]>>();
    for (const [runId, gap] of dropped) {
        console.warn(`Control artifact recorder dropped ${gap.rows} pending rows (${gap.bytes} bytes) for ${runId}.`);
        textByRun.set(runId, new Map([['events.jsonl', [toArtifactGapLine(gap)]]]));
    }
    for (const row of rows) {
        const files = textByRun.get(row.runId) ?? new Map<ArtifactJsonlFileName, string[]>();
        const texts = files.get(row.fileName) ?? [];
        texts.push(row.text);
        files.set(row.fileName, texts);
        textByRun.set(row.runId, files);
    }
    return Array.from(textByRun, ([runId, files]) => ({
        runId,
        files: new Map(Array.from(files, ([fileName, texts]) => [fileName, texts.join('')]))
    }));
}

function toArtifactGapLine(gap: DroppedArtifactRows): string {
    return `${
        JSON.stringify({
            kind: 'artifact-truncated',
            name: 'control-artifact-recorder-overflow',
            status: 'dropped',
            omittedRows: gap.rows,
            omittedBytes: gap.bytes
        })
    }\n`;
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
        for (const [fileName, text] of write.files) {
            await Deno.writeTextFile(`${runDirectory}/${fileName}`, text, { append: true, create: true });
        }
    }
}

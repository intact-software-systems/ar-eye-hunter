import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';

import {
    controlEventArtifactJsonl,
    controlResultArtifactJsonl,
    controlResultEventArtifactJsonl,
    controlRunEventsJsonl,
    controlRunResultsJsonl
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

export interface ControlArtifactRecorderDependencies {
    readonly storageDir: string | undefined;
    readonly commandSnapshots: Pick<RallarBlackBoxControlService, 'snapshotCommand'>;
}

interface ArtifactJsonlWrite {
    readonly fileName: 'events.jsonl' | 'results.jsonl';
    readonly text: string;
}

const JSONL_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
const RUN_DIRECTORY_NAME_LITERAL_CHARACTER = /^[a-z0-9-]$/;

export class ControlArtifactRecorder {
    private readonly storageDir: string | undefined;
    private readonly commandSnapshots: ControlArtifactRecorderDependencies['commandSnapshots'];
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(dependencies: ControlArtifactRecorderDependencies) {
        this.storageDir = dependencies.storageDir;
        this.commandSnapshots = dependencies.commandSnapshots;
    }

    record(envelope: ControlClientEnvelope): void {
        const commandId = toArtifactCommandId(envelope);
        const command = commandId ? this.commandSnapshots.snapshotCommand(envelope.runId, commandId) : undefined;
        const writes = toArtifactJsonlWrites(envelope, command);
        if (!this.storageDir || writes.length === 0) {
            return;
        }

        const runDirectory = toArtifactRunDirectory(this.storageDir, envelope.runId);
        this.writeQueue = this.writeQueue
            .then(() => writeArtifactJsonl(runDirectory, writes))
            .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`Could not append control artifact JSONL for ${envelope.runId}: ${message}`);
            });
    }

    deleteRun(runId: string): void {
        const storageDir = this.storageDir;
        if (!storageDir) {
            return;
        }
        this.writeQueue = this.writeQueue
            .then(() => Deno.remove(toArtifactRunDirectory(storageDir, runId), { recursive: true }))
            .catch(() => undefined);
    }

    async response({ runId, kind, fallbackRun, corsOrigins }: ControlArtifactResponseInput): Promise<Response> {
        const headers = createControlResponseHeaders(undefined, { contentType: JSONL_CONTENT_TYPE, corsOrigins });
        const storedPath = this.storageDir
            ? `${toArtifactRunDirectory(this.storageDir, runId)}/${kind}.jsonl`
            : undefined;
        if (storedPath) {
            try {
                await this.writeQueue;
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

function toArtifactJsonlWrites(
    envelope: ControlClientEnvelope,
    command: ControlQueuedCommandSnapshot | undefined
): readonly ArtifactJsonlWrite[] {
    if (envelope.kind === 'result') {
        return [
            { fileName: 'results.jsonl', text: controlResultArtifactJsonl(envelope, command) },
            { fileName: 'events.jsonl', text: controlResultEventArtifactJsonl(envelope, command) }
        ];
    }
    if (envelope.kind === 'register' || envelope.kind === 'heartbeat') {
        return [];
    }
    return [{ fileName: 'events.jsonl', text: controlEventArtifactJsonl(envelope, command) }];
}

function toArtifactCommandId(envelope: ControlClientEnvelope): string | undefined {
    return 'commandId' in envelope && typeof envelope.commandId === 'string' ? envelope.commandId : undefined;
}

function toArtifactRunDirectory(storageDir: string, runId: string): string {
    return `${storageDir.replace(/\/+$/, '')}/runs/${toRunDirectoryName(runId)}`;
}

async function writeArtifactJsonl(runDirectory: string, writes: readonly ArtifactJsonlWrite[]): Promise<void> {
    await Deno.mkdir(runDirectory, { recursive: true });
    for (const write of writes) {
        await Deno.writeTextFile(`${runDirectory}/${write.fileName}`, write.text, { append: true, create: true });
    }
}

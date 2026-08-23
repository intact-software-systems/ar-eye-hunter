import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';

import {
    controlEventArtifactJsonl,
    controlResultArtifactJsonl,
    controlResultEventArtifactJsonl,
    controlRunEventsJsonl,
    controlRunResultsJsonl
} from './control-artifacts.ts';
import type { ControlQueuedCommandSnapshot, ControlRunSnapshot } from './control-service.ts';
import { createControlResponseHeaders } from './cors.ts';

export type ControlArtifactJsonlKind = 'events' | 'results';

export interface ControlArtifactRecorder {
    record(envelope: ControlClientEnvelope): void;
    deleteRun(runId: string): void;
    response(
        runId: string,
        kind: ControlArtifactJsonlKind,
        fallbackRun: ControlRunSnapshot,
        corsOrigins: readonly string[]
    ): Promise<Response>;
}

export interface CreateControlArtifactRecorderInput {
    readonly storageDir?: string;
    readonly commandSnapshot?: (
        runId: string,
        commandId: string
    ) => ControlQueuedCommandSnapshot | undefined;
}

export function createControlArtifactRecorder(
    input: CreateControlArtifactRecorderInput
): ControlArtifactRecorder {
    let writeQueue: Promise<void> = Promise.resolve();

    function jsonlPath(runId: string, kind: ControlArtifactJsonlKind): string | undefined {
        return input.storageDir
            ? `${artifactRunDirectory(input.storageDir, runId)}/${kind}.jsonl`
            : undefined;
    }

    async function flush(): Promise<void> {
        await writeQueue;
    }

    return {
        record(envelope) {
            const commandId = commandIdFromArtifactEnvelope(envelope);
            const command = commandId
                ? input.commandSnapshot?.(envelope.runId, commandId)
                : undefined;
            const writes = artifactJsonlWrites(envelope, command);
            if (!input.storageDir || writes.length === 0) {
                return;
            }
            const runDirectory = artifactRunDirectory(input.storageDir, envelope.runId);
            writeQueue = writeQueue
                .then(async () => {
                    await Deno.mkdir(runDirectory, { recursive: true });
                    for (const write of writes) {
                        await Deno.writeTextFile(`${runDirectory}/${write.fileName}`, write.text, {
                            append: true,
                            create: true
                        });
                    }
                })
                .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(
                        `Could not append control artifact JSONL for ${envelope.runId}: ${message}`
                    );
                });
        },
        deleteRun(runId) {
            const storageDir = input.storageDir;
            if (!storageDir) {
                return;
            }
            writeQueue = writeQueue
                .then(() =>
                    Deno.remove(artifactRunDirectory(storageDir, runId), {
                        recursive: true
                    })
                )
                .catch(() => undefined);
        },
        async response(runId, kind, fallbackRun, corsOrigins) {
            const storedPath = jsonlPath(runId, kind);
            if (storedPath) {
                try {
                    await flush();
                    const file = await Deno.open(storedPath, { read: true });
                    return new Response(file.readable, {
                        status: 200,
                        headers: createControlResponseHeaders(undefined, {
                            contentType: 'application/x-ndjson; charset=utf-8',
                            corsOrigins
                        })
                    });
                }
                catch (error) {
                    if (!(error instanceof Deno.errors.NotFound)) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn(
                            `Could not read control artifact ${storedPath}: ${message}`
                        );
                    }
                }
            }

            const text = kind === 'events'
                ? controlRunEventsJsonl(fallbackRun)
                : controlRunResultsJsonl(fallbackRun);
            return new Response(text, {
                status: 200,
                headers: createControlResponseHeaders(undefined, {
                    contentType: 'application/x-ndjson; charset=utf-8',
                    corsOrigins
                })
            });
        }
    };
}

function artifactJsonlWrites(
    envelope: ControlClientEnvelope,
    command?: ControlQueuedCommandSnapshot
): readonly { fileName: 'events.jsonl' | 'results.jsonl'; text: string; }[] {
    if (envelope.kind === 'result') {
        return [
            { fileName: 'results.jsonl', text: controlResultArtifactJsonl(envelope, command) },
            { fileName: 'events.jsonl', text: controlResultEventArtifactJsonl(envelope, command) }
        ];
    }
    if (
        envelope.kind === 'event' || envelope.kind === 'diagnostic' || envelope.kind === 'stats' ||
        envelope.kind === 'report'
    ) {
        return [{ fileName: 'events.jsonl', text: controlEventArtifactJsonl(envelope, command) }];
    }
    return [];
}

function commandIdFromArtifactEnvelope(envelope: ControlClientEnvelope): string | undefined {
    return 'commandId' in envelope && typeof envelope.commandId === 'string'
        ? envelope.commandId
        : undefined;
}

function artifactRunDirectory(storageDir: string, runId: string): string {
    return `${storageDir.replace(/\/+$/, '')}/runs/${safePathSegment(runId)}`;
}

function safePathSegment(value: string): string {
    return encodeURIComponent(value).replace(/%/g, '_');
}

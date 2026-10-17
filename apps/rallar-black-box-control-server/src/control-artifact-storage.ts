import type { ControlClientIdentity } from '@shared-test/rallar-bb-test/control-protocol.ts';
import {
    computeResultCaptureReceipts,
    decodeResultCaptureJournal,
    type ResultCaptureReceipt
} from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';

export interface ControlArtifactCaptureEntry {
    readonly identity: ControlClientIdentity;
    /** Called only after durable capture or a capture failure; pending overflow is owned by the recorder. */
    readonly finish: (outcome: Either<string, readonly ResultCaptureReceipt[]>) => void;
    readonly resultLine: string | undefined;
    readonly eventLine: string;
}

export interface ControlArtifactRunWrite {
    readonly runId: string;
    readonly entries: readonly ControlArtifactCaptureEntry[];
    readonly resultsText: string;
    readonly eventsText: string;
}

const RUN_DIRECTORY_NAME_LITERAL_CHARACTER = /^[a-z0-9-]$/;

/** Owns durable artifact files and the single per-run capture-validity state. The recorder orders calls. */
export class ControlArtifactStorage {
    private readonly storageDir: string;
    private readonly failedCaptureRuns = new Set<string>();

    constructor(storageDir: string) {
        this.storageDir = storageDir;
    }

    invalidateCapture(runId: string): void {
        this.failedCaptureRuns.add(runId);
    }

    async deleteRun(runId: string): Promise<void> {
        await Deno.remove(toArtifactRunDirectory(this.storageDir, runId), { recursive: true });
    }

    async openRunFile(
        runId: string,
        fileName: 'events.jsonl' | 'results.jsonl'
    ): Promise<ReadableStream<Uint8Array> | undefined> {
        const path = `${toArtifactRunDirectory(this.storageDir, runId)}/${fileName}`;
        try {
            const file = await Deno.open(path, { read: true });
            return file.readable;
        }
        catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`Could not read control artifact ${path}: ${message}`);
            }
            return undefined;
        }
    }

    async readResultReceipts(
        identity: ControlClientIdentity,
        commandIds: readonly string[]
    ): Promise<Either<string, readonly ResultCaptureReceipt[]>> {
        if (this.failedCaptureRuns.has(identity.runId)) {
            return Either.ofLeft('An artifact write failed during this run; complete capture cannot be certified.');
        }
        try {
            const path = `${toArtifactRunDirectory(this.storageDir, identity.runId)}/result-receipts.jsonl`;
            const text = await Deno.readTextFile(path);
            if (this.failedCaptureRuns.has(identity.runId)) {
                return Either.ofLeft('Artifact capture became incomplete while reading durable receipts.');
            }
            return decodeResultCaptureJournal(text, identity, commandIds);
        }
        catch (error) {
            return Either.ofLeft(error instanceof Error ? error.message : String(error));
        }
    }

    async writeBatch(batch: readonly ControlArtifactRunWrite[]): Promise<void> {
        for (const write of batch) {
            const runDirectory = toArtifactRunDirectory(this.storageDir, write.runId);
            try {
                await writeArtifactJsonl(runDirectory, [
                    { fileName: 'results.jsonl', text: write.resultsText },
                    { fileName: 'events.jsonl', text: write.eventsText }
                ]);
                const captures = await readEntryCaptureReceipts(write.entries);
                const receipts = captures.flatMap((capture) => capture.receipts);
                if (receipts.length > 0 && !this.failedCaptureRuns.has(write.runId)) {
                    await writeArtifactJsonl(runDirectory, [{
                        fileName: 'result-receipts.jsonl',
                        text: receipts.map((receipt) => JSON.stringify(receipt)).join('\n') + '\n'
                    }]);
                }
                for (const capture of captures) {
                    capture.entry.finish(
                        this.failedCaptureRuns.has(write.runId)
                            ? Either.ofLeft(
                                'An artifact write failed or rows were dropped; complete capture cannot be certified.'
                            )
                            : Either.ofRight(capture.receipts)
                    );
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`Could not append control artifact JSONL for ${write.runId}: ${message}`);
                this.failedCaptureRuns.add(write.runId);
                for (const entry of write.entries) {
                    entry.finish(Either.ofLeft(message));
                }
            }
        }
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

/** Every file of a run, the recorder's JSONL and the completed run's rows, lives in this directory. */
export function toArtifactRunDirectory(storageDir: string, runId: string): string {
    return `${storageDir.replace(/\/+$/, '')}/runs/${toRunDirectoryName(runId)}`;
}

interface ArtifactJsonlWrite {
    readonly fileName: 'events.jsonl' | 'results.jsonl' | 'result-receipts.jsonl';
    readonly text: string;
}

async function writeArtifactJsonl(runDirectory: string, writes: readonly ArtifactJsonlWrite[]): Promise<void> {
    await Deno.mkdir(runDirectory, { recursive: true });
    for (const write of writes) {
        if (write.text.length === 0) {
            continue;
        }
        const path = `${runDirectory}/${write.fileName}`;
        await Deno.writeTextFile(path, write.text, { append: true, create: true });
        using file = await Deno.open(path, { write: true });
        await file.sync();
    }
    const parent = runDirectory.slice(0, runDirectory.lastIndexOf('/'));
    const storage = parent.slice(0, parent.lastIndexOf('/'));
    for (const path of [runDirectory, parent, storage]) {
        using directory = await Deno.open(path, { read: true });
        await directory.sync();
    }
}

interface ArtifactEntryCapture {
    readonly entry: ControlArtifactCaptureEntry;
    readonly receipts: readonly ResultCaptureReceipt[];
}

async function readEntryCaptureReceipts(
    entries: readonly ControlArtifactCaptureEntry[]
): Promise<readonly ArtifactEntryCapture[]> {
    const captures: ArtifactEntryCapture[] = [];
    for (const entry of entries) {
        const row: ApiJsonObject = JSON.parse(entry.resultLine ?? entry.eventLine);
        const receipts = await computeResultCaptureReceipts(
            entry.resultLine === undefined ? row : row.fullResult,
            entry.identity
        );
        captures.push({ entry, receipts });
    }
    return captures;
}

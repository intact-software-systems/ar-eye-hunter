import { decodeRallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/composite-results.ts';
import type { ControlClientIdentity } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    ControlQueuedCommandSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import {
    computeResultCaptureReceipt,
    isResultCaptureReceipt,
    type ResultCaptureReceipt
} from '@shared-test/rallar-bb-test/result-release/result-release-protocol.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

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
    readonly fileName: 'events.jsonl' | 'results.jsonl' | 'result-receipts.jsonl';
    readonly text: string;
}

const JSONL_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
const RUN_DIRECTORY_NAME_LITERAL_CHARACTER = /^[a-z0-9-]$/;

export class ControlArtifactRecorder {
    private readonly storageDir: string | undefined;
    private readonly commandSnapshots: ControlArtifactRecorderDependencies['commandSnapshots'];
    private readonly failedCaptureRuns = new Set<string>();
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(dependencies: ControlArtifactRecorderDependencies) {
        this.storageDir = dependencies.storageDir;
        this.commandSnapshots = dependencies.commandSnapshots;
    }

    record(
        envelope: ControlClientEnvelope,
        commandBeforeAcceptance?: ControlQueuedCommandSnapshot
    ): Promise<Either<string, readonly ResultCaptureReceipt[]>> {
        const commandId = toArtifactCommandId(envelope);
        const command = commandBeforeAcceptance ??
            (commandId ? this.commandSnapshots.snapshotCommand(envelope.runId, commandId) : undefined);
        const writes = toArtifactJsonlWrites(envelope, command);
        if (writes.length === 0) {
            return Promise.resolve(Either.ofRight([]));
        }
        if (!this.storageDir) {
            return Promise.resolve(Either.ofLeft('Durable artifact storage is not configured.'));
        }
        const runDirectory = toArtifactRunDirectory(this.storageDir, envelope.runId);
        const completion = this.writeQueue.then(async () => {
            const captured = await writeCapturedArtifacts({
                runDirectory,
                writes,
                identity: envelope,
                allowReceipts: !this.failedCaptureRuns.has(envelope.runId)
            });
            if (captured.left !== undefined) {
                this.failedCaptureRuns.add(envelope.runId);
            }
            return captured;
        });
        this.writeQueue = completion.then(() => undefined);
        return completion;
    }

    async readResultReceipts(
        identity: ControlClientIdentity,
        commandIds: readonly string[]
    ): Promise<Either<string, readonly ResultCaptureReceipt[]>> {
        if (!this.storageDir) {
            return Either.ofLeft('Durable artifact storage is not configured.');
        }
        await this.writeQueue;
        if (this.failedCaptureRuns.has(identity.runId)) {
            return Either.ofLeft('An artifact write failed during this run; complete capture cannot be certified.');
        }
        try {
            const path = `${toArtifactRunDirectory(this.storageDir, identity.runId)}/result-receipts.jsonl`;
            const text = await Deno.readTextFile(path);
            const receipts = new Map<string, ResultCaptureReceipt>();
            for (const line of text.split('\n').filter(Boolean)) {
                const receipt: unknown = JSON.parse(line);
                if (!isResultCaptureReceipt(receipt)) {
                    return Either.ofLeft('Durable receipt journal contains an invalid receipt.');
                }
                if (
                    receipt.runId === identity.runId && receipt.agentId === identity.agentId &&
                    commandIds.includes(receipt.capture.rootCommandId)
                ) {
                    receipts.set(JSON.stringify(receipt.capture), receipt);
                }
            }
            if (
                commandIds.some((commandId) =>
                    ![...receipts.values()].some((receipt) => receipt.commandId === commandId)
                )
            ) {
                return Either.ofLeft('A selected command has no durable full-result capture.');
            }
            const latestRoots = new Map<string, ResultCaptureReceipt>();
            for (const receipt of receipts.values()) {
                if (receipt.commandId === receipt.capture.rootCommandId) {
                    latestRoots.set(receipt.commandId, receipt);
                }
            }
            return Either.ofRight([...receipts.values()].filter((receipt) => {
                const root = latestRoots.get(receipt.capture.rootCommandId)?.capture;
                return root?.runtimeId === receipt.capture.runtimeId &&
                    root.generation === receipt.capture.generation &&
                    root.assignment === receipt.capture.assignment;
            }));
        }
        catch (error) {
            return Either.ofLeft(error instanceof Error ? error.message : String(error));
        }
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
            { fileName: 'results.jsonl', text: toFullResultArtifactJsonl(envelope, command) },
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
        using file = await Deno.open(`${runDirectory}/${write.fileName}`, { append: true, create: true, write: true });
        const bytes = new TextEncoder().encode(write.text);
        let offset = 0;
        while (offset < bytes.length) {
            offset += await file.write(bytes.subarray(offset));
        }
        await file.sync();
    }
    const parent = runDirectory.slice(0, runDirectory.lastIndexOf('/'));
    const storage = parent.slice(0, parent.lastIndexOf('/'));
    for (const path of [runDirectory, parent, storage]) {
        using directory = await Deno.open(path, { read: true });
        await directory.sync();
    }
}

interface CapturedArtifactWrite {
    readonly runDirectory: string;
    readonly writes: readonly ArtifactJsonlWrite[];
    readonly identity: ControlClientIdentity;
    readonly allowReceipts: boolean;
}

async function writeCapturedArtifacts(
    { runDirectory, writes, identity, allowReceipts }: CapturedArtifactWrite
): Promise<Either<string, readonly ResultCaptureReceipt[]>> {
    try {
        await writeArtifactJsonl(runDirectory, writes);
        const receipts: ResultCaptureReceipt[] = [];
        for (const write of writes) {
            await collectCaptureReceipts(JSON.parse(write.text), identity, receipts);
        }
        if (!allowReceipts) {
            return Either.ofLeft('An earlier artifact write failed; this run cannot certify complete capture.');
        }
        const unique = [...new Map(receipts.map((receipt) => [JSON.stringify(receipt.capture), receipt])).values()];
        if (unique.length > 0) {
            await writeArtifactJsonl(runDirectory, [{
                fileName: 'result-receipts.jsonl',
                text: unique.map((receipt) => JSON.stringify(receipt)).join('\n') + '\n'
            }]);
        }
        return Either.ofRight(unique);
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}

async function collectCaptureReceipts(
    value: unknown,
    identity: ControlClientIdentity,
    receipts: ResultCaptureReceipt[]
): Promise<void> {
    if (Array.isArray(value)) {
        for (const child of value) {
            await collectCaptureReceipts(child, identity, receipts);
        }
        return;
    }
    if (!isJsonRecordValue(value)) {
        return;
    }
    const result = decodeRallarBlackBoxTestResult(value).right;
    if (result) {
        const receipt = await computeResultCaptureReceipt(result, identity);
        if (receipt && isResultCaptureReceipt(receipt)) {
            receipts.push(receipt);
        }
    }
    for (const child of Object.values(value)) {
        await collectCaptureReceipts(child, identity, receipts);
    }
}

function toFullResultArtifactJsonl(
    envelope: Extract<ControlClientEnvelope, { kind: 'result'; }>,
    command: ControlQueuedCommandSnapshot | undefined
): string {
    const row = JSON.parse(controlResultArtifactJsonl(envelope, command));
    return JSON.stringify({ ...row, fullResult: redactRallarBlackBoxValue(envelope.result) }) + '\n';
}

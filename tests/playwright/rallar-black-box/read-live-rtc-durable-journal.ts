import { createHash } from 'node:crypto';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    readRtcB06Journal,
    type RtcB06JournalProof
} from '../../../packages/shared-rtc-bench/baseline/acceptance/rtc-b06-journal.ts';
import type { RtcB06BrowserRecordingReading } from '../../../packages/shared-rtc-bench/baseline/acceptance/validate-rtc-b06-browser-recording.ts';
import type { RtcBaselineRawReferenceDto } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

export interface LiveRtcDurableJournalInput {
    readonly repoRoot: string;
    readonly storageDirectory: string;
    readonly rawPath: string;
    readonly rawRelativePath: string;
    readonly runId: string;
    readonly boundaries: readonly RtcB06BrowserRecordingReading[] | undefined;
}

export interface LiveRtcDurableJournal {
    readonly status: 'durable-prefix';
    readonly source: RtcBaselineRawReferenceDto & {
        readonly kind: 'owned-recorder-file';
        readonly runId: string;
        readonly endpoint: string;
    };
    readonly proof: RtcB06JournalProof;
}

export interface LiveRtcJournalFailure {
    readonly reason: string;
    readonly source: RtcBaselineRawReferenceDto | null;
}

export async function readLiveRtcDurableJournal(
    journal: LiveRtcDurableJournalInput
): Promise<Either<LiveRtcJournalFailure, LiveRtcDurableJournal>> {
    const runId = journal.runId;
    if (!/^[a-z0-9-]+$/.test(runId)) {
        return Either.ofLeft({ reason: 'journal-unsupported-run-directory', source: null });
    }
    let file: FileHandle | undefined;
    try {
        const path = resolve(journal.storageDirectory, 'runs', runId, 'events.jsonl');
        file = await readConfinedJournalFile(journal.repoRoot, path);
        const size = (await file.stat()).size;
        const proof: Either<string, RtcB06JournalProof> = journal.boundaries === undefined
            ? Either.ofLeft('journal-terminal-health-unavailable')
            : journal.boundaries.some((boundary) => boundary.runId !== runId)
            ? Either.ofLeft('journal-run-identity-mismatch')
            : await readRtcB06Journal(readFileChunks(file, size), journal.boundaries);
        const bytes = proof.right?.bytes ?? size;
        const reference = await writeJournalPrefix(file, { ...journal, bytes });
        if (proof.left !== undefined) {
            return Either.ofLeft({ reason: proof.left, source: reference });
        }
        return Either.ofRight({
            status: 'durable-prefix',
            proof: proof.right!,
            source: {
                kind: 'owned-recorder-file',
                runId,
                endpoint: `/runs/${runId}/events.jsonl`,
                ...reference
            }
        });
    }
    catch (cause) {
        return Either.ofLeft({ reason: `journal-disk-unavailable: ${toError(cause).message}`, source: null });
    }
    finally {
        await file?.close();
    }
}

async function readConfinedJournalFile(repoRoot: string, path: string): Promise<FileHandle> {
    const root = await realpath(repoRoot);
    const child = relative(root, path);
    if (!child || child.startsWith(`..${sep}`) || child === '..' || resolve(root, child) !== path) {
        throw new Error('Journal path is outside its repository.');
    }
    let current = root;
    for (const segment of child.split(sep)) {
        current = resolve(current, segment);
        const info = await lstat(current);
        if (info.isSymbolicLink() || (current === path ? !info.isFile() : !info.isDirectory())) {
            throw new Error('Journal path is not a confined regular file.');
        }
    }
    const expected = await lstat(path);
    const file = await open(path, 'r');
    try {
        const actual = await file.stat();
        if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
            throw new Error('Journal file ownership changed.');
        }
        return file;
    }
    catch (cause) {
        await file.close();
        throw cause;
    }
}

async function* readFileChunks(file: FileHandle, bytes: number): AsyncGenerator<Uint8Array> {
    const buffer = new Uint8Array(64 * 1024);
    let offset = 0;
    while (offset < bytes) {
        const read = await file.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (read.bytesRead === 0) {
            throw new Error('Journal file was truncated.');
        }
        offset += read.bytesRead;
        yield buffer.subarray(0, read.bytesRead);
    }
}

async function writeJournalPrefix(
    file: FileHandle,
    journal: LiveRtcDurableJournalInput & { readonly bytes: number; }
): Promise<RtcBaselineRawReferenceDto> {
    await inspectJournalOutput(journal);
    const output = await open(journal.rawPath, 'wx');
    const hash = createHash('sha256');
    let bytes = 0;
    try {
        for await (const chunk of readFileChunks(file, journal.bytes)) {
            hash.update(chunk);
            let written = 0;
            while (written < chunk.length) {
                const append = await output.write(chunk, written, chunk.length - written);
                if (append.bytesWritten === 0) {
                    throw new Error('Journal archive write made no progress.');
                }
                written += append.bytesWritten;
            }
            bytes += chunk.length;
        }
    }
    finally {
        await output.close();
    }
    return { relativePath: journal.rawRelativePath, bytes, sha256: hash.digest('hex') };
}

async function inspectJournalOutput(journal: LiveRtcDurableJournalInput): Promise<void> {
    const root = await realpath(journal.repoRoot);
    const child = relative(root, journal.rawPath);
    if (
        !child.startsWith('tmp/perf/rtc-baseline/') || child.includes('..') ||
        !/^artifacts\/journals\/[a-z0-9-]+\.jsonl$/.test(journal.rawRelativePath) ||
        !child.endsWith(`/${journal.rawRelativePath}`)
    ) {
        throw new Error('Journal archive path is not confined.');
    }
    let current = root;
    for (const segment of child.split(sep).slice(0, -1)) {
        current = resolve(current, segment);
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error('Journal archive parent is unsafe.');
        }
    }
}

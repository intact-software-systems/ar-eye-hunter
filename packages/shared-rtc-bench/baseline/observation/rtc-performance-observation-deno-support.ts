import { basename, join } from 'node:path';

import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import {
    inspectRtcBaselineChecksumEntries,
    RTC_BASELINE_CHECKSUM_FILE
} from '../evidence/rtc-baseline-evidence-layout.ts';
import type { DenoRtcBaselineAdapters } from '../runtime/rtc-baseline-deno-adapters.ts';
import type { RtcBaselineDenoPort } from '../runtime/rtc-baseline-deno-port.ts';
import { RTC_BASELINE_DENO_ROOT_PATH } from '../runtime/rtc-baseline-deno-runtime.ts';
import {
    createRtcPerformanceObservationArchive,
    verifyRtcPerformanceObservationArchive,
    type CreateRtcPerformanceObservationArchiveInput,
    type RtcPerformanceObservationArchiveWritten
} from './rtc-performance-observation-archive.ts';

const encoder = new TextEncoder();

export type RtcPerformanceObservationDenoPort = Pick<RtcBaselineDenoPort, 'mkdir' | 'readFile' | 'writeFile'>;

export async function readRtcPerformanceObservationSource(
    adapters: Pick<DenoRtcBaselineAdapters, 'git'>
) {
    const commit = await adapters.git.readHeadCommit();
    if (!commit.ok) {
        return commit;
    }
    const tree = await adapters.git.readHeadTree();
    return tree.ok
        ? { ok: true as const, value: { commit: commit.value, tree: tree.value } }
        : tree;
}

export async function readRtcPerformanceObservationFinalizedArtifacts(
    runtime: Pick<RtcBaselineDenoPort, 'readFile'>,
    baselineId: string
): Promise<RtcBaselineResult<ReadonlyMap<string, Uint8Array>>> {
    const baselinePath = join(RTC_BASELINE_DENO_ROOT_PATH, baselineId);
    let checksumBytes: Uint8Array;
    try {
        checksumBytes = await runtime.readFile(join(baselinePath, RTC_BASELINE_CHECKSUM_FILE));
    }
    catch (error) {
        return observationFailure(
            '$.SHA256SUMS',
            'finalized-artifact-read-failed',
            cleanObservationError(error instanceof Error ? error : String(error))
        );
    }
    const checksums = inspectRtcBaselineChecksumEntries(checksumBytes);
    if (checksums.issues.length > 0) {
        return { ok: false, issues: checksums.issues };
    }
    const artifacts = new Map<string, Uint8Array>([
        [RTC_BASELINE_CHECKSUM_FILE, checksumBytes]
    ]);
    for (const relativePath of checksums.entries.keys()) {
        try {
            artifacts.set(relativePath, await runtime.readFile(join(baselinePath, relativePath)));
        }
        catch (error) {
            return observationFailure(
                `$.${relativePath}`,
                'finalized-artifact-read-failed',
                cleanObservationError(error instanceof Error ? error : String(error))
            );
        }
    }
    return { ok: true, value: artifacts };
}

export async function createVerifiedRtcPerformanceObservationArchive(
    input: CreateRtcPerformanceObservationArchiveInput
): Promise<RtcBaselineResult<RtcPerformanceObservationArchiveWritten>> {
    try {
        const archive = await createRtcPerformanceObservationArchive(input);
        const verified = await verifyRtcPerformanceObservationArchive({
            bytes: archive.bytes,
            indexEntry: archive.indexEntry
        });
        return verified.ok ? { ok: true, value: archive } : verified;
    }
    catch (error) {
        return observationFailure(
            '$.archive',
            'archive-creation-failed',
            cleanObservationError(error instanceof Error ? error : String(error))
        );
    }
}

export async function writeRtcPerformanceObservationOutput(
    runtime: RtcPerformanceObservationDenoPort,
    outputDirectory: string,
    archive: RtcPerformanceObservationArchiveWritten
) {
    const archivePath = join(outputDirectory, basename(archive.indexEntry.archive.path));
    const indexEntryPath = join(outputDirectory, 'index-entry.jsonl');
    try {
        await runtime.mkdir(outputDirectory, { recursive: true });
        await runtime.writeFile(archivePath, archive.bytes, { createNew: true });
        await runtime.writeFile(
            indexEntryPath,
            encoder.encode(`${JSON.stringify(archive.indexEntry)}\n`),
            { createNew: true }
        );
        return { ok: true as const, value: { archivePath, indexEntryPath } };
    }
    catch (error) {
        return observationFailure(
            '$.output',
            'observation-output-write-failed',
            cleanObservationError(error instanceof Error ? error : String(error))
        );
    }
}

export function observationFailure(
    path: string,
    code: string,
    message: string
): RtcBaselineResult<never> {
    return { ok: false, issues: [{ path, code, message }] };
}

export function cleanObservationError(error: Error | string) {
    return (error instanceof Error ? error.message : error).replace(/^Error: /u, '');
}

import { basename, join } from 'node:path';

import { RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT } from '../../workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.ts';
import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import {
    inspectRtcBaselineChecksumEntries,
    RTC_BASELINE_CHECKSUM_FILE
} from '../evidence/rtc-baseline-evidence-layout.ts';
import type { DenoRtcBaselineAdapters } from '../runtime/rtc-baseline-deno-adapters.ts';
import type { RtcBaselineDenoPort } from '../runtime/rtc-baseline-deno-port.ts';
import { RTC_BASELINE_DENO_ROOT_PATH } from '../runtime/rtc-baseline-deno-runtime.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import type {
    RtcB05ObservationOutput,
    RtcB05ObservationRunnerDependencies
} from './rtc-b05-observation-runner.ts';
import {
    createRtcPerformanceObservationArchive,
    verifyRtcPerformanceObservationArchive
} from './rtc-performance-observation-archive.ts';

const encoder = new TextEncoder();

export interface RtcB05ObservationDenoRuntimeInput {
    readonly runtime: RtcBaselineDenoPort;
    readonly adapters: DenoRtcBaselineAdapters;
    readonly envelope: RtcBaselineEnvelope;
}

export function createRtcB05ObservationDenoRuntime(
    input: RtcB05ObservationDenoRuntimeInput
): RtcB05ObservationRunnerDependencies {
    return {
        envelope: input.envelope,
        preflight: () => preflight(input.runtime),
        readSource: () => readSource(input.adapters),
        runBrowserProducer: ({ baselineId, attempt }) => runBrowserProducer(input.runtime, baselineId, attempt),
        readFinalizedArtifacts: (baselineId) => readFinalizedArtifacts(input.runtime, baselineId),
        createArchive: async (archiveInput) => {
            try {
                const archive = await createRtcPerformanceObservationArchive(archiveInput);
                const verified = await verifyRtcPerformanceObservationArchive({
                    bytes: archive.bytes,
                    indexEntry: archive.indexEntry
                });
                return verified.ok ? { ok: true, value: archive } : verified;
            }
            catch (error) {
                return failed(
                    '$.archive',
                    'archive-creation-failed',
                    cleanMessage(error instanceof Error ? error : String(error))
                );
            }
        },
        writeOutput: ({ outputDirectory, archive }) => writeOutput(input.runtime, outputDirectory, archive),
        nowUtc: () => input.runtime.now().toISOString()
    };
}

async function preflight(runtime: RtcBaselineDenoPort): Promise<RtcBaselineResult<void>> {
    try {
        const status = await runtime.lstat(RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.scriptPath);
        return status.isFile && !status.isSymlink
            ? { ok: true, value: undefined }
            : failed(
                '$.browserProducer',
                'invalid-browser-producer',
                'RTC-B05 browser producer must be a regular non-symlink file.'
            );
    }
    catch (error) {
        return failed(
            '$.browserProducer',
            'missing-browser-producer',
            cleanMessage(error instanceof Error ? error : String(error))
        );
    }
}

async function readSource(adapters: DenoRtcBaselineAdapters) {
    const commit = await adapters.git.readHeadCommit();
    if (!commit.ok) {
        return commit;
    }
    const tree = await adapters.git.readHeadTree();
    return tree.ok ? { ok: true as const, value: { commit: commit.value, tree: tree.value } } : tree;
}

async function runBrowserProducer(
    runtime: RtcBaselineDenoPort,
    baselineId: string,
    attempt: Parameters<RtcB05ObservationRunnerDependencies['runBrowserProducer']>[0]['attempt']
) {
    const output = await runtime.command('node', [
        RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.scriptPath,
        '--capture=raw-evidence',
        `--baseline-id=${baselineId}`,
        `--case-id=${attempt.caseId}`,
        `--input-key=${attempt.inputKey}`,
        `--intended-phase=${attempt.intendedPhase}`,
        `--outer-ordinal=${attempt.outerOrdinal}`,
        `--out=${attempt.rawResultRelativePath}`
    ]);
    return { exitStatus: output.code };
}

async function readFinalizedArtifacts(
    runtime: RtcBaselineDenoPort,
    baselineId: string
): Promise<RtcBaselineResult<ReadonlyMap<string, Uint8Array>>> {
    const baselinePath = join(RTC_BASELINE_DENO_ROOT_PATH, baselineId);
    let checksumBytes: Uint8Array;
    try {
        checksumBytes = await runtime.readFile(join(baselinePath, RTC_BASELINE_CHECKSUM_FILE));
    }
    catch (error) {
        return failed(
            '$.SHA256SUMS',
            'finalized-artifact-read-failed',
            cleanMessage(error instanceof Error ? error : String(error))
        );
    }
    const checksums = inspectRtcBaselineChecksumEntries(checksumBytes);
    if (checksums.issues.length > 0) {
        return { ok: false as const, issues: checksums.issues };
    }
    const artifacts = new Map<string, Uint8Array>([
        [RTC_BASELINE_CHECKSUM_FILE, checksumBytes]
    ]);
    for (const relativePath of checksums.entries.keys()) {
        try {
            artifacts.set(relativePath, await runtime.readFile(join(baselinePath, relativePath)));
        }
        catch (error) {
            return failed(
                `$.${relativePath}`,
                'finalized-artifact-read-failed',
                cleanMessage(error instanceof Error ? error : String(error))
            );
        }
    }
    return { ok: true as const, value: artifacts };
}

async function writeOutput(
    runtime: RtcBaselineDenoPort,
    outputDirectory: string,
    archive: Parameters<RtcB05ObservationRunnerDependencies['writeOutput']>[0]['archive']
): Promise<RtcBaselineResult<RtcB05ObservationOutput>> {
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
        return failed(
            '$.output',
            'observation-output-write-failed',
            cleanMessage(error instanceof Error ? error : String(error))
        );
    }
}

function failed(path: string, code: string, message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [{ path, code, message }] };
}

function cleanMessage(error: Error | string) {
    return error instanceof Error ? error.message.replace(/^Error: /u, '') : String(error);
}

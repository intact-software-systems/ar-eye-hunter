import { RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT } from '../../workloads/browser-lifecycle/rtc-data-channel-browser-soak-validation.ts';
import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { DenoRtcBaselineAdapters } from '../runtime/rtc-baseline-deno-adapters.ts';
import type { RtcBaselineDenoPort } from '../runtime/rtc-baseline-deno-port.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import type { RtcB05ObservationRunnerDependencies } from './rtc-b05-observation-runner.ts';
import {
    cleanObservationError,
    createVerifiedRtcPerformanceObservationArchive,
    observationFailure,
    readRtcPerformanceObservationFinalizedArtifacts,
    readRtcPerformanceObservationSource,
    writeRtcPerformanceObservationOutput
} from './rtc-performance-observation-deno-support.ts';

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
        readSource: () => readRtcPerformanceObservationSource(input.adapters),
        runBrowserProducer: ({ baselineId, attempt }) => runBrowserProducer(input.runtime, baselineId, attempt),
        readFinalizedArtifacts: (baselineId) =>
            readRtcPerformanceObservationFinalizedArtifacts(input.runtime, baselineId),
        createArchive: createVerifiedRtcPerformanceObservationArchive,
        writeOutput: ({ outputDirectory, archive }) =>
            writeRtcPerformanceObservationOutput(input.runtime, outputDirectory, archive),
        nowUtc: () => input.runtime.now().toISOString()
    };
}

async function preflight(runtime: RtcBaselineDenoPort): Promise<RtcBaselineResult<void>> {
    try {
        const status = await runtime.lstat(RTC_DATA_CHANNEL_BROWSER_SOAK_CONTRACT.scriptPath);
        return status.isFile && !status.isSymlink
            ? { ok: true, value: undefined }
            : observationFailure(
                '$.browserProducer',
                'invalid-browser-producer',
                'RTC-B05 browser producer must be a regular non-symlink file.'
            );
    }
    catch (error) {
        return observationFailure(
            '$.browserProducer',
            'missing-browser-producer',
            cleanObservationError(error instanceof Error ? error : String(error))
        );
    }
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

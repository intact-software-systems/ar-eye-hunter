import type { RtcBaselineAttemptLocatorDto, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { DenoRtcBaselineAdapters } from '../runtime/rtc-baseline-deno-adapters.ts';
import type { RtcBaselineDenoPort } from '../runtime/rtc-baseline-deno-port.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import type { RtcB06ObservationRunnerDependencies } from './rtc-b06-observation-runner.ts';
import {
    cleanObservationError,
    createVerifiedRtcPerformanceObservationArchive,
    observationFailure,
    readRtcPerformanceObservationFinalizedArtifacts,
    readRtcPerformanceObservationSource,
    writeRtcPerformanceObservationOutput
} from './rtc-performance-observation-deno-support.ts';

const liveRtcCommand = ['npm', 'run', 'test:rallar:full-stack:memory:live-rtc-3'];
const liveRtcProducerPath = 'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts';
const inheritedConfiguration = [
    'DATABASE_URL',
    'RALLAR_ICE_MODE',
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES'
];
const encoder = new TextEncoder();

export interface RtcB06LiveProducerCommandInput {
    readonly baselineId: string;
    readonly attempt: RtcBaselineAttemptLocatorDto;
}

export interface RtcB06LiveProducerCommand {
    readonly executable: string;
    readonly arguments: readonly string[];
}

export interface RtcB06ObservationDenoRuntimeInput {
    readonly runtime: RtcBaselineDenoPort;
    readonly adapters: DenoRtcBaselineAdapters;
    readonly envelope: RtcBaselineEnvelope;
    readonly producerOutput: RtcB06ProducerOutput;
}

export interface RtcB06ProducerOutput {
    writeStdout(bytes: Uint8Array): Promise<void>;
    writeStderr(bytes: Uint8Array): Promise<void>;
}

export function createRtcB06ObservationDenoRuntime(
    input: RtcB06ObservationDenoRuntimeInput
): RtcB06ObservationRunnerDependencies {
    return {
        envelope: input.envelope,
        preflight: () => preflight(input.runtime),
        readSource: () => readRtcPerformanceObservationSource(input.adapters),
        runLiveRtcProducer: (producer) => runRtcB06LiveProducer(input.runtime, input.producerOutput, producer),
        readFinalizedArtifacts: (baselineId) =>
            readRtcPerformanceObservationFinalizedArtifacts(input.runtime, baselineId),
        createArchive: createVerifiedRtcPerformanceObservationArchive,
        writeOutput: ({ outputDirectory, archive }) =>
            writeRtcPerformanceObservationOutput(input.runtime, outputDirectory, archive),
        nowUtc: () => input.runtime.now().toISOString()
    };
}

export async function runRtcB06LiveProducer(
    runtime: Pick<RtcBaselineDenoPort, 'command'>,
    producerOutput: RtcB06ProducerOutput,
    input: RtcB06LiveProducerCommandInput
) {
    const command = createRtcB06LiveProducerCommand(input);
    const output = await runtime.command(command.executable, command.arguments);
    if (output.code !== 0) {
        const attempt = input.attempt;
        await producerOutput.writeStderr(encoder.encode(
            `RTC-B06 producer failed for ${attempt.caseId}/${attempt.intendedPhase}/${attempt.outerOrdinal} with exit status ${output.code}.\n`
        ));
        if (output.stdout.length > 0) {
            await producerOutput.writeStdout(output.stdout);
        }
        if (output.stderr.length > 0) {
            await producerOutput.writeStderr(output.stderr);
        }
    }
    return { exitStatus: output.code };
}

export function createRtcB06LiveProducerCommand(
    input: RtcB06LiveProducerCommandInput
): RtcB06LiveProducerCommand {
    return {
        executable: 'env',
        arguments: [
            ...inheritedConfiguration.flatMap((name) => ['-u', name]),
            `RALLAR_BLACK_BOX_RTC_BASELINE_ID=${input.baselineId}`,
            `RALLAR_BLACK_BOX_RTC_CASE_ID=${input.attempt.caseId}`,
            `RALLAR_BLACK_BOX_RTC_INPUT_KEY=${input.attempt.inputKey}`,
            `RALLAR_BLACK_BOX_RTC_INTENDED_PHASE=${input.attempt.intendedPhase}`,
            `RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL=${input.attempt.outerOrdinal}`,
            ...caseConfiguration(input.attempt.caseId),
            ...liveRtcCommand
        ]
    };
}

function caseConfiguration(caseId: string) {
    if (caseId === 'all-scenarios') {
        return ['RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1'];
    }
    if (caseId === 'retention-100') {
        return [
            'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1',
            'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100'
        ];
    }
    return [];
}

async function preflight(runtime: RtcBaselineDenoPort): Promise<RtcBaselineResult<void>> {
    try {
        const status = await runtime.lstat(liveRtcProducerPath);
        return status.isFile && !status.isSymlink
            ? { ok: true, value: undefined }
            : observationFailure(
                '$.liveRtcProducer',
                'invalid-live-rtc-producer',
                'RTC-B06 live RTC producer must be a regular non-symlink file.'
            );
    }
    catch (error) {
        return observationFailure(
            '$.liveRtcProducer',
            'missing-live-rtc-producer',
            cleanObservationError(error instanceof Error ? error : String(error))
        );
    }
}

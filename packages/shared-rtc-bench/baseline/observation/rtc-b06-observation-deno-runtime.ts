import { resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type { RallarBlackBoxRoutineBrowserDiagnostics } from '../../../shared-test/black-box-runner/fixtures/browser-diagnostics-recording.ts';
import { FULL_STACK_RTC_ICE_FIXTURE_POLICIES } from '../../../shared-test/black-box-runner/fixtures/full-stack-rtc-ice-fixture-policy.ts';

import type { RallarBlackBoxEventHistoryPolicy } from '../../../shared-test/rallar-bb-test/runtime/event-history.ts';

import { toRtcBaselineFullStackRuntimeScript } from '../catalog/rtc-baseline-workload-catalog.ts';
import { createRtcBaselineFileStore } from '../evidence/rtc-baseline-evidence-store.ts';
import { RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS } from '../evidence/rtc-baseline-writer-lock.ts';
import { RTC_BASELINE_DENO_ROOT_PATH } from '../runtime/rtc-baseline-deno-runtime.ts';
import { readRtcB06DiagnosticSelection } from './read-rtc-b06-diagnostic-selection.ts';
import {
    allocateRtcB06PrivateBuild,
    toRtcB06PrivateBuildDirectory,
    verifyRtcB06PrivateBuildOwnership
} from './rtc-b06-private-build.ts';

import type { RtcBaselineAttemptLocatorDto, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { DenoRtcBaselineAdapters } from '../runtime/rtc-baseline-deno-adapters.ts';
import type { RtcBaselineDenoPort } from '../runtime/rtc-baseline-deno-port.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import type { RtcB06BaselineCaptureInput, RtcB06ObservationRunnerDependencies } from './rtc-b06-observation-runner.ts';
import {
    cleanObservationError,
    createVerifiedRtcPerformanceObservationArchive,
    observationFailure,
    readRtcPerformanceObservationFinalizedArtifacts,
    readRtcPerformanceObservationSource,
    writeRtcPerformanceObservationOutput
} from './rtc-performance-observation-deno-support.ts';

export interface RtcB06LiveProducerCommandInput {
    readonly repositoryRoot: string;
    readonly baselineId: string;
    readonly eventHistory?: RallarBlackBoxEventHistoryPolicy;
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
    readonly almDiagnostics?: boolean;
    readonly releaseResultsAfterCapture?: boolean;
    readonly routineBrowserDiagnostics?: RallarBlackBoxRoutineBrowserDiagnostics;
    readonly attempt: RtcBaselineAttemptLocatorDto;
}

export interface RtcB06LiveProducerCommand {
    readonly executable: string;
    readonly arguments: readonly string[];
}

export interface RtcB06ObservationDenoRuntimeInput {
    readonly repositoryRoot: string;
    readonly runtime: RtcBaselineDenoPort;
    readonly adapters: DenoRtcBaselineAdapters;
    readonly envelope: RtcBaselineEnvelope;
    readonly producerOutput: RtcB06ProducerOutput;
}

export interface RtcB06ProducerOutput {
    writeStdout(bytes: Uint8Array): Promise<void>;
    writeStderr(bytes: Uint8Array): Promise<void>;
}

const liveRtcProducerPath = 'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts';

const inheritedConfiguration = [
    'VITE_RALLAR_EVENT_HISTORY',
    'VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS',
    'RALLAR_BLACK_BOX_RTC_CAPTURE_MODE',
    'RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS',
    'RALLAR_BLACK_BOX_ALM_DIAGNOSTICS',
    'RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE',
    'RALLAR_BLACK_BOX_API_MODE',
    'DATABASE_URL',
    'RALLAR_ICE_MODE',
    'RALLAR_ICE_RATE_LIMIT_REQUESTS',
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES'
];

const encoder = new TextEncoder();

export function createRtcB06ObservationDenoRuntime(
    input: RtcB06ObservationDenoRuntimeInput
): RtcB06ObservationRunnerDependencies {
    const repositoryRoot = input.repositoryRoot;
    const store = createRtcBaselineFileStore({
        rootPath: RTC_BASELINE_DENO_ROOT_PATH,
        filePort: input.adapters.filePort,
        writerLockRuntime: input.adapters.writerLockRuntime,
        writerLockConfig: { staleAfterMs: RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS }
    });
    return {
        envelope: input.envelope,
        preflight: (environmentId) => preflight(input.runtime, environmentId),
        readSource: () => readRtcPerformanceObservationSource(input.adapters),
        runLiveRtcProducer: async (producer) => {
            const selection = await readRtcB06DiagnosticSelection(store, producer.baselineId, producer.attempt);
            if (!selection.ok) {
                await input.producerOutput.writeStderr(encoder.encode(`${JSON.stringify(selection.issues)}\n`));
                return { exitStatus: 1 };
            }
            return runRtcB06LiveProducer(input.runtime, input.producerOutput, {
                ...producer,
                repositoryRoot,
                ...selection.value
            });
        },
        readFinalizedArtifacts: (baselineId) =>
            readRtcPerformanceObservationFinalizedArtifacts(input.runtime, baselineId),
        createArchive: createVerifiedRtcPerformanceObservationArchive,
        writeOutput: ({ outputDirectory, archive }) =>
            writeRtcPerformanceObservationOutput(input.runtime, outputDirectory, archive),
        nowUtc: () => input.runtime.now().toISOString()
    };
}

export async function runRtcB06LiveProducer(
    runtime: Pick<RtcBaselineDenoPort, 'command' | 'mkdir' | 'writeFile' | 'remove' | 'lstat' | 'errors' | 'envGet'>,
    producerOutput: RtcB06ProducerOutput,
    input: RtcB06LiveProducerCommandInput
) {
    const configuration = readProducerConfiguration(runtime, input.attempt.environmentId);
    if (!configuration.ok) {
        await producerOutput.writeStderr(encoder.encode(JSON.stringify(configuration.issues) + '\n'));
        return { exitStatus: 1 };
    }
    const command = createRtcB06LiveProducerCommand(input);
    const ownership = await allocateRtcB06PrivateBuild(runtime, input);
    const buildRoot = ownership.buildRoot;
    try {
        const directory = producerDirectory(input);
        await runtime.mkdir(directory, { recursive: true });
        const storageDirectory = recorderDirectory(input);
        await runtime.mkdir(storageDirectory.slice(0, storageDirectory.lastIndexOf('/')), { recursive: true });
        await runtime.mkdir(storageDirectory, { recursive: false });
        await verifyRtcB06PrivateBuildOwnership(runtime, ownership.directories);
        await runtime.mkdir(`${buildRoot}/output`, { recursive: false });
        await runtime.writeFile(
            `${buildRoot}/owner.json`,
            encoder.encode(JSON.stringify({ baselineId: input.baselineId, attempt: input.attempt })),
            { createNew: true }
        );
        await verifyRtcB06PrivateBuildOwnership(runtime, ownership.directories);
        const output = await runLiveRtcCommand(runtime, command, configuration.value);
        await runtime.writeFile(`${directory}/stdout.log`, output.stdout, { createNew: true });
        await runtime.writeFile(`${directory}/stderr.log`, output.stderr, { createNew: true });
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
    finally {
        await verifyRtcB06PrivateBuildOwnership(runtime, ownership.directories);
        await runtime.remove(ownership.buildRoot, { recursive: true });
    }
}

export function createRtcB06LiveProducerCommand(
    input: RtcB06LiveProducerCommandInput
): RtcB06LiveProducerCommand {
    const eventHistory = input.eventHistory ?? { mode: 'full' };
    const postgres = input.attempt.environmentId === 'E4-pg';
    return {
        executable: 'env',
        arguments: [
            ...inheritedConfiguration.filter((name) => !postgres || name !== 'DATABASE_URL').flatMap((
                name
            ) => ['-u', name]),
            ...(postgres ? ['RALLAR_ICE_MODE=local', 'RALLAR_BLACK_BOX_REQUIRE_FRESH_POSTGRES_API=1'] : []),
            `RALLAR_BLACK_BOX_API_MODE=${postgres ? 'postgres' : 'memory'}`,
            `VITE_RALLAR_EVENT_HISTORY=${eventHistory.mode}`,
            ...(eventHistory.mode === 'recent'
                ? [`VITE_RALLAR_EVENT_HISTORY_MAX_EVENTS=${eventHistory.maxEvents}`]
                : []),
            `RALLAR_BLACK_BOX_ALM_DIAGNOSTICS=${input.almDiagnostics ?? true}`,
            ...(input.attempt.caseId === 'retention-100' && input.releaseResultsAfterCapture === true
                ? ['RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE=true']
                : []),
            `RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS=${input.routineBrowserDiagnostics ?? 'enabled'}`,
            `RALLAR_BLACK_BOX_RTC_BASELINE_ID=${input.baselineId}`,
            `RALLAR_BLACK_BOX_RTC_CASE_ID=${input.attempt.caseId}`,
            `RALLAR_BLACK_BOX_RTC_INPUT_KEY=${input.attempt.inputKey}`,
            `RALLAR_BLACK_BOX_RTC_INTENDED_PHASE=${input.attempt.intendedPhase}`,
            `RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL=${input.attempt.outerOrdinal}`,
            `RALLAR_BLACK_BOX_RTC_CAPTURE_MODE=${
                input.rtcCaptureMode ?? resolveRtcCaptureConfiguration({ sinkAvailable: true }).mode
            }`,
            `RALLAR_BLACK_BOX_STORAGE_DIR=${recorderDirectory(input)}`,
            `RALLAR_BLACK_BOX_RTC_BUILD_ROOT=${toRtcB06PrivateBuildDirectory(input)}`,
            'NODE_ENV=production',
            'npm_config_loglevel=silent',
            `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=${producerDirectory(input)}/failure-diagnostics`,
            ...(postgres ? [] : [`RALLAR_ICE_RATE_LIMIT_REQUESTS=${
                FULL_STACK_RTC_ICE_FIXTURE_POLICIES[
                    input.attempt.caseId as 'default' | 'all-scenarios' | 'retention-100'
                ].requests
            }`]),
            ...caseConfiguration(input.attempt.caseId),
            'npm',
            'run',
            toRtcBaselineFullStackRuntimeScript(
                postgres ? 'postgres' : 'memory',
                input.attempt.caseId === 'all-scenarios'
            ),
            '--',
            '--retries=0',
            `--output=${producerDirectory(input)}/playwright-results`
        ]
    };
}

function producerDirectory(input: RtcB06LiveProducerCommandInput) {
    return `${input.repositoryRoot}/tmp/perf/rtc-b06-producer/${input.baselineId}/${input.attempt.caseId}/${input.attempt.intendedPhase}-${input.attempt.outerOrdinal}`;
}

function recorderDirectory(input: RtcB06LiveProducerCommandInput) {
    return `${input.repositoryRoot}/tmp/perf/rtc-b06-recorder/${input.baselineId}/${input.attempt.caseId}/${input.attempt.intendedPhase}-${input.attempt.outerOrdinal}`;
}

async function runLiveRtcCommand(
    runtime: Pick<RtcBaselineDenoPort, 'command'>,
    command: RtcB06LiveProducerCommand,
    databaseUrl: string | undefined
) {
    try {
        const output = await runtime.command(command.executable, command.arguments);
        return databaseUrl === undefined ? output : {
            ...output,
            stdout: encoder.encode(
                new TextDecoder().decode(output.stdout).replaceAll(databaseUrl, '[REDACTED_DATABASE_URL]')
            ),
            stderr: encoder.encode(
                new TextDecoder().decode(output.stderr).replaceAll(databaseUrl, '[REDACTED_DATABASE_URL]')
            )
        };
    }
    catch (error) {
        return {
            code: 1,
            stdout: new Uint8Array(),
            stderr: encoder.encode(
                databaseUrl === undefined
                    ? cleanObservationError(error instanceof Error ? error : String(error))
                    : cleanObservationError(error instanceof Error ? error : String(error)).replaceAll(
                        databaseUrl,
                        '[REDACTED_DATABASE_URL]'
                    )
            )
        };
    }
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

function readProducerConfiguration(
    runtime: Pick<RtcBaselineDenoPort, 'envGet'>,
    environmentId: string
): RtcBaselineResult<string | undefined> {
    if (environmentId === 'E3-memory') {
        return { ok: true, value: undefined };
    }
    const databaseUrl = runtime.envGet('DATABASE_URL');
    if (environmentId !== 'E4-pg' || !databaseUrl?.trim() || runtime.envGet('RALLAR_ICE_MODE') !== 'local') {
        return observationFailure(
            '$.producerConfiguration',
            'invalid-e4-producer-configuration',
            'E4-pg requires a nonempty DATABASE_URL and explicit RALLAR_ICE_MODE=local.'
        );
    }
    return { ok: true, value: databaseUrl };
}

async function preflight(
    runtime: RtcBaselineDenoPort,
    environmentId: RtcB06BaselineCaptureInput['environmentId']
): Promise<RtcBaselineResult<void>> {
    const configuration = readProducerConfiguration(runtime, environmentId);
    if (!configuration.ok) {
        return configuration;
    }
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

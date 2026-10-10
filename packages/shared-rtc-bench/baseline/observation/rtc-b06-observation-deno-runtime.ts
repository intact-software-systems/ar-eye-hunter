import { resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { FULL_STACK_RTC_ICE_FIXTURE_POLICIES } from '../../../shared-test/black-box-runner/fixtures/full-stack-rtc-ice-fixture-policy.ts';

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

export interface RtcB06LiveProducerCommandInput {
    readonly repositoryRoot: string;
    readonly baselineId: string;
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
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
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
}

export interface RtcB06ProducerOutput {
    writeStdout(bytes: Uint8Array): Promise<void>;
    writeStderr(bytes: Uint8Array): Promise<void>;
}

const liveRtcCommand = ['npm', 'run', 'test:rallar:full-stack:memory:live-rtc-3'];

const liveRtcProducerPath = 'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts';

const inheritedConfiguration = [
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
    const rtcCaptureMode = input.rtcCaptureMode ?? resolveRtcCaptureConfiguration({ sinkAvailable: true }).mode;
    return {
        envelope: input.envelope,
        preflight: () => preflight(input.runtime),
        readSource: () => readRtcPerformanceObservationSource(input.adapters),
        runLiveRtcProducer: (producer) =>
            runRtcB06LiveProducer(input.runtime, input.producerOutput, { ...producer, rtcCaptureMode, repositoryRoot }),
        readFinalizedArtifacts: (baselineId) =>
            readRtcPerformanceObservationFinalizedArtifacts(input.runtime, baselineId),
        createArchive: createVerifiedRtcPerformanceObservationArchive,
        writeOutput: ({ outputDirectory, archive }) =>
            writeRtcPerformanceObservationOutput(input.runtime, outputDirectory, archive),
        nowUtc: () => input.runtime.now().toISOString()
    };
}

export async function runRtcB06LiveProducer(
    runtime: Pick<RtcBaselineDenoPort, 'command' | 'mkdir' | 'writeFile' | 'remove' | 'lstat' | 'errors'>,
    producerOutput: RtcB06ProducerOutput,
    input: RtcB06LiveProducerCommandInput
) {
    const command = createRtcB06LiveProducerCommand(input);
    const ownership = await allocatePrivateProductionBuild(runtime, input);
    const buildRoot = ownership.buildRoot;
    try {
        const directory = producerDirectory(input);
        await runtime.mkdir(directory, { recursive: true });
        const storageDirectory = recorderDirectory(input);
        await runtime.mkdir(storageDirectory.slice(0, storageDirectory.lastIndexOf('/')), { recursive: true });
        await runtime.mkdir(storageDirectory, { recursive: false });
        await verifyPrivateProductionBuildOwnership(runtime, ownership.directories);
        await runtime.mkdir(`${buildRoot}/output`, { recursive: false });
        await runtime.writeFile(
            `${buildRoot}/owner.json`,
            encoder.encode(JSON.stringify({ baselineId: input.baselineId, attempt: input.attempt })),
            { createNew: true }
        );
        await verifyPrivateProductionBuildOwnership(runtime, ownership.directories);
        const output = await runLiveRtcCommand(runtime, command);
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
        await verifyPrivateProductionBuildOwnership(runtime, ownership.directories);
        await runtime.remove(ownership.buildRoot, { recursive: true });
    }
}

interface RtcB06PrivateBuildDirectoryIdentity {
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
}

interface RtcB06PrivateBuildOwnership {
    readonly buildRoot: string;
    readonly directories: readonly RtcB06PrivateBuildDirectoryIdentity[];
}

async function allocatePrivateProductionBuild(
    runtime: Pick<RtcBaselineDenoPort, 'lstat' | 'mkdir' | 'errors'>,
    input: RtcB06LiveProducerCommandInput
): Promise<RtcB06PrivateBuildOwnership> {
    const buildRoot = productionBuildDirectory(input);
    const segments = buildRoot.slice(input.repositoryRoot.length + 1).split('/');
    if (
        !input.repositoryRoot.startsWith('/') ||
        segments.some((segment) => !/^[a-zA-Z0-9._-]+$/.test(segment) || segment === '.' || segment === '..')
    ) {
        throw new Error('Private production build path is not confined.');
    }
    const directories = [await readPrivateProductionDirectoryIdentity(runtime, input.repositoryRoot)];
    let path = input.repositoryRoot;
    for (const segment of segments.slice(0, -1)) {
        path += `/${segment}`;
        let identity: RtcB06PrivateBuildDirectoryIdentity;
        try {
            identity = await readPrivateProductionDirectoryIdentity(runtime, path);
        }
        catch (error) {
            if (!runtime.errors?.NotFound || !(error instanceof runtime.errors.NotFound)) {
                throw error;
            }
            await verifyPrivateProductionBuildOwnership(runtime, directories);
            await runtime.mkdir(path, { recursive: false });
            identity = await readPrivateProductionDirectoryIdentity(runtime, path);
        }
        directories.push(identity);
    }
    await verifyPrivateProductionBuildOwnership(runtime, directories);
    await runtime.mkdir(buildRoot, { recursive: false });
    directories.push(await readPrivateProductionDirectoryIdentity(runtime, buildRoot));
    return { buildRoot, directories };
}

async function readPrivateProductionDirectoryIdentity(
    runtime: Pick<RtcBaselineDenoPort, 'lstat'>,
    path: string
): Promise<RtcB06PrivateBuildDirectoryIdentity> {
    const info = await runtime.lstat(path);
    if (!info.isDirectory || info.isSymlink || info.dev === null || info.ino === null) {
        throw new Error('Private production build path is not confined.');
    }
    return { path, dev: info.dev, ino: info.ino };
}

async function verifyPrivateProductionBuildOwnership(
    runtime: Pick<RtcBaselineDenoPort, 'lstat'>,
    directories: readonly RtcB06PrivateBuildDirectoryIdentity[]
): Promise<void> {
    for (const expected of directories) {
        const current = await readPrivateProductionDirectoryIdentity(runtime, expected.path);
        if (current.dev !== expected.dev || current.ino !== expected.ino) {
            throw new Error('Private production build directory ownership changed.');
        }
    }
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
            `RALLAR_BLACK_BOX_RTC_CAPTURE_MODE=${
                input.rtcCaptureMode ?? resolveRtcCaptureConfiguration({ sinkAvailable: true }).mode
            }`,
            `RALLAR_BLACK_BOX_STORAGE_DIR=${recorderDirectory(input)}`,
            `RALLAR_BLACK_BOX_RTC_BUILD_ROOT=${productionBuildDirectory(input)}`,
            'NODE_ENV=production',
            'npm_config_loglevel=silent',
            `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=${producerDirectory(input)}/failure-diagnostics`,
            `RALLAR_ICE_RATE_LIMIT_REQUESTS=${
                FULL_STACK_RTC_ICE_FIXTURE_POLICIES[
                    input.attempt.caseId as 'default' | 'all-scenarios' | 'retention-100'
                ].requests
            }`,
            ...caseConfiguration(input.attempt.caseId),
            ...liveRtcCommand,
            '--',
            '--retries=0',
            `--output=${producerDirectory(input)}/playwright-results`
        ]
    };
}

function producerDirectory(input: RtcB06LiveProducerCommandInput) {
    return `${input.repositoryRoot}/tmp/perf/rtc-b06-producer/${input.baselineId}/${input.attempt.caseId}/${input.attempt.intendedPhase}-${input.attempt.outerOrdinal}`;
}

function productionBuildDirectory(input: RtcB06LiveProducerCommandInput) {
    return `${input.repositoryRoot}/tmp/perf/rtc-b06-private-build/${input.baselineId}/${input.attempt.caseId}/${input.attempt.intendedPhase}-${input.attempt.outerOrdinal}`;
}

function recorderDirectory(input: RtcB06LiveProducerCommandInput) {
    return `${input.repositoryRoot}/tmp/perf/rtc-b06-recorder/${input.baselineId}/${input.attempt.caseId}/${input.attempt.intendedPhase}-${input.attempt.outerOrdinal}`;
}

async function runLiveRtcCommand(
    runtime: Pick<RtcBaselineDenoPort, 'command'>,
    command: RtcB06LiveProducerCommand
) {
    try {
        return await runtime.command(command.executable, command.arguments);
    }
    catch (error) {
        return {
            code: 1,
            stdout: new Uint8Array(),
            stderr: encoder.encode(cleanObservationError(error instanceof Error ? error : String(error)))
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

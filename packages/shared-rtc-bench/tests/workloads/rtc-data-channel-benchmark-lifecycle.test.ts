import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createRtcBaselineEvidenceAcceptance } from '../../baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import { deriveRtcBaselineCaptureManifest } from '../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import type { RtcBaselineSampleDto, RtcBaselineSampleFailureOutcomeArtifact } from '../../baseline/contracts/rtc-baseline-contracts.ts';
import * as Close from '../../workloads/data-channel/rtc-data-channel-close-retention-bench.ts';
import * as Drain from '../../workloads/data-channel/rtc-data-channel-drain-bench.ts';
import * as ErrorReference from '../../workloads/data-channel/rtc-data-channel-error-reference-bench.ts';
import * as Replace from '../../workloads/data-channel/rtc-data-channel-replace-key-bench.ts';

const baselineId = '20260807-0123456789ab-e1-local';
const denoPrefix = words(
    'run --config=packages/shared-rtc-bench/deno.json --allow-read --allow-write'
);
const parseReplace = Replace.parseRtcDataChannelReplaceKeyArguments;
const parseDrain = Drain.parseRtcDataChannelDrainArguments;
const parseClose = Close.parseRtcDataChannelCloseRetentionArguments;
const parseError = ErrorReference.parseRtcDataChannelErrorReferenceArguments;
const sampleReplace = Replace.runRtcDataChannelReplaceKeyAcceptedSamples;
const sampleDrain = Drain.runRtcDataChannelDrainAcceptedSamples;
const sampleClose = Close.runRtcDataChannelCloseRetentionAcceptedSamples;
const sampleError = ErrorReference.runRtcDataChannelErrorReferenceAcceptedSamples;

function words(value: string): string[] {
    return value.trim().split(/\s+/);
}

interface DataChannelWorkerConfiguration {
    caseId: string;
    key: string;
    flags: string[];
    runs?: number;
}

function dataChannelWorker(input: DataChannelWorkerConfiguration) {
    const { caseId, key, flags, runs = 5 } = input;
    const prefix = `rtc-b02-${caseId}-${key}-retained-001`;
    const ids = Array.from(
        { length: runs },
        (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
    const arguments_ = words(`--capture=worker --baseline-id=${baselineId} --workload=RTC-B02
--case-id=${caseId} --input-key=${key} --intended-phase=retained --outer-ordinal=1
--sample-ids=${ids.join(',')}`);
    return { ids, arguments: [...arguments_, ...flags] };
}

type DataChannelWorkerInput = ReturnType<typeof dataChannelWorker>;

function replaceArgument(arguments_: readonly string[], name: string, value: string): string[] {
    return arguments_.map((argument) => argument.startsWith(`--${name}=`) ? `--${name}=${value}` : argument);
}

function accepted<Result extends { readonly ok: false; } | { readonly ok: true; readonly value: { readonly mode: string; }; }>(
    result: Result
): Extract<Extract<Result, { readonly ok: true; }>['value'], { readonly mode: 'accepted'; }> {
    if (!result.ok || result.value.mode !== 'accepted') {
        throw new Error('Expected exact worker.');
    }
    return result.value as Extract<Extract<Result, { readonly ok: true; }>['value'], { readonly mode: 'accepted'; }>;
}

interface FailureProbe {
    readonly input: DataChannelWorkerInput;
    readonly execute: (noteExecution: () => void) => Promise<RtcBaselineSampleDto[]>;
}

interface FailureProbeInput<Result, Worker> {
    readonly input: DataChannelWorkerInput;
    readonly invalid: Result;
    readonly parsedWorker: Worker;
    readonly runAccepted: (input: {
        readonly worker: Worker;
        readonly run: () => Promise<Result>;
    }) => Promise<RtcBaselineSampleDto[]>;
}

function failureProbe<Result, Worker>(configuration: FailureProbeInput<Result, Worker>): FailureProbe {
    const { input, invalid, parsedWorker, runAccepted } = configuration;
    return {
        input,
        execute: (noteExecution) =>
            runAccepted({
                worker: parsedWorker,
                run: async () => {
                    noteExecution();
                    return invalid;
                }
            })
    };
}

async function expectStopsAfterFirstFailure(probes: readonly FailureProbe[]) {
    const outcomes: RtcBaselineSampleDto[][] = [];
    for (const probe of probes) {
        let executions = 0;
        const samples = await probe.execute(() => {
            executions += 1;
        });
        expect(executions).toBe(1);
        expect(samples.map((sample) => [sample.identity.sampleId, sample.outcome])).toEqual([
            [probe.input.ids[0], 'failed'],
            ...probe.input.ids.slice(1).map((id) => [id, 'not-run'])
        ]);
        expect(
            samples.slice(1).map((sample) => [sample.issues[0]?.code, sample.issues[0]?.message])
        ).toEqual(probe.input.ids.slice(1).map(() => ['causal-not-run', probe.input.ids[0]]));
        outcomes.push(samples);
    }
    return outcomes;
}

async function persistDataChannelFailure(caseId: string, outcomes: RtcBaselineSampleDto[]) {
    const manifest = deriveRtcBaselineCaptureManifest({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId,
        workloadIds: ['RTC-B02'],
        environmentId: 'E1-local',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    });
    const attempt = manifest.outerAttempts.find(
        (value) => value.caseId === caseId && value.intendedPhase === 'retained'
    );
    if (attempt === undefined) {
        throw new Error(`Missing retained ${caseId} attempt.`);
    }
    const writes: RtcBaselineSampleFailureOutcomeArtifact[] = [];
    const acceptance = createRtcBaselineEvidenceAcceptance({
        initializeStore: async () => ({ ok: true as const, value: undefined }),
        readInitializedConfiguration: async () => ({ ok: true as const, value: [] }),
        readManifest: async () => ({
            ok: true as const,
            value: { ...manifest, outerAttempts: [attempt] }
        }),
        writeAcceptedArtifact: async (_id, artifact) => {
            if (
                !('artifactKind' in artifact) ||
                !('identity' in artifact) ||
                !('sampleId' in artifact.identity)
            ) {
                throw new Error('Expected a sample-owned failure outcome artifact.');
            }
            writes.push(artifact as RtcBaselineSampleFailureOutcomeArtifact);
            return { ok: true as const, value: undefined };
        },
        readStagedJson: async () => ({ ok: false as const, issues: [] }),
        runFreshWorker: async () => ({ outcomes }),
        reconcileAcceptedOperation: async () => []
    });
    return {
        result: await acceptance.captureWorkload({ baselineId, workloadId: 'RTC-B02' }),
        writes
    };
}

const drainInput = (depth: 32 | 1000 | 5000) =>
    dataChannelWorker({
        caseId: 'data-channel-drain',
        key: `depth-${depth}`,
        flags: words(`--rtc-high-watermark-bytes=1 --rtc-inner-runs=5
--rtc-low-watermark-bytes=0 --rtc-overflow=replace-by-key --rtc-payload-bytes=256
--rtc-queue-depth=${depth}`)
    });

const b02 = {
    replace: dataChannelWorker({
        caseId: 'data-channel-replace-key',
        key: 'depth-32',
        flags: words('--rtc-inner-runs=5 --rtc-queue-depth=32 --rtc-replacements=25000')
    }),
    drain: drainInput(32),
    close: dataChannelWorker({ caseId: 'data-channel-close-retention', key: 'queue-32', flags: words('--rtc-inner-runs=5 --rtc-queue-depth=32') }),
    error: dataChannelWorker({ caseId: 'data-channel-error-reference', key: 'fixed', flags: words('--rtc-inner-runs=5') })
};

it('RTC-B02 accepts only the exact matrix and preserves diagnostic arguments', () => {
    for (const depth of [32, 1000, 5000] as const) {
        const replace = dataChannelWorker({
            caseId: 'data-channel-replace-key',
            key: `depth-${depth}`,
            flags: words(`--rtc-inner-runs=5 --rtc-queue-depth=${depth} --rtc-replacements=25000`)
        });
        expect(parseReplace(replace.arguments).ok).toBe(true);
        expect(parseDrain(drainInput(depth).arguments).ok).toBe(true);
    }
    for (
        const [parse, input, name, value] of [
            [parseReplace, b02.replace, 'rtc-queue-depth', '032'],
            [parseDrain, b02.drain, 'rtc-payload-bytes', '255'],
            [parseClose, b02.close, 'rtc-queue-depth', '032'],
            [parseError, b02.error, 'rtc-inner-runs', '4']
        ] as const
    ) {
        expect(parse(['--out=/tmp/result.json'])).toMatchObject({ ok: false });
        expect(parse(replaceArgument(input.arguments, name, value))).toMatchObject({ ok: false });
    }
});

it('RTC-B02 bounds lifecycle evidence and stops every runner after its first failure', async () => {
    expect(
        [0, 31, 999, 4999].map(
            (index) => new TextEncoder().encode(Drain.createRtcDataChannelDrainPayload(index)).byteLength
        )
    ).toEqual([256, 256, 256, 256]);
    let reads = 0;
    const drain = await Drain.runRtcDataChannelDrain(32, {
        nativeChannel: new Drain.RtcDataChannelDrainFakeNativeChannel(() => undefined),
        clock: {
            createdAtEpochMs: (index) => 1_700_000_000_000 + index,
            monotonicNow: () => (reads++ === 0 ? 100 : 125)
        },
        payload: {
            create: (index) => {
                if (reads !== 0) {
                    throw new Error('Payload entered interval.');
                }
                return Drain.createRtcDataChannelDrainPayload(index);
            },
            byteLength: (value) => new TextEncoder().encode(value).byteLength
        }
    });
    expect([
        drain.queueDepth,
        drain.queuedBeforeDrain,
        drain.queuedAfterDrain,
        drain.maximumQueuedItemCount,
        drain.sentBeforeDrain,
        drain.sentDuringDrain,
        drain.payloadBytes,
        drain.sentBytesDuringDrain,
        drain.intervalStartedAtMs,
        drain.intervalCompletedAtMs,
        drain.drainDurationMs,
        drain.highWatermarkBytes,
        drain.lowWatermarkBytes,
        drain.overflow
    ]).toEqual([32, 32, 0, 32, 0, 32, 256, 8192, 100, 125, 25, 1, 0, 'replace-by-key']);
    expect(reads).toBe(2);
    const replacement = await Replace.runRtcDataChannelReplaceKey(32, 25000);
    const close = await Close.runRtcDataChannelCloseRetention(32);
    const error = await ErrorReference.runRtcDataChannelErrorReference();
    expect([
        replacement.queueDepth,
        replacement.replacements,
        replacement.queuedItemCount,
        replacement.sentCount
    ]).toEqual([32, 25000, 32, 0]);
    expect([replacement.counters.queued, replacement.counters.replaced]).toEqual([32, 25000]);
    expect([
        close.queuedBeforeClose,
        close.queuedAfterNativeClose,
        close.queuedAfterReconnect,
        close.replacementSentCount,
        close.staleFlushOnReconnect
    ]).toEqual([32, 0, 0, 0, false]);
    expect([
        error.readyStateAfterError,
        error.statusHasDataChannelAfterError,
        error.attachedHandlerCountAfterError
    ]).toEqual([undefined, false, 0]);
    const failures = await expectStopsAfterFirstFailure([
        failureProbe({
            input: b02.replace,
            invalid: { ...replacement, queuedItemCount: 31 },
            parsedWorker: accepted(parseReplace(b02.replace.arguments)),
            runAccepted: sampleReplace
        }),
        failureProbe({
            input: b02.drain,
            invalid: { ...drain, queuedAfterDrain: 1, sentDuringDrain: 31, sentBytesDuringDrain: 7936 },
            parsedWorker: accepted(parseDrain(b02.drain.arguments)),
            runAccepted: sampleDrain
        }),
        failureProbe({
            input: b02.close,
            invalid: { ...close, queuedAfterReconnect: 1 },
            parsedWorker: accepted(parseClose(b02.close.arguments)),
            runAccepted: sampleClose
        }),
        failureProbe({
            input: b02.error,
            invalid: { ...error, attachedHandlerCountAfterError: 1 },
            parsedWorker: accepted(parseError(b02.error.arguments)),
            runAccepted: sampleError
        })
    ]);
    const persisted = await persistDataChannelFailure('data-channel-drain', failures[1]);
    const failure = persisted.writes[0];
    expect(persisted.result).toMatchObject({ ok: false });
    if (failure?.artifactKind !== 'failure') {
        throw new Error('Expected failure artifact.');
    }
    expect(
        persisted.writes.map((artifact) => [
            artifact.artifactKind,
            artifact.identity.sampleId,
            artifact.artifactKind === 'not-run' ? artifact.failureId : undefined,
            artifact.artifactKind === 'not-run' ? artifact.causalFailureId : undefined,
            artifact.issues[0]?.code
        ])
    ).toEqual([
        ['failure', b02.drain.ids[0], undefined, undefined, 'queue-bound-mismatch'],
        ...b02.drain.ids
            .slice(1)
            .map((id) => ['not-run', id, failure.failureId, failure.failureId, 'causal-not-run'])
    ]);
});

it('RTC-B02 diagnostics stay create-new beneath tmp/perf/results', () => {
    mkdirSync('tmp/perf/results', { recursive: true });
    const directory = mkdtempSync(join('tmp/perf/results', 'rtc-data-channel-diagnostic-'));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const cases = [
        [
            'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts',
            '--queue-size=1',
            '--replacements=1'
        ],
        [
            'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts',
            '--queue-depth=32'
        ],
        [
            'packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts',
            '--queue-items=1'
        ],
        ['packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts']
    ];
    for (const [index, arguments_] of cases.entries()) {
        const output = join(directory, `${index}.json`);
        const command = [...denoPrefix, ...arguments_, '--runs=1', `--out=${output}`];
        expect(spawnSync('deno', command, { encoding: 'utf8' }).status).toBe(0);
        const persisted = JSON.parse(readFileSync(output, 'utf8'));
        expect([persisted.schema, persisted.outcome]).toEqual([undefined, undefined]);
        expect(spawnSync('deno', command, { encoding: 'utf8' }).status).not.toBe(0);
    }
});

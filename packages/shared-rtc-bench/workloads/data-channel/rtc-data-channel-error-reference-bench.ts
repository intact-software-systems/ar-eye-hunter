import { RtcBenchmarkNativeChannel } from '../native-rtc/rtc-benchmark-native-channel.ts';
import { createRtcBenchmarkPeerConnection } from '../native-rtc/rtc-benchmark-native-peer.ts';

import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';

import { runRtcBaselineAcceptedWorkerSamples } from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
import {
    parseRtcBaselineBoundedInteger,
    parseRtcBaselineOneTokenOptions
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import {
    rtcBaselineIssue,
    type RtcBaselineIssueDto,
    type RtcBaselineJson,
    type RtcBaselineResult,
    type RtcBaselineSampleDto,
    type RtcBaselineSampleIdentityDto
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';

interface RtcDataChannelErrorReferenceDiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly runs: number;
    readonly out: string;
}

interface RtcDataChannelErrorReferenceAcceptedArguments {
    readonly mode: 'accepted';
    readonly runs: number;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}

export interface RtcDataChannelErrorReferenceResult {
    readonly durationMs: number;
    readonly readyStateAfterError: RTCDataChannelState | undefined;
    readonly statusHasDataChannelAfterError: boolean;
    readonly attachedHandlerCountAfterError: number;
}

const acceptedNames = [
    'capture',
    'baseline-id',
    'workload',
    'case-id',
    'input-key',
    'intended-phase',
    'outer-ordinal',
    'sample-ids',
    'rtc-inner-runs'
];

export function parseRtcDataChannelErrorReferenceArguments(
    arguments_: readonly string[]
): RtcBaselineResult<RtcDataChannelErrorReferenceDiagnosticArguments | RtcDataChannelErrorReferenceAcceptedArguments> {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : ['runs', 'out']
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runRtcDataChannelErrorReference(): Promise<RtcDataChannelErrorReferenceResult> {
    const peerFixture = createRtcBenchmarkPeerConnection('perf-peer');
    const startedAt = performance.now();
    const nativeChannel = new RtcBenchmarkNativeChannel('realtime');
    peerFixture.native.pendingChannels.push(nativeChannel);
    const dataChannel = new QRtcDataChannel(peerFixture.peer, {
        peerId: 'perf-peer',
        dataChannelName: 'realtime'
    });
    try {
        dataChannel.connect(true);
        await nativeChannel.emitOpen();
        await nativeChannel.emitError();
        return {
            durationMs: performance.now() - startedAt,
            readyStateAfterError: dataChannel.readHealth().readyState,
            statusHasDataChannelAfterError: dataChannel.status.dc !== undefined,
            attachedHandlerCountAfterError: nativeChannel.attachedHandlerCount()
        };
    }
    finally {
        dataChannel.reset();
        peerFixture.dispose();
    }
}

export interface RtcDataChannelErrorReferenceAcceptedSamplesInput {
    readonly worker: RtcDataChannelErrorReferenceAcceptedArguments;
    readonly run: () => Promise<RtcDataChannelErrorReferenceResult>;
}

export async function runRtcDataChannelErrorReferenceAcceptedSamples(
    input: RtcDataChannelErrorReferenceAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: {
            ...input.worker,
            workloadId: 'RTC-B02',
            caseId: 'data-channel-error-reference',
            inputKey: 'fixed'
        },
        run: input.run,
        validate: validateResult,
        createSample: ({ identity, result, issues }) => createSample(identity, result, issues)
    });
}

function parseDiagnosticArguments(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<RtcDataChannelErrorReferenceDiagnosticArguments> {
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '3', 'runs', 1, 5);
    const out = options.out ?? 'tmp/perf/results/rtc-data-channel-error-reference.json';
    const issues = [...(!runs.ok ? runs.issues : [])];
    if (!isDiagnosticOutput(out)) {
        issues.push(
            rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.')
        );
    }
    const runCount = runs.ok ? runs.value : 1;
    return issues.length > 0
        ? { ok: false as const, issues }
        : {
            ok: true as const,
            value: { mode: 'diagnostic' as const, runs: runCount, out }
        };
}

function parseAcceptedArguments(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<RtcDataChannelErrorReferenceAcceptedArguments> {
    const outer = parseRtcBaselineBoundedInteger(
        options['outer-ordinal'] ?? '',
        'outer-ordinal',
        1,
        999
    );
    const issues = [...(!outer.ok ? outer.issues : [])];
    issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
    const expected = {
        capture: 'worker',
        workload: 'RTC-B02',
        'case-id': 'data-channel-error-reference',
        'input-key': 'fixed',
        'rtc-inner-runs': '5'
    };
    for (const [name, value] of Object.entries(expected)) {
        if (options[name] !== value) {
            issues.push(rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`));
        }
    }
    const phase = options['intended-phase'];
    if (phase !== 'warmup' && phase !== 'retained') {
        issues.push(rtcBaselineIssue('$.intended-phase', 'unexpected-worker-input', 'Invalid phase.'));
    }
    const ordinal = outer.ok ? outer.value : 0;
    const sampleIds = (options['sample-ids'] ?? '').split(',');
    const expectedIds = createExpectedSampleIds(phase === 'warmup' ? phase : 'retained', ordinal);
    if (JSON.stringify(sampleIds) !== JSON.stringify(expectedIds)) {
        issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
    }
    return issues.length > 0
        ? { ok: false as const, issues }
        : {
            ok: true as const,
            value: {
                mode: 'accepted' as const,
                runs: 5,
                intendedPhase: phase === 'warmup' ? 'warmup' : 'retained',
                outerOrdinal: ordinal,
                sampleIds
            }
        };
}

function createExpectedSampleIds(phase: 'warmup' | 'retained', outerOrdinal: number): string[] {
    const prefix = `rtc-b02-data-channel-error-reference-fixed-${phase}-` + String(outerOrdinal).padStart(3, '0');
    return Array.from(
        { length: 5 },
        (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(
    identity: RtcBaselineSampleIdentityDto,
    result: RtcDataChannelErrorReferenceResult | null,
    issues: RtcBaselineSampleDto['issues']
): RtcBaselineSampleDto {
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome: classifySampleOutcome(result, issues),
        evidenceClass: 'synthetic-path',
        metrics: result === null ? [] : [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
        rawEvidence: result === null ? null : toRawEvidence(result),
        rawReferences: [],
        issues,
        runtimeObservation: null
    };
}

function validateResult(result: RtcDataChannelErrorReferenceResult): RtcBaselineIssueDto[] {
    const issues: RtcBaselineIssueDto[] = [];
    if (result.readyStateAfterError !== undefined || result.statusHasDataChannelAfterError) {
        issues.push(
            rtcBaselineIssue(
                '$.rawEvidence.statusHasDataChannelAfterError',
                'native-reference-retained',
                'Expected no native channel reference.'
            )
        );
    }
    if (result.attachedHandlerCountAfterError !== 0) {
        issues.push(
            rtcBaselineIssue(
                '$.rawEvidence.attachedHandlerCountAfterError',
                'handler-retained',
                'Expected 0.'
            )
        );
    }
    return issues;
}

function toRawEvidence(result: RtcDataChannelErrorReferenceResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        readyStateAfterError: result.readyStateAfterError ?? null,
        statusHasDataChannelAfterError: result.statusHasDataChannelAfterError,
        attachedHandlerCountAfterError: result.attachedHandlerCountAfterError
    };
}

function isDiagnosticOutput(out: string): boolean {
    return (
        out.startsWith('tmp/perf/results/') &&
        !out.includes('\\') &&
        out.split('/').every((component) => component !== '' && component !== '.' && component !== '..')
    );
}

async function main(): Promise<void> {
    const parsed = parseRtcDataChannelErrorReferenceArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const writeLine = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    if (parsed.value.mode === 'accepted') {
        const samples = await runRtcDataChannelErrorReferenceAcceptedSamples({
            worker: parsed.value,
            run: runRtcDataChannelErrorReference
        });
        writeLine(JSON.stringify(samples));
        return;
    }
    const results = [];
    for (let run = 1; run <= parsed.value.runs; run += 1) {
        results.push({ run, ...(await runRtcDataChannelErrorReference()) });
    }
    const output = { command: Deno.args, runs: parsed.value.runs, results };
    await Deno.writeTextFile(parsed.value.out, `${JSON.stringify(output, null, 2)}\n`, {
        createNew: true
    });
    writeLine(JSON.stringify(output, null, 2));
}

function classifySampleOutcome(
    result: RtcDataChannelErrorReferenceResult | null,
    issues: readonly RtcBaselineIssueDto[]
): RtcBaselineSampleDto['outcome'] {
    if (result === null) {
        return 'not-run';
    }
    return issues.length === 0 ? 'passed' : 'failed';
}

if (import.meta.main) {
    await main();
}

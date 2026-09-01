import { RtcBenchmarkNativeChannel } from '../native-rtc/rtc-benchmark-native-channel.ts';
import {
    createRtcBenchmarkPeerConnection,
    type RtcBenchmarkPeerConnection
} from '../native-rtc/rtc-benchmark-native-peer.ts';

import { QRtcDataChannel, type RtcDataChannelCounters } from '@shared/webrtc/qrtc-data-channel.ts';

import { runRtcBaselineAcceptedWorkerSamples } from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
import {
    parseRtcBaselineBoundedInteger,
    parseRtcBaselineOneTokenOptions
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import {
    rtcBaselineIssue,
    type RtcBaselineIssueDto,
    type RtcBaselineResult,
    type RtcBaselineSampleDto,
    type RtcBaselineSampleIdentityDto
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';

interface RtcDataChannelReplaceKeyInput {
    readonly queueDepth: number;
    readonly replacements: number;
    readonly runs: number;
}

interface RtcDataChannelReplaceKeyDiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly input: RtcDataChannelReplaceKeyInput;
    readonly out: string;
}

interface RtcDataChannelReplaceKeyAcceptedArguments {
    readonly mode: 'accepted';
    readonly input: RtcDataChannelReplaceKeyInput;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}

export interface RtcDataChannelReplaceKeyResult {
    readonly fillDurationMs: number;
    readonly replacementDurationMs: number;
    readonly totalDurationMs: number;
    readonly queueDepth: number;
    readonly replacements: number;
    readonly queuedItemCount: number;
    readonly sentCount: number;
    readonly counters: RtcDataChannelCounters;
}

const frozenDepths = new Set<number>([32, 1000, 5000]);
const acceptedNames = (
    'capture baseline-id workload case-id input-key intended-phase outer-ordinal sample-ids ' +
    'rtc-queue-depth rtc-replacements rtc-inner-runs'
).split(' ');

export function parseRtcDataChannelReplaceKeyArguments(
    arguments_: readonly string[]
): RtcBaselineResult<RtcDataChannelReplaceKeyDiagnosticArguments | RtcDataChannelReplaceKeyAcceptedArguments> {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : ['queue-size', 'replacements', 'runs', 'out']
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

interface RtcDataChannelReplaceKeyChannel {
    readonly peerFixture: RtcBenchmarkPeerConnection;
    readonly nativeChannel: RtcBenchmarkNativeChannel;
    readonly dataChannel: QRtcDataChannel;
}

function createReplaceKeyChannel(queueDepth: number): RtcDataChannelReplaceKeyChannel {
    const peerFixture = createRtcBenchmarkPeerConnection('peer-1');
    const nativeChannel = new RtcBenchmarkNativeChannel('realtime');
    peerFixture.native.pendingChannels.push(nativeChannel);
    const dataChannel = new QRtcDataChannel(peerFixture.peer, {
        peerId: 'peer-1',
        dataChannelName: 'realtime',
        flowControl: {
            highWatermarkBytes: 1,
            lowWatermarkBytes: 0,
            overflow: 'replace-by-key',
            maxQueueItems: queueDepth
        }
    });
    return { peerFixture, nativeChannel, dataChannel };
}

export async function runRtcDataChannelReplaceKey(
    queueDepth: number,
    replacements: number
): Promise<RtcDataChannelReplaceKeyResult> {
    const { peerFixture, nativeChannel, dataChannel } = createReplaceKeyChannel(queueDepth);
    try {
        dataChannel.connect(true);
        await nativeChannel.emitOpen();
        nativeChannel.bufferedAmount = 1;

        const totalStart = performance.now();
        const fillStart = performance.now();
        for (let index = 0; index < queueDepth; index += 1) {
            const result = dataChannel.sendJson(createPayload(index), {
                key: `entity-${index}`,
                now: () => 1_700_000_000_000
            });
            if (result.status !== 'queued') {
                throw new Error(`Expected queued during fill, received ${result.status}.`);
            }
        }
        const fillDurationMs = performance.now() - fillStart;
        const replacementStart = performance.now();
        for (let index = 0; index < replacements; index += 1) {
            const result = dataChannel.sendJson(createPayload(index + queueDepth), {
                key: `entity-${index % queueDepth}`,
                now: () => 1_700_000_000_001 + index
            });
            if (result.status !== 'replaced') {
                throw new Error(`Expected replaced during replacements, received ${result.status}.`);
            }
        }
        const replacementDurationMs = performance.now() - replacementStart;
        const health = dataChannel.readHealth();
        return {
            fillDurationMs,
            replacementDurationMs,
            totalDurationMs: performance.now() - totalStart,
            queueDepth,
            replacements,
            queuedItemCount: health.queuedItemCount,
            sentCount: nativeChannel.sent.length,
            counters: health.counters
        };
    }
    finally {
        dataChannel.reset();
        peerFixture.dispose();
    }
}

export interface RtcDataChannelReplaceKeyAcceptedSamplesInput {
    readonly worker: RtcDataChannelReplaceKeyAcceptedArguments;
    readonly run: () => Promise<RtcDataChannelReplaceKeyResult>;
}

export async function runRtcDataChannelReplaceKeyAcceptedSamples(
    input: RtcDataChannelReplaceKeyAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: {
            ...input.worker,
            workloadId: 'RTC-B02',
            caseId: 'data-channel-replace-key',
            inputKey: `depth-${input.worker.input.queueDepth}`
        },
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        createSample: ({ identity, result, issues }) => createSample(identity, result, issues)
    });
}

function parseDiagnosticArguments(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<RtcDataChannelReplaceKeyDiagnosticArguments> {
    const queueDepth = parseRtcBaselineBoundedInteger(
        options['queue-size'] ?? '5000',
        'queue-size',
        1,
        5000
    );
    const replacements = parseRtcBaselineBoundedInteger(
        options.replacements ?? '25000',
        'replacements',
        1,
        25000
    );
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
    const out = options.out ?? 'tmp/perf/results/rtc-data-channel-replace-key.json';
    const issues = [
        ...(!queueDepth.ok ? queueDepth.issues : []),
        ...(!replacements.ok ? replacements.issues : []),
        ...(!runs.ok ? runs.issues : [])
    ];
    if (!isDiagnosticOutput(out)) {
        issues.push(
            rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.')
        );
    }
    const queueDepthValue = queueDepth.ok ? queueDepth.value : 1;
    const replacementCount = replacements.ok ? replacements.value : 1;
    const runCount = runs.ok ? runs.value : 1;
    return issues.length > 0
        ? { ok: false as const, issues }
        : {
            ok: true as const,
            value: {
                mode: 'diagnostic' as const,
                input: { queueDepth: queueDepthValue, replacements: replacementCount, runs: runCount },
                out
            }
        };
}

function parseAcceptedArguments(
    options: Readonly<Record<string, string>>
): RtcBaselineResult<RtcDataChannelReplaceKeyAcceptedArguments> {
    const queueDepth = parseRtcBaselineBoundedInteger(
        options['rtc-queue-depth'] ?? '',
        'rtc-queue-depth',
        32,
        5000
    );
    const outer = parseRtcBaselineBoundedInteger(
        options['outer-ordinal'] ?? '',
        'outer-ordinal',
        1,
        999
    );
    const issues = [...(!queueDepth.ok ? queueDepth.issues : []), ...(!outer.ok ? outer.issues : [])];
    if (queueDepth.ok && !frozenDepths.has(queueDepth.value)) {
        issues.push(
            rtcBaselineIssue(
                '$.rtc-queue-depth',
                'unexpected-worker-input',
                'Expected 32, 1000, or 5000.'
            )
        );
    }
    issues.push(...validateAcceptedWorkerIdentity(options, queueDepth.ok ? queueDepth.value : undefined));
    const phase = options['intended-phase'];
    if (phase !== 'warmup' && phase !== 'retained') {
        issues.push(rtcBaselineIssue('$.intended-phase', 'unexpected-worker-input', 'Invalid phase.'));
    }
    const ordinal = outer.ok ? outer.value : 0;
    const depth = queueDepth.ok ? queueDepth.value : 32;
    const sampleIds = (options['sample-ids'] ?? '').split(',');
    const expectedIds = createExpectedSampleIds(
        depth,
        phase === 'warmup' ? phase : 'retained',
        ordinal
    );
    if (JSON.stringify(sampleIds) !== JSON.stringify(expectedIds)) {
        issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
    }
    return issues.length > 0
        ? { ok: false as const, issues }
        : {
            ok: true as const,
            value: {
                mode: 'accepted' as const,
                input: { queueDepth: depth, replacements: 25000, runs: 5 },
                intendedPhase: phase === 'warmup' ? 'warmup' : 'retained',
                outerOrdinal: ordinal,
                sampleIds
            }
        };
}

function validateAcceptedWorkerIdentity(
    options: Readonly<Record<string, string>>,
    queueDepth: number | undefined
): RtcBaselineIssueDto[] {
    const issues = validateRtcBaselineId(options['baseline-id'] ?? '');
    if (queueDepth === undefined) {
        return issues;
    }
    const expected = {
        capture: 'worker',
        workload: 'RTC-B02',
        'case-id': 'data-channel-replace-key',
        'input-key': `depth-${queueDepth}`,
        'rtc-queue-depth': String(queueDepth),
        'rtc-replacements': '25000',
        'rtc-inner-runs': '5'
    };
    for (const [name, value] of Object.entries(expected)) {
        if (options[name] !== value) {
            issues.push(rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`));
        }
    }
    return issues;
}

function createExpectedSampleIds(
    depth: number,
    phase: 'warmup' | 'retained',
    outerOrdinal: number
): string[] {
    const prefix = `rtc-b02-data-channel-replace-key-depth-${depth}-${phase}-` +
        String(outerOrdinal).padStart(3, '0');
    return Array.from(
        { length: 5 },
        (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(
    identity: RtcBaselineSampleIdentityDto,
    result: RtcDataChannelReplaceKeyResult | null,
    issues: RtcBaselineSampleDto['issues']
): RtcBaselineSampleDto {
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome: classifySampleOutcome(result, issues),
        evidenceClass: 'synthetic-path',
        metrics: result === null
            ? []
            : [{ metric: 'replacementDurationMs', unit: 'ms', value: result.replacementDurationMs }],
        rawEvidence: result === null ? null : { ...result, counters: { ...result.counters } },
        rawReferences: [],
        issues,
        runtimeObservation: null
    };
}

function validateResult(
    input: RtcDataChannelReplaceKeyInput,
    result: RtcDataChannelReplaceKeyResult
): RtcBaselineIssueDto[] {
    const issues: RtcBaselineIssueDto[] = [];
    if (result.queueDepth !== input.queueDepth || result.queuedItemCount !== input.queueDepth) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.queueDepth', 'queue-bound-mismatch', 'Unexpected.')
        );
    }
    if (
        result.replacements !== input.replacements ||
        result.counters.replaced !== input.replacements
    ) {
        issues.push(rtcBaselineIssue('$.rawEvidence.replacements', 'counter-mismatch', 'Unexpected.'));
    }
    if (result.counters.queued !== input.queueDepth || result.sentCount !== 0) {
        issues.push(rtcBaselineIssue('$.rawEvidence.sentCount', 'send-count-mismatch', 'Unexpected.'));
    }
    return issues;
}

interface RtcReplacementPayload {
    readonly sequence: number;
    readonly x: number;
    readonly y: number;
}

function createPayload(sequence: number): RtcReplacementPayload {
    return { sequence, x: sequence % 1024, y: sequence % 2048 };
}

function isDiagnosticOutput(out: string): boolean {
    return (
        out.startsWith('tmp/perf/results/') &&
        !out.includes('\\') &&
        out.split('/').every((component) => component !== '' && component !== '.' && component !== '..')
    );
}

async function main(): Promise<void> {
    const parsed = parseRtcDataChannelReplaceKeyArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const writeLine = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    if (parsed.value.mode === 'accepted') {
        const samples = await runRtcDataChannelReplaceKeyAcceptedSamples({
            worker: parsed.value,
            run: () => runRtcDataChannelReplaceKey(parsed.value.input.queueDepth, parsed.value.input.replacements)
        });
        writeLine(JSON.stringify(samples));
        return;
    }
    const results = [];
    for (let run = 1; run <= parsed.value.input.runs; run += 1) {
        results.push({
            run,
            ...(await runRtcDataChannelReplaceKey(
                parsed.value.input.queueDepth,
                parsed.value.input.replacements
            ))
        });
    }
    await Deno.writeTextFile(
        parsed.value.out,
        `${
            JSON.stringify(
                {
                    input: parsed.value.input,
                    results
                },
                null,
                2
            )
        }\n`,
        { createNew: true }
    );
    writeLine(`Wrote ${parsed.value.out}`);
}

function classifySampleOutcome(
    result: RtcDataChannelReplaceKeyResult | null,
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

import { QRtcDataChannel, type RtcDataChannelPayload } from '@shared/webrtc/QRtcDataChannel.ts';

import { runRtcBaselineAcceptedWorkerSamples } from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
import {
    parseRtcBaselineBoundedInteger,
    parseRtcBaselineOneTokenOptions
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import {
    rtcBaselineIssue,
    type RtcBaselineJson,
    type RtcBaselineSampleDto,
    type RtcBaselineSampleIdentityDto
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';

interface RtcDataChannelCloseRetentionInput {
    readonly queueDepth: number;
    readonly runs: number;
}

interface RtcDataChannelCloseRetentionAcceptedArguments {
    readonly mode: 'accepted';
    readonly input: RtcDataChannelCloseRetentionInput;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}

export interface RtcDataChannelCloseRetentionResult {
    readonly durationMs: number;
    readonly queueDepth: number;
    readonly queuedBeforeClose: number;
    readonly queuedAfterNativeClose: number;
    readonly queuedAfterReconnect: number;
    readonly replacementSentCount: number;
    readonly staleFlushOnReconnect: boolean;
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
    'rtc-queue-depth',
    'rtc-inner-runs'
];

export function parseRtcDataChannelCloseRetentionArguments(arguments_: readonly string[]) {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : ['queue-items', 'runs', 'out']
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runRtcDataChannelCloseRetention(
    queueDepth: number
): Promise<RtcDataChannelCloseRetentionResult> {
    const startedAt = performance.now();
    const nativeChannels: FakeRtcDataChannel[] = [];
    const peerConnection = {
        isReadyToConnect: () => true,
        onDataChannelDo: () => peerConnection,
        createDataChannel: (label: string) => {
            const channel = new FakeRtcDataChannel(label);
            nativeChannels.push(channel);
            return channel;
        }
    };
    const dataChannel = new QRtcDataChannel(peerConnection as never, {
        peerId: 'perf-peer',
        dataChannelName: 'realtime',
        flowControl: {
            highWatermarkBytes: 1,
            lowWatermarkBytes: 0,
            overflow: 'queue',
            maxQueueItems: queueDepth
        }
    });

    dataChannel.connect(true);
    const firstChannel = nativeChannels[0];
    firstChannel.bufferedAmount = 1;
    await firstChannel.emitOpen();
    for (let index = 0; index < queueDepth; index += 1) {
        dataChannel.sendJson({ seq: index });
    }
    const queuedBeforeClose = dataChannel.readHealth().queuedItemCount;
    await firstChannel.emitClose();
    const queuedAfterNativeClose = dataChannel.readHealth().queuedItemCount;

    dataChannel.connect(true);
    const replacementChannel = nativeChannels[1];
    await replacementChannel.emitOpen();
    replacementChannel.bufferedAmount = 0;
    await replacementChannel.emitBufferedAmountLow();
    const queuedAfterReconnect = dataChannel.readHealth().queuedItemCount;
    const replacementSentCount = replacementChannel.sent.length;
    return {
        durationMs: performance.now() - startedAt,
        queueDepth,
        queuedBeforeClose,
        queuedAfterNativeClose,
        queuedAfterReconnect,
        replacementSentCount,
        staleFlushOnReconnect: replacementSentCount > 0
    };
}

export async function runRtcDataChannelCloseRetentionAcceptedSamples(input: {
    readonly worker: RtcDataChannelCloseRetentionAcceptedArguments;
    readonly run: () => Promise<RtcDataChannelCloseRetentionResult>;
}): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: {
            ...input.worker,
            workloadId: 'RTC-B02',
            caseId: 'data-channel-close-retention',
            inputKey: 'queue-32'
        },
        run: input.run,
        validate: (result) => validateResult(input.worker.input.queueDepth, result),
        createSample: ({ identity, result, issues }) => createSample(identity, result, issues)
    });
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
    const queueDepth = parseRtcBaselineBoundedInteger(
        options['queue-items'] ?? '32',
        'queue-items',
        1,
        5000
    );
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '3', 'runs', 1, 5);
    const out = options.out ?? 'tmp/perf/results/rtc-data-channel-close-retention.json';
    const issues = [...(!queueDepth.ok ? queueDepth.issues : []), ...(!runs.ok ? runs.issues : [])];
    if (!isDiagnosticOutput(out)) {
        issues.push(
            rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.')
        );
    }
    const queueDepthValue = queueDepth.ok ? queueDepth.value : 1;
    const runCount = runs.ok ? runs.value : 1;
    return issues.length > 0
        ? { ok: false as const, issues }
        : {
            ok: true as const,
            value: {
                mode: 'diagnostic' as const,
                input: { queueDepth: queueDepthValue, runs: runCount },
                out
            }
        };
}

function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
    const queueDepth = parseRtcBaselineBoundedInteger(
        options['rtc-queue-depth'] ?? '',
        'rtc-queue-depth',
        32,
        32
    );
    const outer = parseRtcBaselineBoundedInteger(
        options['outer-ordinal'] ?? '',
        'outer-ordinal',
        1,
        999
    );
    const issues = [...(!queueDepth.ok ? queueDepth.issues : []), ...(!outer.ok ? outer.issues : [])];
    issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
    const expected = {
        capture: 'worker',
        workload: 'RTC-B02',
        'case-id': 'data-channel-close-retention',
        'input-key': 'queue-32',
        'rtc-queue-depth': '32',
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
                input: { queueDepth: 32, runs: 5 },
                intendedPhase: phase as 'warmup' | 'retained',
                outerOrdinal: ordinal,
                sampleIds
            }
        };
}

function createExpectedSampleIds(phase: 'warmup' | 'retained', outerOrdinal: number): string[] {
    const prefix = `rtc-b02-data-channel-close-retention-queue-32-${phase}-` +
        String(outerOrdinal).padStart(3, '0');
    return Array.from(
        { length: 5 },
        (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(
    identity: RtcBaselineSampleIdentityDto,
    result: RtcDataChannelCloseRetentionResult | null,
    issues: RtcBaselineSampleDto['issues']
): RtcBaselineSampleDto {
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
        evidenceClass: 'synthetic-path',
        metrics: result === null ? [] : [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
        rawEvidence: result === null ? null : toRawEvidence(result),
        rawReferences: [],
        issues,
        runtimeObservation: null
    };
}

function validateResult(queueDepth: number, result: RtcDataChannelCloseRetentionResult) {
    const issues = [];
    if (result.queueDepth !== queueDepth || result.queuedBeforeClose !== queueDepth) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.queuedBeforeClose', 'queue-bound-mismatch', 'Unexpected.')
        );
    }
    if (result.queuedAfterNativeClose !== 0 || result.queuedAfterReconnect !== 0) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.queuedAfterReconnect', 'cleanup-nonzero', 'Expected 0.')
        );
    }
    if (result.replacementSentCount !== 0 || result.staleFlushOnReconnect) {
        issues.push(
            rtcBaselineIssue(
                '$.rawEvidence.replacementSentCount',
                'stale-reconnect-send',
                'Expected no stale send.'
            )
        );
    }
    return issues;
}

function toRawEvidence(result: RtcDataChannelCloseRetentionResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        queueDepth: result.queueDepth,
        queuedBeforeClose: result.queuedBeforeClose,
        queuedAfterNativeClose: result.queuedAfterNativeClose,
        queuedAfterReconnect: result.queuedAfterReconnect,
        replacementSentCount: result.replacementSentCount,
        staleFlushOnReconnect: result.staleFlushOnReconnect
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
    const parsed = parseRtcDataChannelCloseRetentionArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const writeLine = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    if (parsed.value.mode === 'accepted') {
        const samples = await runRtcDataChannelCloseRetentionAcceptedSamples({
            worker: parsed.value,
            run: () => runRtcDataChannelCloseRetention(parsed.value.input.queueDepth)
        });
        writeLine(JSON.stringify(samples));
        return;
    }
    const results = [];
    for (let run = 1; run <= parsed.value.input.runs; run += 1) {
        results.push({
            run,
            ...(await runRtcDataChannelCloseRetention(parsed.value.input.queueDepth))
        });
    }
    await Deno.writeTextFile(
        parsed.value.out,
        `${
            JSON.stringify(
                {
                    command: Deno.args,
                    queueItems: parsed.value.input.queueDepth,
                    runs: parsed.value.input.runs,
                    results
                },
                null,
                2
            )
        }\n`,
        { createNew: true }
    );
    writeLine(
        JSON.stringify(
            { queueItems: parsed.value.input.queueDepth, runs: parsed.value.input.runs, results },
            null,
            2
        )
    );
}

class FakeRtcDataChannel {
    readonly label: string;
    readonly sent: RtcDataChannelPayload[] = [];
    readyState: RTCDataChannelState = 'connecting';
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    binaryType: BinaryType = 'blob';
    onmessage: ((event: MessageEvent) => void | Promise<void>) | null = null;
    onopen: (() => void | Promise<void>) | null = null;
    onclose: (() => void | Promise<void>) | null = null;
    onerror: (() => void | Promise<void>) | null = null;
    onbufferedamountlow: (() => void | Promise<void>) | null = null;

    constructor(label: string) {
        this.label = label;
    }
    send(data: RtcDataChannelPayload): void {
        this.sent.push(data);
    }
    close(): void {
        this.readyState = 'closed';
    }
    async emitOpen(): Promise<void> {
        this.readyState = 'open';
        await this.onopen?.();
    }
    async emitClose(): Promise<void> {
        this.readyState = 'closed';
        await this.onclose?.();
    }
    async emitBufferedAmountLow(): Promise<void> {
        await this.onbufferedamountlow?.();
    }
}

if (import.meta.main) {
    await main();
}

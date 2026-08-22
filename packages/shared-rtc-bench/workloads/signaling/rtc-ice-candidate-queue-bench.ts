import { QRtcPeerConnection } from '@shared/webrtc/QRtcPeerConnection.ts';

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

interface QueueInput {
    readonly candidates: number;
    readonly runs: number;
}
interface DiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly input: QueueInput;
    readonly out: string;
}
interface AcceptedArguments {
    readonly mode: 'accepted';
    readonly input: QueueInput;
    readonly baselineId: string;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}
export interface RtcIceCandidateQueueResult {
    readonly durationMs: number;
    readonly candidateCount: number;
    readonly addedCandidates: number;
    readonly remainingQueuedCandidates: number;
}
interface BenchResult extends RtcIceCandidateQueueResult {
    readonly run: number;
}
interface CreateRtcIceCandidateQueueSampleInput {
    readonly identity: RtcBaselineSampleIdentityDto;
    readonly outcome: 'passed' | 'failed' | 'not-run';
    readonly rawEvidence: RtcIceCandidateQueueResult | null;
    readonly issues: RtcBaselineSampleDto['issues'];
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
    'rtc-candidates',
    'rtc-inner-runs'
];

export function parseRtcIceCandidateQueueArguments(arguments_: readonly string[]) {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : ['candidates', 'runs', 'out']
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runRtcIceCandidateQueueAcceptedSamples(input: {
    worker: AcceptedArguments;
    run: () => Promise<RtcIceCandidateQueueResult>;
}): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: acceptedWorkerIdentity(input.worker),
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        createSample: ({ identity, result, issues }) =>
            createSample({
                identity,
                outcome: classifyAcceptedSampleOutcome(result, issues),
                rawEvidence: result,
                issues
            })
    });
}

function classifyAcceptedSampleOutcome(
    result: RtcIceCandidateQueueResult | null,
    issues: RtcBaselineSampleDto['issues']
): CreateRtcIceCandidateQueueSampleInput['outcome'] {
    if (result === null) {
        return 'not-run';
    }
    return issues.length === 0 ? 'passed' : 'failed';
}

function acceptedWorkerIdentity(worker: AcceptedArguments) {
    return {
        ...worker,
        workloadId: 'RTC-B01' as const,
        caseId: 'ice-candidate-queue',
        inputKey: 'candidates-25000'
    };
}

async function main(): Promise<void> {
    const parsed = parseRtcIceCandidateQueueArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const writeLine = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    if (parsed.value.mode === 'accepted') {
        const samples = await runRtcIceCandidateQueueAcceptedSamples({
            worker: parsed.value,
            run: () => runQueue(parsed.value.input.candidates)
        });
        writeLine(JSON.stringify(samples));
        return;
    }
    const results: BenchResult[] = [];
    for (let run = 1; run <= parsed.value.input.runs; run += 1) {
        results.push({ run, ...(await runQueue(parsed.value.input.candidates)) });
    }
    await Deno.writeTextFile(
        parsed.value.out,
        JSON.stringify(
            {
                createdAt: new Date().toISOString(),
                input: { candidateCount: parsed.value.input.candidates, runs: parsed.value.input.runs },
                results
            },
            null,
            2
        ),
        { createNew: true }
    );
    writeLine(`Wrote ${parsed.value.out}`);
}

async function runQueue(candidates: number): Promise<RtcIceCandidateQueueResult> {
    const peer = new QRtcPeerConnection(
        { send: async () => {} },
        {
            sessionId: 'self',
            token: 'token',
            peerSessionId: 'peer',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
            isPolite: true
        }
    );
    const status = peer.status;
    status.iceCandidateQueue = Array.from({ length: candidates }, (_value, index) => ({
        candidate: `candidate-${index}`,
        sdpMid: '0',
        sdpMLineIndex: 0
    }));
    const nativePeer = new FakeRTCPeerConnection();
    const startedAt = performance.now();
    await (
        peer as unknown as {
            flushIceCandidateQueue(
                peerConnection: Pick<RTCPeerConnection, 'addIceCandidate'>
            ): Promise<void>;
        }
    ).flushIceCandidateQueue(nativePeer);
    return {
        durationMs: performance.now() - startedAt,
        candidateCount: candidates,
        addedCandidates: nativePeer.addedCandidates,
        remainingQueuedCandidates: status.iceCandidateQueue.length
    };
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
    const out = options.out ?? 'tmp/perf/results/rtc-ice-candidate-queue.json';
    const outComponents = out.split('/');
    const validOut = out.startsWith('tmp/perf/results/') &&
        !out.includes('\\') &&
        outComponents.every((component) => component !== '' && component !== '.' && component !== '..');
    const candidates = parseRtcBaselineBoundedInteger(
        options.candidates ?? '25000',
        'candidates',
        1,
        25000
    );
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
    if (!candidates.ok || !runs.ok || !validOut) {
        return {
            ok: false as const,
            issues: [
                ...(!candidates.ok ? candidates.issues : []),
                ...(!runs.ok ? runs.issues : []),
                ...(!validOut
                    ? [rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.')]
                    : [])
            ]
        };
    }
    return {
        ok: true as const,
        value: {
            mode: 'diagnostic' as const,
            input: { candidates: candidates.value, runs: runs.value },
            out
        }
    };
}

function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
    const outer = parseRtcBaselineBoundedInteger(
        options['outer-ordinal'] ?? '',
        'outer-ordinal',
        1,
        999
    );
    const issues = outer.ok ? [] : [...outer.issues];
    issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
    const expected = {
        capture: 'worker',
        workload: 'RTC-B01',
        'case-id': 'ice-candidate-queue',
        'input-key': 'candidates-25000',
        'rtc-candidates': '25000',
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
                input: { candidates: 25000, runs: 5 },
                baselineId: options['baseline-id']!,
                intendedPhase: phase as 'warmup' | 'retained',
                outerOrdinal: ordinal,
                sampleIds
            }
        };
}

function createExpectedSampleIds(phase: string, outerOrdinal: number): string[] {
    const attemptPrefix = `rtc-b01-ice-candidate-queue-candidates-25000-${phase}-` +
        String(outerOrdinal).padStart(3, '0');
    return Array.from(
        { length: 5 },
        (_value, index) => `${attemptPrefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(sampleInput: CreateRtcIceCandidateQueueSampleInput): RtcBaselineSampleDto {
    const { identity, outcome, rawEvidence, issues } = sampleInput;
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome,
        evidenceClass: 'synthetic-path',
        metrics: rawEvidence
            ? [{ metric: 'durationMs', unit: 'ms', value: rawEvidence.durationMs }]
            : [],
        rawEvidence: rawEvidence === null ? null : createRawEvidence(rawEvidence),
        rawReferences: [],
        issues,
        runtimeObservation: null
    };
}

function validateResult(input: QueueInput, result: RtcIceCandidateQueueResult) {
    const issues = [];
    if (result.candidateCount !== input.candidates) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.candidateCount', 'counter-mismatch', 'Unexpected.')
        );
    }
    if (result.addedCandidates !== input.candidates) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.addedCandidates', 'counter-mismatch', 'Unexpected.')
        );
    }
    if (result.remainingQueuedCandidates !== 0) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.remainingQueuedCandidates', 'cleanup-nonzero', 'Expected 0.')
        );
    }
    return issues;
}

function createRawEvidence(result: RtcIceCandidateQueueResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        candidateCount: result.candidateCount,
        addedCandidates: result.addedCandidates,
        remainingQueuedCandidates: result.remainingQueuedCandidates
    };
}

class FakeRTCPeerConnection {
    addedCandidates = 0;
    addIceCandidate(_candidate?: RTCIceCandidateInit | null): Promise<void> {
        this.addedCandidates += 1;
        return Promise.resolve();
    }
}

if (import.meta.main) {
    await main();
}

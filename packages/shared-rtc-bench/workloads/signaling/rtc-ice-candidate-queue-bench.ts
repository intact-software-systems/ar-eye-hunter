import { flushRtcIceCandidateQueue } from '@shared/webrtc/flush-rtc-ice-candidate-queue.ts';

import {
    runRtcBaselineAcceptedWorkerSamples,
    type RtcBaselineAcceptedWorkerIdentityInput
} from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
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

export function parseRtcIceCandidateQueueArguments(
    arguments_: readonly string[]
): RtcBaselineResult<DiagnosticArguments | AcceptedArguments> {
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

export interface RtcIceCandidateQueueAcceptedSamplesInput {
    worker: AcceptedArguments;
    run: () => Promise<RtcIceCandidateQueueResult>;
}

export async function runRtcIceCandidateQueueAcceptedSamples(
    input: RtcIceCandidateQueueAcceptedSamplesInput
): Promise<RtcBaselineSampleDto[]> {
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

function acceptedWorkerIdentity(worker: AcceptedArguments): RtcBaselineAcceptedWorkerIdentityInput {
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
    const queue: RTCIceCandidateInit[] = Array.from({ length: candidates }, (_value, index) => ({
        candidate: `candidate-${index}`,
        sdpMid: '0',
        sdpMLineIndex: 0
    }));
    let addedCandidates = 0;
    const nativePeer: Pick<RTCPeerConnection, 'addIceCandidate'> = {
        addIceCandidate: async () => {
            addedCandidates++;
        }
    };
    const counters = { addedIceCandidateCount: 0, flushedIceCandidateCount: 0 };
    const startedAt = performance.now();
    await flushRtcIceCandidateQueue({
        queue,
        peerConnection: nativePeer,
        onCandidateAdded: () => {
            counters.addedIceCandidateCount++;
            counters.flushedIceCandidateCount++;
        }
    });
    const durationMs = performance.now() - startedAt;
    if (counters.addedIceCandidateCount !== addedCandidates || counters.flushedIceCandidateCount !== addedCandidates) {
        throw new Error('ICE drain accounting did not match native additions');
    }
    return { durationMs, candidateCount: candidates, addedCandidates, remainingQueuedCandidates: queue.length };
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>): RtcBaselineResult<DiagnosticArguments> {
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

function parseAcceptedArguments(options: Readonly<Record<string, string>>): RtcBaselineResult<AcceptedArguments> {
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
                baselineId: options['baseline-id'] ?? '',
                intendedPhase: phase === 'warmup' ? 'warmup' : 'retained',
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

function validateResult(input: QueueInput, result: RtcIceCandidateQueueResult): RtcBaselineIssueDto[] {
    const issues: RtcBaselineIssueDto[] = [];
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

if (import.meta.main) {
    await main();
}

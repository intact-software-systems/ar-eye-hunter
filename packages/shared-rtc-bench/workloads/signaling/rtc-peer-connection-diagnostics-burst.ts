import { runRtcBaselineAcceptedWorkerSamples } from '../../baseline/acceptance/rtc-baseline-failure-accounting.ts';
import {
    parseRtcBaselineBoundedInteger,
    parseRtcBaselineOneTokenOptions
} from '../../baseline/command/rtc-baseline-cli-options.ts';
import type {
    RtcBaselineJson,
    RtcBaselineSampleDto,
    RtcBaselineSampleIdentityDto
} from '../../baseline/contracts/rtc-baseline-contracts.ts';
import { rtcBaselineIssue } from '../../baseline/contracts/rtc-baseline-contracts.ts';
import { validateRtcBaselineId } from '../../baseline/contracts/rtc-baseline-validation.ts';
import {
    createRtcPeerConnectionDiagnosticsDependencies,
    runRtcPeerConnectionDiagnostics,
    type RtcPeerConnectionDiagnosticsResult
} from './rtc-peer-connection-diagnostics-runtime.ts';

export { createRtcPeerConnectionDiagnosticsDependencies };

interface DiagnosticsInput {
    readonly peers: number;
    readonly iceCandidatesPerPeer: number;
    readonly offerCollisionsPerPeer: number;
    readonly runs: number;
}
interface DiagnosticArguments {
    readonly mode: 'diagnostic';
    readonly input: DiagnosticsInput;
    readonly out: string;
}
interface AcceptedArguments {
    readonly mode: 'accepted';
    readonly input: DiagnosticsInput;
    readonly baselineId: string;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}
interface BenchResult extends RtcPeerConnectionDiagnosticsResult {
    readonly run: number;
    readonly iceCandidatesPerPeer: number;
    readonly offerCollisionsPerPeer: number;
}
interface CreateRtcPeerConnectionDiagnosticsSampleInput {
    readonly identity: RtcBaselineSampleIdentityDto;
    readonly outcome: 'passed' | 'failed' | 'not-run';
    readonly rawEvidence: RtcPeerConnectionDiagnosticsResult | null;
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
    'rtc-ice-candidates-per-peer',
    'rtc-inner-runs',
    'rtc-offer-collisions-per-peer',
    'rtc-peers'
];
const diagnosticNames = ['peers', 'ice-candidates', 'offer-collisions', 'runs', 'out'];

export function parseRtcPeerConnectionDiagnosticsArguments(arguments_: readonly string[]) {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : diagnosticNames
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export async function runRtcPeerConnectionDiagnosticsAcceptedSamples(input: {
    worker: AcceptedArguments;
    run: () => Promise<RtcPeerConnectionDiagnosticsResult>;
}): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: acceptedWorkerIdentity(input.worker),
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        createSample: ({ identity, result, issues }) =>
            createSample({
                identity,
                outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
                rawEvidence: result,
                issues
            })
    });
}

function acceptedWorkerIdentity(worker: AcceptedArguments) {
    return {
        ...worker,
        workloadId: 'RTC-B01' as const,
        caseId: 'peer-connection-diagnostics-burst',
        inputKey: 'pairs-500'
    };
}

async function main(): Promise<void> {
    const parsed = parseRtcPeerConnectionDiagnosticsArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    const writeLine = console.log.bind(console);
    console.log = () => {};
    console.warn = () => {};
    const fakeRuntime = createRtcPeerConnectionDiagnosticsDependencies();
    try {
        if (parsed.value.mode === 'accepted') {
            const samples = await runRtcPeerConnectionDiagnosticsAcceptedSamples({
                worker: parsed.value,
                run: () => runRtcPeerConnectionDiagnostics(parsed.value.input, fakeRuntime.dependencies)
            });
            writeLine(JSON.stringify(samples));
            return;
        }
        const results: BenchResult[] = [];
        for (let run = 1; run <= parsed.value.input.runs; run += 1) {
            const result = await runRtcPeerConnectionDiagnostics(
                parsed.value.input,
                fakeRuntime.dependencies
            );
            results.push({
                ...result,
                run,
                iceCandidatesPerPeer: parsed.value.input.iceCandidatesPerPeer,
                offerCollisionsPerPeer: parsed.value.input.offerCollisionsPerPeer
            });
        }
        await Deno.writeTextFile(
            parsed.value.out,
            JSON.stringify(
                {
                    createdAt: new Date().toISOString(),
                    input: { ...parsed.value.input, out: parsed.value.out },
                    results
                },
                null,
                2
            ),
            { createNew: true }
        );
        writeLine(`Wrote ${parsed.value.out}`);
    }
    finally {
        fakeRuntime.restore();
    }
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
    const out = options.out ?? 'tmp/perf/results/rtc-peer-connection-diagnostics-burst.json';
    const outComponents = out.split('/');
    const validOut = out.startsWith('tmp/perf/results/') &&
        !out.includes('\\') &&
        outComponents.every((component) => component !== '' && component !== '.' && component !== '..');
    const peers = parseRtcBaselineBoundedInteger(options.peers ?? '500', 'peers', 1, 500);
    const ice = parseRtcBaselineBoundedInteger(
        options['ice-candidates'] ?? '5',
        'ice-candidates',
        0,
        5
    );
    const collisions = parseRtcBaselineBoundedInteger(
        options['offer-collisions'] ?? '3',
        'offer-collisions',
        0,
        3
    );
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '3', 'runs', 1, 5);
    if (!peers.ok || !ice.ok || !collisions.ok || !runs.ok || !validOut) {
        return {
            ok: false as const,
            issues: [
                ...(!peers.ok ? peers.issues : []),
                ...(!ice.ok ? ice.issues : []),
                ...(!collisions.ok ? collisions.issues : []),
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
            input: {
                peers: peers.value,
                iceCandidatesPerPeer: ice.value,
                offerCollisionsPerPeer: collisions.value,
                runs: runs.value
            },
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
        'case-id': 'peer-connection-diagnostics-burst',
        'input-key': 'pairs-500',
        'rtc-ice-candidates-per-peer': '5',
        'rtc-inner-runs': '5',
        'rtc-offer-collisions-per-peer': '3',
        'rtc-peers': '500'
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
    const expectedIds = createExpectedSampleIds(
        'peer-connection-diagnostics-burst-pairs-500',
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
                input: { peers: 500, iceCandidatesPerPeer: 5, offerCollisionsPerPeer: 3, runs: 5 },
                baselineId: options['baseline-id']!,
                intendedPhase: phase as 'warmup' | 'retained',
                outerOrdinal: ordinal,
                sampleIds
            }
        };
}

function createExpectedSampleIds(prefix: string, phase: string, outerOrdinal: number): string[] {
    const attemptPrefix = `rtc-b01-${prefix}-${phase}-${String(outerOrdinal).padStart(3, '0')}`;
    return Array.from(
        { length: 5 },
        (_value, index) => `${attemptPrefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(
    sampleInput: CreateRtcPeerConnectionDiagnosticsSampleInput
): RtcBaselineSampleDto {
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

function validateResult(input: DiagnosticsInput, result: RtcPeerConnectionDiagnosticsResult) {
    const counters = result.diagnostics;
    const issues = [];
    if (result.peerCount !== input.peers * 2) {
        issues.push(rtcBaselineIssue('$.rawEvidence.peerCount', 'counter-mismatch', 'Unexpected.'));
    }
    if (result.signalingMessagesSent !== input.peers) {
        issues.push(
            rtcBaselineIssue('$.rawEvidence.signalingMessagesSent', 'counter-mismatch', 'Unexpected.')
        );
    }
    const expected = {
        queuedIceCandidateCount: input.peers * input.iceCandidatesPerPeer,
        flushedIceCandidateCount: input.peers * input.iceCandidatesPerPeer,
        offerCollisionCount: input.peers * input.offerCollisionsPerPeer,
        ignoredOfferCollisionCount: input.peers * input.offerCollisionsPerPeer,
        reconnectAttemptCount: input.peers,
        reconnectTimerAlreadyActiveCount: input.peers,
        reconnectExhaustedCount: input.peers,
        iceRestartCount: input.peers
    };
    for (const [name, value] of Object.entries(expected)) {
        if (counters[name] !== value) {
            issues.push(
                rtcBaselineIssue(
                    `$.rawEvidence.diagnostics.${name}`,
                    'counter-mismatch',
                    `Expected ${value}.`
                )
            );
        }
    }
    for (const [name, value] of Object.entries(result.cleanup)) {
        if (value !== 0) {
            issues.push(
                rtcBaselineIssue(`$.rawEvidence.cleanup.${name}`, 'cleanup-nonzero', 'Expected 0.')
            );
        }
    }
    return issues;
}

function createRawEvidence(result: RtcPeerConnectionDiagnosticsResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        peerCount: result.peerCount,
        signalingMessagesSent: result.signalingMessagesSent,
        diagnostics: { ...result.diagnostics },
        cleanup: { ...result.cleanup }
    };
}

if (import.meta.main) {
    await main();
}

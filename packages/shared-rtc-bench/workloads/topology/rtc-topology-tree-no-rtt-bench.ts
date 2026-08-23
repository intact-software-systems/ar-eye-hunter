import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { createDeterministicRtcTopologyGroupSnapshot } from './create-deterministic-rtc-topology-group-snapshot.ts';

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

interface RtcTopologyTreeInput {
    readonly sessions: number;
    readonly degreeLimit: number;
    readonly runs: number;
}
interface RtcTopologyTreeAcceptedArguments {
    readonly mode: 'accepted';
    readonly input: RtcTopologyTreeInput;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}
export interface RtcTopologyTreeResult {
    readonly durationMs: number;
    readonly sessionIds: readonly string[];
    readonly edgePairs: readonly (readonly [string, string])[];
    readonly topology: string;
    readonly changed: boolean;
}

const acceptedNames = `capture baseline-id workload case-id input-key intended-phase outer-ordinal
sample-ids rtc-degree-limit rtc-inner-runs rtc-sessions`.split(/\s+/);
const acceptedSessionCounts = new Set([30, 100, 300]);

export function parseRtcTopologyTreeArguments(arguments_: readonly string[]) {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : ['sessions', 'runs', 'degree-limit', 'out']
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export function runRtcTopologyTree(sessions: number, degreeLimit: number): RtcTopologyTreeResult {
    const sessionIds = createSessionIds(sessions);
    const group = createDeterministicRtcTopologyGroupSnapshot('room-1', sessionIds);
    const service = new RallarRtcTopologyService({
        degreeLimit,
        meshMinSize: sessions + 1,
        now: () => 100
    });
    const startedAt = performance.now();
    const result = service.updateGroupTopology(group);
    const durationMs = performance.now() - startedAt;
    return {
        durationMs,
        sessionIds,
        edgePairs: toEdgePairs(result.snapshot.nextHopsBySessionId),
        topology: result.snapshot.topology,
        changed: result.changed
    };
}

export async function runRtcTopologyTreeAcceptedSamples(input: {
    readonly worker: RtcTopologyTreeAcceptedArguments;
    readonly run: () => Promise<RtcTopologyTreeResult> | RtcTopologyTreeResult;
}): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: {
            ...input.worker,
            workloadId: 'RTC-B03',
            caseId: 'topology-tree',
            inputKey: `sessions-${input.worker.input.sessions}`
        },
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        createSample: ({ identity, result, issues }) => createSample(identity, result, issues)
    });
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
    const sessions = parseRtcBaselineBoundedInteger(options.sessions ?? '300', 'sessions', 2, 1000);
    const degreeLimit = parseRtcBaselineBoundedInteger(
        options['degree-limit'] ?? '5',
        'degree-limit',
        2,
        1000
    );
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
    const out = options.out ?? 'tmp/perf/results/rtc-topology-tree-no-rtt.json';
    const issues = [
        ...(!sessions.ok ? sessions.issues : []),
        ...(!degreeLimit.ok ? degreeLimit.issues : []),
        ...(!runs.ok ? runs.issues : [])
    ];
    if (!isDiagnosticOutput(out)) {
        issues.push(
            rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Expected tmp/perf/results/.')
        );
    }
    return issues.length > 0
        ? { ok: false as const, issues }
        : {
            ok: true as const,
            value: {
                mode: 'diagnostic' as const,
                input: {
                    sessions: sessions.ok ? sessions.value : 2,
                    degreeLimit: degreeLimit.ok ? degreeLimit.value : 2,
                    runs: runs.ok ? runs.value : 1
                },
                out
            }
        };
}

function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
    const sessions = parseRtcBaselineBoundedInteger(
        options['rtc-sessions'] ?? '',
        'rtc-sessions',
        30,
        300
    );
    const outer = parseRtcBaselineBoundedInteger(
        options['outer-ordinal'] ?? '',
        'outer-ordinal',
        1,
        999
    );
    const issues = [...(!sessions.ok ? sessions.issues : []), ...(!outer.ok ? outer.issues : [])];
    if (sessions.ok && !acceptedSessionCounts.has(sessions.value)) {
        issues.push(
            rtcBaselineIssue('$.rtc-sessions', 'unexpected-worker-input', 'Expected 30, 100, or 300.')
        );
    }
    issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
    const sessionCount = sessions.ok ? sessions.value : 30;
    const expected = {
        capture: 'worker',
        workload: 'RTC-B03',
        'case-id': 'topology-tree',
        'input-key': `sessions-${sessionCount}`,
        'rtc-degree-limit': '5',
        'rtc-inner-runs': '5',
        'rtc-sessions': String(sessionCount)
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
        sessionCount,
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
                input: { sessions: sessionCount, degreeLimit: 5, runs: 5 },
                intendedPhase: phase as 'warmup' | 'retained',
                outerOrdinal: ordinal,
                sampleIds
            }
        };
}

function createExpectedSampleIds(
    sessions: number,
    phase: 'warmup' | 'retained',
    outerOrdinal: number
): string[] {
    const prefix = `rtc-b03-topology-tree-sessions-${sessions}-${phase}-` + String(outerOrdinal).padStart(3, '0');
    return Array.from(
        { length: 5 },
        (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(
    identity: RtcBaselineSampleIdentityDto,
    result: RtcTopologyTreeResult | null,
    issues: RtcBaselineSampleDto['issues']
): RtcBaselineSampleDto {
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
        evidenceClass: 'synthetic-path',
        metrics: result === null ? [] : [{ metric: 'durationMs', unit: 'ms', value: result.durationMs }],
        rawEvidence: result === null ? null : createRawEvidence(result),
        rawReferences: [],
        issues,
        runtimeObservation: null
    };
}

function createRawEvidence(result: RtcTopologyTreeResult): RtcBaselineJson {
    return {
        ...result,
        sessionIds: [...result.sessionIds],
        edgePairs: result.edgePairs.map(([from, to]) => [from, to])
    };
}

function validateResult(input: RtcTopologyTreeInput, result: RtcTopologyTreeResult) {
    const validSessions = JSON.stringify(result.sessionIds) === JSON.stringify(createSessionIds(input.sessions));
    return result.topology === 'tree' &&
            result.changed &&
            validSessions &&
            hasValidGraph(result, input.sessions - 1, input.degreeLimit)
        ? []
        : [rtcBaselineIssue('$.rawEvidence', 'topology-invariant-mismatch', 'Unexpected tree graph.')];
}

function hasValidGraph(result: RtcTopologyTreeResult, edgeCount: number, maximumDegree: number) {
    const neighbors = new Map(result.sessionIds.map((sessionId) => [sessionId, new Set<string>()]));
    for (const [from, to] of result.edgePairs) {
        if (from >= to || !neighbors.has(from) || !neighbors.has(to) || neighbors.get(from)?.has(to)) {
            return false;
        }
        neighbors.get(from)?.add(to);
        neighbors.get(to)?.add(from);
    }
    if (
        result.edgePairs.length !== edgeCount ||
        [...neighbors.values()].some((peers) => peers.size > maximumDegree)
    ) {
        return false;
    }
    const visited = new Set<string>();
    const pending = [result.sessionIds[0]];
    while (pending.length > 0) {
        const sessionId = pending.pop();
        if (sessionId === undefined || visited.has(sessionId)) {
            continue;
        }
        visited.add(sessionId);
        pending.push(...(neighbors.get(sessionId) ?? []));
    }
    return visited.size === result.sessionIds.length;
}

function createSessionIds(count: number): string[] {
    return Array.from(
        { length: count },
        (_value, index) => `session-${String(index).padStart(3, '0')}`
    );
}

function toEdgePairs(
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>
): Array<readonly [string, string]> {
    const pairs: Array<readonly [string, string]> = [];
    for (const [from, nextHops] of Object.entries(nextHopsBySessionId)) {
        for (const to of nextHops) {
            if (from < to) {
                pairs.push([from, to]);
            }
        }
    }
    return pairs.sort(
        ([leftFrom, leftTo], [rightFrom, rightTo]) => leftFrom.localeCompare(rightFrom) || leftTo.localeCompare(rightTo)
    );
}

function isDiagnosticOutput(out: string): boolean {
    return (
        out.startsWith('tmp/perf/results/') &&
        !out.includes('\\') &&
        out.split('/').every((component) => component !== '' && component !== '.' && component !== '..')
    );
}

async function main(): Promise<void> {
    const parsed = parseRtcTopologyTreeArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    if (parsed.value.mode === 'accepted') {
        console.log(
            JSON.stringify(
                await runRtcTopologyTreeAcceptedSamples({
                    worker: parsed.value,
                    run: () => runRtcTopologyTree(parsed.value.input.sessions, parsed.value.input.degreeLimit)
                })
            )
        );
        return;
    }
    const results = Array.from({ length: parsed.value.input.runs }, (_value, index) => ({
        run: index + 1,
        ...runRtcTopologyTree(parsed.value.input.sessions, parsed.value.input.degreeLimit)
    }));
    await Deno.writeTextFile(
        parsed.value.out,
        `${JSON.stringify({ input: parsed.value.input, results }, null, 2)}\n`,
        { createNew: true }
    );
    console.log(`Wrote ${parsed.value.out}`);
}

if (import.meta.main) {
    await main();
}

import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
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

export type RtcRoomGraphRttMode = 'sparse' | 'complete';
interface RtcRoomGraphRttInput {
    readonly sessions: number;
    readonly mode: RtcRoomGraphRttMode;
    readonly sparseDegree: number;
    readonly runs: number;
}
interface RtcRoomGraphRttAcceptedArguments {
    readonly mode: 'accepted';
    readonly input: RtcRoomGraphRttInput;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}
export interface RtcRoomGraphRttResult {
    readonly durationMs: number;
    readonly sessionIds: readonly string[];
    readonly edgePairs: readonly (readonly [string, string])[];
    readonly measurements: readonly RttMeasurementInfo[];
}

const acceptedNames = `capture baseline-id workload case-id input-key intended-phase outer-ordinal
sample-ids rtc-inner-runs rtc-sessions rtc-sparse-degree`.split(/\s+/);
const acceptedSessionCounts = new Set([30, 100, 300]);

export function parseRtcRoomGraphRttArguments(arguments_: readonly string[]) {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : ['sessions', 'runs', 'out']
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export function runRtcRoomGraphRtt(
    sessions: number,
    mode: RtcRoomGraphRttMode,
    sparseDegree: number
): RtcRoomGraphRttResult {
    const sessionIds = createSessionIds(sessions);
    const group = createDeterministicRtcTopologyGroupSnapshot('room-1', sessionIds);
    const measurements = createRttMeasurements(sessionIds, mode, sparseDegree);
    const service = new RallarRtcTopologyService();
    const startedAt = performance.now();
    const graph = service.createRoomGraph(group, measurements);
    const durationMs = performance.now() - startedAt;
    const edgePairs = graph
        .edges()
        .map((edge) => {
            const [from, to] = graph.extremities(edge);
            return (from < to ? [from, to] : [to, from]) as readonly [string, string];
        })
        .sort(comparePairs);
    return { durationMs, sessionIds: [...graph.nodes()].sort(), edgePairs, measurements };
}

export async function runRtcRoomGraphRttAcceptedSamples(input: {
    readonly worker: RtcRoomGraphRttAcceptedArguments;
    readonly run: () => Promise<RtcRoomGraphRttResult> | RtcRoomGraphRttResult;
}): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: {
            ...input.worker,
            workloadId: 'RTC-B03',
            caseId: `room-graph-rtt-${input.worker.input.mode}`,
            inputKey: `sessions-${input.worker.input.sessions}`
        },
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        createSample: ({ identity, result, issues }) => createSample(identity, result, issues)
    });
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
    const sessions = parseRtcBaselineBoundedInteger(options.sessions ?? '600', 'sessions', 2, 600);
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '5', 'runs', 1, 5);
    const out = options.out ?? 'tmp/perf/results/rtc-room-graph-rtt.json';
    const issues = [...(!sessions.ok ? sessions.issues : []), ...(!runs.ok ? runs.issues : [])];
    if (!isDiagnosticOutput(out)) {
        issues.push(rtcBaselineIssue('$.out', 'invalid-diagnostic-output', 'Invalid result path.'));
    }
    if (issues.length > 0) {
        return { ok: false as const, issues };
    }
    const input = {
        sessions: sessions.ok ? sessions.value : 2,
        mode: 'complete' as const,
        sparseDegree: 4,
        runs: runs.ok ? runs.value : 1
    };
    return { ok: true as const, value: { mode: 'diagnostic' as const, input, out } };
}

function parseAcceptedArguments(options: Readonly<Record<string, string>>) {
    const sessionValue = options['rtc-sessions'] ?? '';
    const outerValue = options['outer-ordinal'] ?? '';
    const sessions = parseRtcBaselineBoundedInteger(sessionValue, 'rtc-sessions', 30, 300);
    const outer = parseRtcBaselineBoundedInteger(outerValue, 'outer-ordinal', 1, 999);
    const issues = [...(!sessions.ok ? sessions.issues : []), ...(!outer.ok ? outer.issues : [])];
    if (sessions.ok && !acceptedSessionCounts.has(sessions.value)) {
        issues.push(rtcBaselineIssue('$.rtc-sessions', 'unexpected-worker-input', 'Invalid count.'));
    }
    issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
    const caseId = options['case-id'];
    let mode: RtcRoomGraphRttMode | undefined;
    if (caseId === 'room-graph-rtt-sparse') {
        mode = 'sparse';
    }
    else if (caseId === 'room-graph-rtt-complete') {
        mode = 'complete';
    }
    if (mode === undefined) {
        issues.push(rtcBaselineIssue('$.case-id', 'unexpected-worker-input', 'Invalid graph case.'));
    }
    const sessionCount = sessions.ok ? sessions.value : 30;
    const expected = {
        capture: 'worker',
        workload: 'RTC-B03',
        'input-key': `sessions-${sessionCount}`,
        'rtc-inner-runs': '5',
        'rtc-sessions': String(sessionCount),
        ...(mode === 'sparse' ? { 'rtc-sparse-degree': '4' } : {})
    };
    for (const [name, value] of Object.entries(expected)) {
        if (options[name] !== value) {
            issues.push(rtcBaselineIssue(`$.${name}`, 'unexpected-worker-input', `Expected ${value}.`));
        }
    }
    if (mode === 'complete' && options['rtc-sparse-degree'] !== undefined) {
        issues.push(rtcBaselineIssue('$.rtc-sparse-degree', 'unexpected-worker-input', 'Not used.'));
    }
    const phase = options['intended-phase'];
    if (phase !== 'warmup' && phase !== 'retained') {
        issues.push(rtcBaselineIssue('$.intended-phase', 'unexpected-worker-input', 'Invalid phase.'));
    }
    const ordinal = outer.ok ? outer.value : 0;
    const inputMode = mode ?? 'complete';
    const input = { sessions: sessionCount, mode: inputMode, sparseDegree: 4, runs: 5 };
    const sampleIds = (options['sample-ids'] ?? '').split(',');
    const expectedIds = createExpectedSampleIds(
        input,
        phase === 'warmup' ? phase : 'retained',
        ordinal
    );
    if (JSON.stringify(sampleIds) !== JSON.stringify(expectedIds)) {
        issues.push(rtcBaselineIssue('$.sample-ids', 'unexpected-worker-input', 'Invalid sample IDs.'));
    }
    if (issues.length > 0) {
        return { ok: false as const, issues };
    }
    return {
        ok: true as const,
        value: {
            mode: 'accepted' as const,
            input,
            intendedPhase: phase as 'warmup' | 'retained',
            outerOrdinal: ordinal,
            sampleIds
        }
    };
}

function createExpectedSampleIds(
    input: RtcRoomGraphRttInput,
    phase: 'warmup' | 'retained',
    outerOrdinal: number
): string[] {
    const prefix = `rtc-b03-room-graph-rtt-${input.mode}-sessions-${input.sessions}-${phase}-` +
        String(outerOrdinal).padStart(3, '0');
    return Array.from(
        { length: 5 },
        (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(
    identity: RtcBaselineSampleIdentityDto,
    result: RtcRoomGraphRttResult | null,
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

function createRawEvidence(result: RtcRoomGraphRttResult): RtcBaselineJson {
    return {
        durationMs: result.durationMs,
        sessionIds: [...result.sessionIds],
        edgePairs: result.edgePairs.map(([from, to]) => [from, to]),
        measurements: result.measurements.map((measurement) => ({ ...measurement }))
    };
}

function validateResult(input: RtcRoomGraphRttInput, result: RtcRoomGraphRttResult) {
    const expectedSessions = createSessionIds(input.sessions);
    const expectedMeasurements = createRttMeasurements(
        expectedSessions,
        input.mode,
        input.sparseDegree
    );
    const validMeasurements = JSON.stringify(result.measurements) === JSON.stringify(expectedMeasurements);
    const validEdgeCount = result.edgePairs.length >= input.sessions - 1 &&
        result.edgePairs.length <= Math.floor((input.sessions * 5) / 2);
    return JSON.stringify(result.sessionIds) === JSON.stringify(expectedSessions) &&
            validEdgeCount &&
            hasValidTopology(result) &&
            validMeasurements
        ? []
        : [rtcBaselineIssue('$.rawEvidence', 'rtt-graph-invariant-mismatch', 'Unexpected RTT graph.')];
}

function hasValidTopology(result: RtcRoomGraphRttResult): boolean {
    const neighbors = new Map(result.sessionIds.map((sessionId) => [sessionId, new Set<string>()]));
    for (const [from, to] of result.edgePairs) {
        if (from >= to || !neighbors.has(from) || !neighbors.has(to) || neighbors.get(from)?.has(to)) {
            return false;
        }
        neighbors.get(from)?.add(to);
        neighbors.get(to)?.add(from);
    }
    if ([...neighbors.values()].some((peers) => peers.size > 5)) {
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

function createRttMeasurements(
    sessionIds: readonly string[],
    mode: RtcRoomGraphRttMode,
    sparseDegree: number
): RttMeasurementInfo[] {
    const sparsePairs = mode === 'sparse' ? createSparsePairSet(sessionIds.length, sparseDegree) : null;
    const measurements: RttMeasurementInfo[] = [];
    let version = 0;
    for (let fromIndex = 0; fromIndex < sessionIds.length; fromIndex += 1) {
        for (let toIndex = fromIndex + 1; toIndex < sessionIds.length; toIndex += 1) {
            version += 1;
            if (sparsePairs !== null && !sparsePairs.has(`${fromIndex}:${toIndex}`)) {
                continue;
            }
            measurements.push({
                sessionIdFrom: sessionIds[fromIndex],
                sessionIdTo: sessionIds[toIndex],
                rttMs: 5 + ((fromIndex * 31 + toIndex * 17) % 96),
                createdAtEpochMs: version,
                version
            });
        }
    }
    return measurements;
}

function createSparsePairSet(sessionCount: number, sparseDegree: number): Set<string> {
    const pairs = new Set<string>();
    for (let index = 0; index < sessionCount; index += 1) {
        for (let offset = 1; offset <= sparseDegree / 2; offset += 1) {
            const neighbor = (index + offset) % sessionCount;
            pairs.add(index < neighbor ? `${index}:${neighbor}` : `${neighbor}:${index}`);
        }
    }
    return pairs;
}

function comparePairs(
    [leftFrom, leftTo]: readonly [string, string],
    [rightFrom, rightTo]: readonly [string, string]
): number {
    return leftFrom.localeCompare(rightFrom) || leftTo.localeCompare(rightTo);
}

function createSessionIds(count: number): string[] {
    return Array.from(
        { length: count },
        (_value, index) => `session-${String(index).padStart(3, '0')}`
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
    const parsed = parseRtcRoomGraphRttArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    if (parsed.value.mode === 'accepted') {
        const samples = await runRtcRoomGraphRttAcceptedSamples({
            worker: parsed.value,
            run: () =>
                runRtcRoomGraphRtt(
                    parsed.value.input.sessions,
                    parsed.value.input.mode,
                    parsed.value.input.sparseDegree
                )
        });
        console.log(JSON.stringify(samples));
        return;
    }
    const results = Array.from({ length: parsed.value.input.runs }, (_value, index) => ({
        run: index + 1,
        ...runRtcRoomGraphRtt(parsed.value.input.sessions, 'complete', 4)
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

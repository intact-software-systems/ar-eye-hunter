import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
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

export type RtcTopologyInactiveChurnMode = 'retain' | 'cleanup';
interface RtcTopologyInactiveChurnInput {
    readonly groups: number;
    readonly sessionsPerGroup: number;
    readonly runs: number;
    readonly mode: RtcTopologyInactiveChurnMode;
}
interface RtcTopologyInactiveChurnAcceptedArguments {
    readonly mode: 'accepted';
    readonly input: RtcTopologyInactiveChurnInput;
    readonly intendedPhase: 'warmup' | 'retained';
    readonly outerOrdinal: number;
    readonly sampleIds: readonly string[];
}
export interface RtcTopologyInactiveChurnResult {
    readonly mode: RtcTopologyInactiveChurnMode;
    readonly groupCount: number;
    readonly sessionsPerGroup: number;
    readonly sessionIdsPerGroup: readonly string[];
    readonly activeUpdateDurationMs: number;
    readonly inactivePhaseDurationMs: number;
    readonly finalTopologySnapshotCount: number;
    readonly topologyRemovalRequestCount: number;
    readonly topologyRemovedCount: number;
    readonly topologyRemoveMissCount: number;
}

const acceptedNames = `capture baseline-id workload case-id input-key intended-phase outer-ordinal
sample-ids rtc-groups rtc-inner-runs rtc-mode rtc-sessions-per-group`.split(/\s+/);

export function parseRtcTopologyInactiveChurnArguments(arguments_: readonly string[]) {
    const accepted = arguments_.some((argument) => argument.startsWith('--capture='));
    const parsed = parseRtcBaselineOneTokenOptions(
        arguments_,
        accepted ? acceptedNames : ['groups', 'sessions', 'runs', 'mode', 'out']
    );
    if (!parsed.ok) {
        return parsed;
    }
    return accepted ? parseAcceptedArguments(parsed.value) : parseDiagnosticArguments(parsed.value);
}

export function runRtcTopologyInactiveChurn(
    groups: number,
    sessionsPerGroup: number,
    mode: RtcTopologyInactiveChurnMode
): RtcTopologyInactiveChurnResult {
    const service = new RallarRtcTopologyService({ now: () => 1_000 });
    const sessionIdsPerGroup = Array.from(
        { length: sessionsPerGroup },
        (_session, sessionIndex) => `session-${String(sessionIndex).padStart(3, '0')}`
    );
    const snapshots = Array.from({ length: groups }, (_value, index) => {
        const groupId = `room-${String(index + 1).padStart(5, '0')}`;
        return createDeterministicRtcTopologyGroupSnapshot(groupId, sessionIdsPerGroup);
    });
    const activeStartedAt = performance.now();
    for (const snapshot of snapshots) {
        service.updateGroupTopology(snapshot);
    }
    const activeUpdateDurationMs = performance.now() - activeStartedAt;
    const inactiveStartedAt = performance.now();
    if (mode === 'cleanup') {
        for (const snapshot of snapshots) {
            service.removeGroupTopology(createInactiveGroupSnapshot(snapshot));
        }
    }
    else {
        for (const snapshot of snapshots) {
            createInactiveGroupSnapshot(snapshot);
        }
    }
    const inactivePhaseDurationMs = performance.now() - inactiveStartedAt;
    const metrics = service.readMetrics();
    return {
        mode,
        groupCount: groups,
        sessionsPerGroup,
        sessionIdsPerGroup,
        activeUpdateDurationMs,
        inactivePhaseDurationMs,
        finalTopologySnapshotCount: metrics.topologySnapshotCount,
        topologyRemovalRequestCount: metrics.topologyRemovalRequestCount,
        topologyRemovedCount: metrics.topologyRemovedCount,
        topologyRemoveMissCount: metrics.topologyRemoveMissCount
    };
}

export async function runRtcTopologyInactiveChurnAcceptedSamples(input: {
    readonly worker: RtcTopologyInactiveChurnAcceptedArguments;
    readonly run: () => Promise<RtcTopologyInactiveChurnResult> | RtcTopologyInactiveChurnResult;
}): Promise<RtcBaselineSampleDto[]> {
    return runRtcBaselineAcceptedWorkerSamples({
        worker: {
            ...input.worker,
            workloadId: 'RTC-B03',
            caseId: 'topology-inactive-churn',
            inputKey: `mode-${input.worker.input.mode}`
        },
        run: input.run,
        validate: (result) => validateResult(input.worker.input, result),
        createSample: ({ identity, result, issues }) => createSample(identity, result, issues)
    });
}

function parseDiagnosticArguments(options: Readonly<Record<string, string>>) {
    const groups = parseRtcBaselineBoundedInteger(options.groups ?? '10000', 'groups', 1, 10000);
    const sessions = parseRtcBaselineBoundedInteger(options.sessions ?? '5', 'sessions', 1, 100);
    const runs = parseRtcBaselineBoundedInteger(options.runs ?? '3', 'runs', 1, 3);
    const mode = options.mode ?? 'cleanup';
    const out = options.out ?? `tmp/perf/results/rtc-topology-inactive-churn-${mode}.json`;
    const issues = [
        ...(!groups.ok ? groups.issues : []),
        ...(!sessions.ok ? sessions.issues : []),
        ...(!runs.ok ? runs.issues : [])
    ];
    if (mode !== 'retain' && mode !== 'cleanup') {
        issues.push(rtcBaselineIssue('$.mode', 'unexpected-worker-input', 'Invalid mode.'));
    }
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
                    groups: groups.ok ? groups.value : 1,
                    sessionsPerGroup: sessions.ok ? sessions.value : 1,
                    runs: runs.ok ? runs.value : 1,
                    mode: mode as RtcTopologyInactiveChurnMode
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
    const issues = [...(!outer.ok ? outer.issues : [])];
    issues.push(...validateRtcBaselineId(options['baseline-id'] ?? ''));
    const mode = options['rtc-mode'];
    if (mode !== 'retain' && mode !== 'cleanup') {
        issues.push(rtcBaselineIssue('$.rtc-mode', 'unexpected-worker-input', 'Invalid mode.'));
    }
    const inputMode: RtcTopologyInactiveChurnMode = mode === 'retain' ? 'retain' : 'cleanup';
    const expected = {
        capture: 'worker',
        workload: 'RTC-B03',
        'case-id': 'topology-inactive-churn',
        'input-key': `mode-${inputMode}`,
        'rtc-groups': '10000',
        'rtc-inner-runs': '3',
        'rtc-mode': inputMode,
        'rtc-sessions-per-group': '5'
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
        inputMode,
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
                input: { groups: 10000, sessionsPerGroup: 5, runs: 3, mode: inputMode },
                intendedPhase: phase as 'warmup' | 'retained',
                outerOrdinal: ordinal,
                sampleIds
            }
        };
}

function createExpectedSampleIds(
    mode: RtcTopologyInactiveChurnMode,
    phase: 'warmup' | 'retained',
    outerOrdinal: number
): string[] {
    const prefix = `rtc-b03-topology-inactive-churn-mode-${mode}-${phase}-` +
        String(outerOrdinal).padStart(3, '0');
    return Array.from(
        { length: 3 },
        (_value, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`
    );
}

function createSample(
    identity: RtcBaselineSampleIdentityDto,
    result: RtcTopologyInactiveChurnResult | null,
    issues: RtcBaselineSampleDto['issues']
): RtcBaselineSampleDto {
    return {
        schema: 'rallar.rtc-baseline.sample.v1',
        identity,
        outcome: result === null ? 'not-run' : issues.length === 0 ? 'passed' : 'failed',
        evidenceClass: 'synthetic-path',
        metrics: result === null
            ? []
            : [
                { metric: 'activeUpdateDurationMs', unit: 'ms', value: result.activeUpdateDurationMs },
                {
                    metric: 'inactivePhaseDurationMs',
                    unit: 'ms',
                    value: result.inactivePhaseDurationMs
                }
            ],
        rawEvidence: result === null ? null : createRawEvidence(result),
        rawReferences: [],
        issues,
        runtimeObservation: null
    };
}

function createRawEvidence(result: RtcTopologyInactiveChurnResult): RtcBaselineJson {
    return { ...result, sessionIdsPerGroup: [...result.sessionIdsPerGroup] };
}

function validateResult(
    input: RtcTopologyInactiveChurnInput,
    result: RtcTopologyInactiveChurnResult
) {
    const expectedFinalCount = input.mode === 'retain' ? input.groups : 0;
    const expectedRemovalCount = input.mode === 'retain' ? 0 : input.groups;
    return result.mode === input.mode &&
            result.groupCount === input.groups &&
            result.sessionsPerGroup === input.sessionsPerGroup &&
            JSON.stringify(result.sessionIdsPerGroup) ===
                JSON.stringify(['session-000', 'session-001', 'session-002', 'session-003', 'session-004']) &&
            result.finalTopologySnapshotCount === expectedFinalCount &&
            result.topologyRemovalRequestCount === expectedRemovalCount &&
            result.topologyRemovedCount === expectedRemovalCount &&
            result.topologyRemoveMissCount === 0
        ? []
        : [rtcBaselineIssue('$.rawEvidence', 'inactive-churn-mismatch', 'Unexpected state lifetime.')];
}

function createInactiveGroupSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
    const archived = { ...snapshot.group.updated, atEpochMs: 2 };
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            status: 'archived',
            snapshotVersion: snapshot.group.snapshotVersion + 1,
            updated: archived,
            archived,
            deleted: null
        },
        activeSessions: [],
        onlineMemberCount: 0
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
    const parsed = parseRtcTopologyInactiveChurnArguments(Deno.args);
    if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.issues));
    }
    if (parsed.value.mode === 'accepted') {
        const samples = await runRtcTopologyInactiveChurnAcceptedSamples({
            worker: parsed.value,
            run: () =>
                runRtcTopologyInactiveChurn(
                    parsed.value.input.groups,
                    parsed.value.input.sessionsPerGroup,
                    parsed.value.input.mode
                )
        });
        console.log(JSON.stringify(samples));
        return;
    }
    const results = Array.from({ length: parsed.value.input.runs }, (_value, index) => ({
        run: index + 1,
        ...runRtcTopologyInactiveChurn(
            parsed.value.input.groups,
            parsed.value.input.sessionsPerGroup,
            parsed.value.input.mode
        )
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

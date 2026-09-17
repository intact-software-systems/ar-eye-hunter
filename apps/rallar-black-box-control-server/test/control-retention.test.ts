import type { ControlRetentionPlan } from '@shared-test/rallar-bb-test/control-retention.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot, ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlFleetRunReport } from '@shared-test/rallar-bb-test/fleet-report.ts';
import { assert } from '@std/assert';

import { createRallarBlackBoxControlService, RallarBlackBoxControlService } from '../src/control-service.ts';
import { assertJsonEquals, toControlServiceInput } from './support/control-service-test-fixtures.ts';

Deno.test('control retention planning is passive and applies exact current prune order', () => {
    let clockReads = 0;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => {
            clockReads += 1;
            return 50_000;
        }
    }));
    service.restoreSnapshot(retentionSnapshot());
    clockReads = 0;

    const plan = service.createRetentionPlan(1);

    assertJsonEquals(clockReads, 0);
    assertJsonEquals(plan.deletedRunIds, ['run-old']);
    assertJsonEquals(plan.distributedRunIds, ['dist-old']);
    assertJsonEquals(plan.fleetReportIds, ['dist-old']);
    assertJsonEquals(plan.candidates, [{
        runId: 'run-old',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000,
        connectedAgentCount: 0,
        issuedRunTokenCount: 0,
        distributedRuns: [{ distributedRunId: 'dist-old', state: 'waiting-for-ack' }],
        fleetReportIds: ['dist-old']
    }]);
    assertJsonEquals(service.createRetentionPlan(1).canonicalConsequence, plan.canonicalConsequence);
    assertJsonEquals(clockReads, 0);

    assertJsonEquals(service.applyRetentionPlan(plan), ['run-old']);
    assertJsonEquals(service.snapshotRun('run-old'), undefined);
    assert(service.snapshotRun('run-new'));
});

Deno.test('control retention planning detects same-time issued-token drift without exposing tokens', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.restoreSnapshot(retentionSnapshot());
    const before = service.createRetentionPlan(1);
    const updatedBefore = service.snapshotRun('run-old')?.updatedAtEpochMs;

    const issued = service.issueRunToken({ runId: 'run-old', agentId: 'agent-old', ttlMs: 60_000 });
    const after = service.createRetentionPlan(1);

    assertJsonEquals(service.snapshotRun('run-old')?.updatedAtEpochMs, updatedBefore);
    assertJsonEquals(after.candidates[0]?.issuedRunTokenCount, 1);
    assert(after.canonicalConsequence !== before.canonicalConsequence);
    assert(!after.canonicalConsequence.includes(issued.token));
});

Deno.test('immediate prune preserves response order independently from bounded preview planning', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.restoreSnapshot(retentionSnapshot());

    assertJsonEquals(service.applyRunRetention(1), ['run-old']);
    assertJsonEquals(service.createRetentionPlan(1).deletedRunIds, []);
});

Deno.test('immediate prune preserves its disabled and already-bounded fast paths', () => {
    class PlanningProbe extends RallarBlackBoxControlService {
        planCalls = 0;

        override createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan {
            this.planCalls += 1;
            return super.createRetentionPlan(maxRuns);
        }
    }
    const service = new PlanningProbe(toControlServiceInput());
    service.restoreSnapshot(retentionSnapshot());

    assertJsonEquals(service.applyRunRetention(undefined), []);
    assertJsonEquals(service.applyRunRetention(0), []);
    assertJsonEquals(service.applyRunRetention(2), []);
    assertJsonEquals(service.planCalls, 0);
    assertJsonEquals(service.applyRunRetention(1), ['run-old']);
    assertJsonEquals(service.planCalls, 0);
});

Deno.test('immediate prune remains available beyond bounded preview candidate limits', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    const runs = Array.from(
        { length: 1_002 },
        (_, index) => controlRun(`immediate-run-${index}`, index, false)
    );
    service.restoreSnapshot({ runs, distributedRuns: [], fleetReports: [] });

    const deleted = service.applyRunRetention(1);

    assertJsonEquals(deleted.length, 1_001);
    assertJsonEquals(deleted[0], 'immediate-run-0');
    assertJsonEquals(deleted.at(-1), 'immediate-run-1000');
    assert(service.snapshotRun('immediate-run-1001'));
});

const EMPTY_ROLLUP_SUMMARY: ControlDistributedRunSnapshot['rollup']['summary'] = {
    participants: 0,
    readyParticipants: 0,
    passedParticipants: 0,
    failedParticipants: 0,
    recipes: 0,
    passedRecipes: 0,
    failedRecipes: 0,
    groupAssertions: 0,
    passedGroupAssertions: 0,
    failedGroupAssertions: 0,
    blockingFailures: 0
};

function retentionSnapshot(): ControlServerSnapshot {
    return {
        runs: [
            controlRun('run-old', 1_000, true),
            controlRun('run-new', 2_000, false)
        ],
        distributedRuns: [distributedRun()],
        fleetReports: [
            fleetReport('dist-old', 'run-old'),
            fleetReport('orphan-report', 'run-old')
        ]
    };
}

function controlRun(
    runId: string,
    updatedAtEpochMs: number,
    connected: boolean
): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: updatedAtEpochMs,
        updatedAtEpochMs,
        agents: [{
            runId,
            agentId: runId === 'run-old' ? 'agent-old' : 'agent-new',
            connected,
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: []
        }],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

function distributedRun(): ControlDistributedRunSnapshot {
    return {
        distributedRunId: 'dist-old',
        controlRunId: 'run-old',
        manifest: {
            distributedRunId: 'dist-old',
            controlRunId: 'run-old',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'group-a'
            },
            recipes: [],
            targetPolicy: { mode: 'selected-agents', agentIds: [] },
            schemaVersion: 1,
            variables: {},
            roleAssignments: [],
            ackTimeoutMs: 30_000,
            barrier: { enabled: false },
            startMode: 'manual',
            groupAssertions: [],
            metadata: {}
        },
        state: 'waiting-for-ack',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000,
        targetAgentIds: [],
        commandLinks: [],
        rollup: { state: 'waiting-for-ack', ok: false, summary: EMPTY_ROLLUP_SUMMARY, failures: [] }
    };
}

function fleetReport(
    distributedRunId: string,
    controlRunId: string
): ControlFleetRunReport {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId,
        generatedAtEpochMs: 1_000,
        state: 'failed',
        ok: false,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'group-a'
        },
        recipeIds: [],
        summary: {
            agents: 0,
            regions: 0,
            passed: 0,
            failed: 1,
            missing: 0,
            flaky: 0,
            stale: 0,
            passRate: 0,
            failureGroups: 1
        },
        timing: { run: { count: 0 }, commands: { count: 0 } },
        agents: [],
        regions: [],
        failureSignatures: [],
        artifactRefs: {
            distributedRun: `/distributed-runs/${distributedRunId}`,
            controlRun: `/runs/${controlRunId}`,
            fleetReport: `/fleet/reports/${distributedRunId}`
        }
    };
}

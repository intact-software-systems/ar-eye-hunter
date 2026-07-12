import {
  createRallarBlackBoxControlService,
  RallarBlackBoxControlService,
} from '../src/control-service.ts';
import type { ControlRetentionPlan } from '@shared-test/rallar-bb-test/control-retention.ts';
import type {
  ControlDistributedRunSnapshot,
  ControlRunSnapshot,
  ControlServerSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlFleetRunReport } from '@shared-test/rallar-bb-test/fleet-report.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

Deno.test('control retention planning is passive and applies exact current prune order', () => {
  let clockReads = 0;
  const service = createRallarBlackBoxControlService({
    now: () => {
      clockReads += 1;
      return 50_000;
    },
  });
  service.restoreSnapshot(retentionSnapshot());
  clockReads = 0;

  const plan = service.createRetentionPlan(1);

  assertEquals(clockReads, 0);
  assertEquals(plan.deletedRunIds, ['run-old']);
  assertEquals(plan.distributedRunIds, ['dist-old']);
  assertEquals(plan.fleetReportIds, ['dist-old']);
  assertEquals(plan.candidates, [{
    runId: 'run-old',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000,
    connectedAgentCount: 0,
    issuedRunTokenCount: 0,
    distributedRuns: [{ distributedRunId: 'dist-old', state: 'waiting-for-ack' }],
    fleetReportIds: ['dist-old'],
  }]);
  assertEquals(service.createRetentionPlan(1).canonicalConsequence, plan.canonicalConsequence);
  assertEquals(clockReads, 0);

  assertEquals(service.applyRetentionPlan(plan), ['run-old']);
  assertEquals(service.snapshotRun('run-old'), undefined);
  assert(service.snapshotRun('run-new'));
});

Deno.test('control retention planning detects same-time issued-token drift without exposing tokens', () => {
  const service = createRallarBlackBoxControlService({ now: () => 1_000 });
  service.restoreSnapshot(retentionSnapshot());
  const before = service.createRetentionPlan(1);
  const updatedBefore = service.snapshotRun('run-old')?.updatedAtEpochMs;

  const issued = service.issueRunToken({ runId: 'run-old', agentId: 'agent-old' });
  const after = service.createRetentionPlan(1);

  assertEquals(service.snapshotRun('run-old')?.updatedAtEpochMs, updatedBefore);
  assertEquals(after.candidates[0]?.issuedRunTokenCount, 1);
  assert(after.canonicalConsequence !== before.canonicalConsequence);
  assert(!after.canonicalConsequence.includes(issued.token));
});

Deno.test('legacy prune preserves response order independently from bounded preview planning', () => {
  const service = createRallarBlackBoxControlService();
  service.restoreSnapshot(retentionSnapshot());

  assertEquals(service.pruneRuns(1), ['run-old']);
  assertEquals(service.createRetentionPlan(1).deletedRunIds, []);
});

Deno.test('legacy prune preserves its disabled and already-bounded fast paths', () => {
  class PlanningProbe extends RallarBlackBoxControlService {
    planCalls = 0;

    override createRetentionPlan(maxRuns: number | undefined): ControlRetentionPlan {
      this.planCalls += 1;
      return super.createRetentionPlan(maxRuns);
    }
  }
  const service = new PlanningProbe();
  service.restoreSnapshot(retentionSnapshot());

  assertEquals(service.pruneRuns(undefined), []);
  assertEquals(service.pruneRuns(0), []);
  assertEquals(service.pruneRuns(2), []);
  assertEquals(service.planCalls, 0);
  assertEquals(service.pruneRuns(1), ['run-old']);
  assertEquals(service.planCalls, 0);
});

Deno.test('legacy prune remains available beyond bounded preview candidate limits', () => {
  const service = createRallarBlackBoxControlService();
  const runs = Array.from(
    { length: 1_002 },
    (_, index) => controlRun(`legacy-run-${index}`, index, false),
  );
  service.restoreSnapshot({ runs, distributedRuns: [], fleetReports: [] });

  const deleted = service.pruneRuns(1);

  assertEquals(deleted.length, 1_001);
  assertEquals(deleted[0], 'legacy-run-0');
  assertEquals(deleted.at(-1), 'legacy-run-1000');
  assert(service.snapshotRun('legacy-run-1001'));
});

function retentionSnapshot(): ControlServerSnapshot {
  return {
    runs: [
      controlRun('run-old', 1_000, true),
      controlRun('run-new', 2_000, false),
    ],
    distributedRuns: [distributedRun()],
    fleetReports: [
      fleetReport('dist-old', 'run-old'),
      fleetReport('orphan-report', 'run-old'),
    ],
  };
}

function controlRun(
  runId: string,
  updatedAtEpochMs: number,
  connected: boolean,
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
      resumeCompletedCommandIds: [],
    }],
    commands: [],
    results: [],
    events: [],
    stats: [],
    reports: [],
    heartbeats: [],
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
        groupId: 'group-a',
      },
      recipes: [],
      targetPolicy: { mode: 'selected-agents', agentIds: [] },
    },
    state: 'waiting-for-ack',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000,
    targetAgentIds: [],
    commandLinks: [],
    rollup: {
      state: 'waiting-for-ack',
      ok: false,
      summary: {
        participants: 0,
        requiredParticipants: 0,
        readyParticipants: 0,
        passedParticipants: 0,
        failedParticipants: 0,
        recipes: 0,
        requiredRecipes: 0,
        passedRecipes: 0,
        failedRecipes: 0,
        blockingFailures: 0,
      },
      failures: [],
    },
  };
}

function fleetReport(
  distributedRunId: string,
  controlRunId: string,
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
      groupId: 'group-a',
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
      failureGroups: 1,
    },
    timing: { run: { count: 0 }, commands: { count: 0 } },
    agents: [],
    regions: [],
    failureSignatures: [],
    artifactRefs: {
      distributedRun: `/distributed-runs/${distributedRunId}`,
      controlRun: `/runs/${controlRunId}`,
      fleetReport: `/fleet/reports/${distributedRunId}`,
    },
  };
}

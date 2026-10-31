import type { ControlEventEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { rollupDistributedRunResult } from '@shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import type { RallarBlackBoxTestRecipeRunCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { assert, assertEquals } from '@std/assert';
import { createControlFleetRunReport } from '../src/fleet/create-control-fleet-run-report.ts';
import { toDistributedManifest } from './support/control-service-test-fixtures.ts';

interface PollingFleetFixture {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot;
}

async function runPollingFixture(mode: 'success' | 'exhausted' | 'continue' | 'failed-root'): Promise<PollingFleetFixture> {
    let now = 1_000;
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: () => now,
        sleep: async (ms) => {
            now += ms;
        }
    });
    const command: RallarBlackBoxTestRecipeRunCommand = {
        kind: 'recipe.run',
        commandId: 'root',
        recipe: {
            schemaVersion: 1,
            recipeId: 'polling',
            commands: [
                {
                    kind: 'loop',
                    commandId: 'poll',
                    count: 4,
                    intervalMs: 500,
                    ...(mode === 'continue' ? { continueOnFailure: true } : { until: 'first-success' as const }),
                    commands: [{
                        kind: 'assert',
                        commandId: 'ready',
                        source: 'state.commandHistory.length',
                        operator: 'gte',
                        expected: mode === 'exhausted' ? 100 : 2
                    }]
                },
                ...(mode === 'failed-root'
                    ? [{ kind: 'assert' as const, commandId: 'unrelated-failure', source: 'state.commandHistory.length', operator: 'lt' as const, expected: 0 }]
                    : [])
            ]
        }
    };
    const result = await runtime.execute(command);
    const events: ControlEventEnvelope[] = runtime.state().events.filter((event) => event.severity === 'error').map((event) => ({
        kind: 'event',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'root',
        atEpochMs: event.atEpochMs,
        payload: event
    }));
    const state = result.ok ? 'passed' : 'failed';
    return {
        distributedRun: {
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            manifest: toDistributedManifest(),
            state,
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: now,
            targetAgentIds: ['agent-1'],
            commandLinks: [{ phase: 'start', agentId: 'agent-1', commandId: 'root', queuedAtEpochMs: 1_000 }],
            rollup: rollupDistributedRunResult({ stateHint: state })
        },
        controlRun: {
            runId: 'run-1',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: now,
            agents: [],
            commands: [{
                envelope: { kind: 'command', protocolVersion: 1, runId: 'run-1', agentId: 'agent-1', commandId: 'root', command },
                queuedAtEpochMs: 1_000,
                dispatchCount: 1
            }],
            results: [{ kind: 'result', protocolVersion: 1, runId: 'run-1', agentId: 'agent-1', commandId: 'root', ok: result.ok, result }],
            events,
            stats: [],
            reports: [],
            heartbeats: []
        }
    };
}

function report(fixture: PollingFleetFixture, events = fixture.controlRun.events) {
    return createControlFleetRunReport({ ...fixture, controlRun: { ...fixture.controlRun, events }, generatedAtEpochMs: 5_000, redaction: undefined });
}

Deno.test('fleet counts successful until polling as passed while retaining its failed attempts as diagnostics', async () => {
    const fixture = await runPollingFixture('success');
    const fleet = report(fixture);
    assertEquals(fleet.summary.failed, 0);
    assertEquals(fleet.summary.passRate, 1);
    assertEquals(fleet.agents[0].diagnosticCount, 2);
    assertEquals(fleet.failureSignatures, []);
    assertEquals(report(fixture, fixture.controlRun.events.slice(-1)).summary.passRate, 1);
    assertEquals(report(fixture, []).summary.passRate, 1);
});

for (const mode of ['exhausted', 'continue', 'failed-root'] as const) {
    Deno.test(`fleet preserves ${mode} failures`, async () => {
        const fixture = await runPollingFixture(mode);
        assertEquals(report(fixture).summary.failed, 1);
    });
}

Deno.test('fleet does not suppress an unrelated transport diagnostic under a passing root', async () => {
    const fixture = await runPollingFixture('success');
    const event = fixture.controlRun.events[0];
    assertEquals(report(fixture, [{ ...event, payload: { severity: 'error', topic: 'rtc.transport', message: 'Connection failed' } }]).summary.failed, 1);
});

Deno.test('fleet requires retained authored polling intent before suppressing an attempt', async () => {
    const fixture = await runPollingFixture('success');
    assertEquals(report({ ...fixture, controlRun: { ...fixture.controlRun, commands: [] } }).summary.failed, 1);
});

for (const field of ['runtimeId', 'generation', 'assignment', 'ordinal', 'rootCommandId'] as const) {
    Deno.test(`fleet does not suppress a polling event with another ${field}`, async () => {
        const fixture = await runPollingFixture('success');
        const event = fixture.controlRun.events[0];
        assert(isJsonRecordValue(event.payload));
        assert(isJsonRecordValue(event.payload.payload));
        assert(isJsonRecordValue(event.payload.payload.capture));
        const capture = event.payload.payload.capture;
        const changed = typeof capture[field] === 'number' ? capture[field] + 1 : `${capture[field]}-other`;
        const unrelated = { ...event, payload: { ...event.payload, payload: { ...event.payload.payload, capture: { ...capture, [field]: changed } } } };
        assertEquals(report(fixture, [unrelated]).summary.failed, 1);
    });
}

for (const field of ['runId', 'agentId'] as const) {
    Deno.test(`fleet does not suppress a polling event attributed to another ${field}`, async () => {
        const fixture = await runPollingFixture('success');
        const event = { ...fixture.controlRun.events[0], [field]: 'other' };
        assertEquals(report(fixture, [event]).failureSignatures.length, 1);
    });
}

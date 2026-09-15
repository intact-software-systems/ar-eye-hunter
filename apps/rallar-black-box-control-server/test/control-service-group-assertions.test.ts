import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlClientEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { assert } from '@std/assert';

import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { assertJsonEquals, toControlServiceInput } from './support/control-service-test-fixtures.ts';

function identity(agentId: string): RallarBlackBoxControlAgentIdentity {
    return {
        principalId: agentId,
        clientId: agentId,
        sessionId: `${agentId}-session`,
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'bb-group'
    };
}

function registerEnvelope(agentId: string): ControlClientEnvelope {
    return {
        kind: 'register',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId,
        atEpochMs: 1_000,
        identity: identity(agentId),
        resume: { completedCommandIds: [] }
    };
}

function recipeResultEnvelope(
    agentId: string,
    commandId: string,
    probeValue: unknown
): ControlClientEnvelope {
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId,
        commandId,
        ok: true,
        result: {
            commandId,
            kind: 'recipe.run',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 2_000,
            endedAtEpochMs: 2_050,
            durationMs: 50,
            value: {
                recipeId: 'probe-recipe',
                results: probeValue === undefined ? [] : [
                    {
                        commandId: 'probe-read',
                        kind: 'http.request',
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 2_010,
                        endedAtEpochMs: 2_020,
                        durationMs: 10,
                        value: probeValue
                    }
                ]
            }
        }
    };
}

function stageResultEnvelope(agentId: string, commandId: string): ControlClientEnvelope {
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId,
        commandId,
        ok: true,
        result: {
            commandId,
            kind: 'recipe.load',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 1_500,
            endedAtEpochMs: 1_510,
            durationMs: 10,
            value: { loaded: true }
        }
    };
}

function groupAssertionManifest(
    groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[]
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'dist-ga-1',
        controlRunId: 'run-1',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipes: [
            {
                recipeId: 'probe-recipe',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'probe-recipe',
                    commands: [
                        {
                            kind: 'http.request',
                            commandId: 'probe-read',
                            request: { method: 'GET', path: '/api/health' }
                        }
                    ]
                }
            }
        ],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1', 'agent-2']
        },
        startMode: 'manual',
        groupAssertions
    };
}

function runGroupAssertionDistributedRun(
    groupAssertions: readonly RallarBlackBoxDistributedGroupAssertion[],
    probeValueByAgentId: Readonly<Record<string, unknown>>
) {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    const agentIds = Object.keys(probeValueByAgentId);
    agentIds.forEach((agentId) => service.receiveClientEnvelope(registerEnvelope(agentId)));

    service.createDistributedRun(groupAssertionManifest(groupAssertions));
    service.stageDistributedRun('dist-ga-1');
    for (const agentId of agentIds) {
        const stageCommand = service.takeDispatchableCommands('run-1', agentId)[0];
        service.receiveClientEnvelope(stageResultEnvelope(agentId, stageCommand.commandId));
    }
    service.startDistributedRun('dist-ga-1');
    for (const agentId of agentIds) {
        const startCommand = service.takeDispatchableCommands('run-1', agentId)[0];
        service.receiveClientEnvelope(
            recipeResultEnvelope(agentId, startCommand.commandId, probeValueByAgentId[agentId])
        );
    }

    const snapshot = service.snapshotDistributedRun('dist-ga-1');
    assert(snapshot);
    return { service, snapshot };
}

const ALL_EQUAL_ASSERTION: RallarBlackBoxDistributedGroupAssertion = {
    groupAssertionId: 'members-converge',
    aggregate: 'allEqual',
    source: { recipeId: 'probe-recipe', commandId: 'probe-read', path: 'body.memberCount' }
};

Deno.test('group assertions pass a run when every agent contributed the same value', () => {
    const { snapshot } = runGroupAssertionDistributedRun([ALL_EQUAL_ASSERTION], {
        'agent-1': { body: { memberCount: 2 } },
        'agent-2': { body: { memberCount: 2 } }
    });

    assertJsonEquals(snapshot.state, 'passed');
    assertJsonEquals(snapshot.rollup.summary.groupAssertions, 1);
    assertJsonEquals(snapshot.rollup.summary.passedGroupAssertions, 1);
    assertJsonEquals(snapshot.rollup.summary.failedGroupAssertions, 0);
});

Deno.test('a single disagreeing agent fails allEqual naming that agent', () => {
    const { snapshot } = runGroupAssertionDistributedRun([ALL_EQUAL_ASSERTION], {
        'agent-1': { body: { memberCount: 2 } },
        'agent-2': { body: { memberCount: 3 } }
    });

    assertJsonEquals(snapshot.state, 'failed');
    const failure = snapshot.rollup.failures.find((entry) => entry.kind === 'group-assertion');
    assert(failure, 'Expected a group-assertion rollup failure.');
    assertJsonEquals(failure.key, 'members-converge');
    assertJsonEquals(failure.error?.code, 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED');
    const result = snapshot.rollup.groupAssertions?.[0];
    assert(result);
    assertJsonEquals(result.violatingAgentIds, ['agent-2']);
    const violatingRow = result.perAgent.find((row) => row.agentId === 'agent-2');
    assertJsonEquals(violatingRow?.verdict, 'violating');
});

Deno.test('missing evidence at the source address fails the assertion by default', () => {
    const { snapshot } = runGroupAssertionDistributedRun([ALL_EQUAL_ASSERTION], {
        'agent-1': { body: { memberCount: 2 } },
        'agent-2': undefined
    });

    assertJsonEquals(snapshot.state, 'failed');
    const result = snapshot.rollup.groupAssertions?.[0];
    assert(result);
    assertJsonEquals(result.ok, false);
    assertJsonEquals(result.missingAgentIds, ['agent-2']);
    assertJsonEquals(
        result.error?.code,
        'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING'
    );
});

Deno.test('group-assertion evidence commands keep full recipe results uncompacted', () => {
    const { service } = runGroupAssertionDistributedRun([ALL_EQUAL_ASSERTION], {
        'agent-1': { body: { memberCount: 2 } },
        'agent-2': { body: { memberCount: 2 } }
    });

    const run = service.snapshotRun('run-1');
    assert(run);
    const startResult = run.results.find((result) => result.commandId.includes('-start-agent-1-'));
    const value = startResult?.result?.value as { results?: unknown[]; };
    assert(Array.isArray(value.results), 'Expected uncompacted recipe results.');
});

Deno.test('redacted per-agent value tables hide sensitive evidence values', () => {
    const secretAssertion: RallarBlackBoxDistributedGroupAssertion = {
        groupAssertionId: 'token-agreement',
        aggregate: 'allEqual',
        source: { recipeId: 'probe-recipe', commandId: 'probe-read', path: 'body' }
    };
    const { snapshot } = runGroupAssertionDistributedRun([secretAssertion], {
        'agent-1': { body: { accessToken: 'secret-token-a', memberCount: 2 } },
        'agent-2': { body: { accessToken: 'secret-token-b', memberCount: 2 } }
    });

    assertJsonEquals(snapshot.state, 'failed');
    const serialized = JSON.stringify(snapshot.rollup.groupAssertions);
    assert(!serialized.includes('secret-token-a'), 'Expected token values to be redacted.');
    assert(!serialized.includes('secret-token-b'), 'Expected token values to be redacted.');
});

Deno.test('persistence snapshots preserve group evidence through JSON restore without materializing fleet reports', () => {
    const { service } = runGroupAssertionDistributedRun([ALL_EQUAL_ASSERTION], {
        'agent-1': { body: { memberCount: 2 } },
        'agent-2': { body: { memberCount: 2 } }
    });
    service.receiveClientEnvelope(recipeResultEnvelope('agent-1', 'ordinary-result', { body: { memberCount: 99 } }));
    const persisted = service.snapshotForPersistence();
    assertJsonEquals(persisted.fleetReports, []);
    const restored = createRallarBlackBoxControlService(toControlServiceInput());
    const decoded = JSON.parse(JSON.stringify(persisted)) as typeof persisted;
    restored.restoreSnapshot({ ...decoded, distributedRuns: decoded.distributedRuns?.map((run) => ({ ...run, state: 'running' })) });
    const run = restored.snapshotRun('run-1');
    assert(run);
    const evidence = run.results.find((result) => result.commandId.includes('-start-agent-1-'))?.result?.value;
    assert(evidence && typeof evidence === 'object' && 'results' in evidence);
    assert(Array.isArray(evidence.results));
    assertJsonEquals(evidence.results.length, 1);
    const ordinary = run.results.find((result) => result.commandId === 'ordinary-result')?.result?.value;
    assert(ordinary && typeof ordinary === 'object' && 'resultsOmitted' in ordinary);
    assertJsonEquals(ordinary.resultsOmitted, true);
    assert(!('results' in ordinary));
    const evaluated = restored.snapshotDistributedRun('dist-ga-1');
    assertJsonEquals(evaluated?.rollup.summary.passedGroupAssertions, 1);
    assertJsonEquals(restored.snapshotForPersistence().fleetReports, []);
    assertJsonEquals(restored.snapshot().fleetReports?.length, 1);
});

Deno.test('restore keeps group evidence isolated from concatenation-ambiguous run and command identities', () => {
    const { service } = runGroupAssertionDistributedRun([ALL_EQUAL_ASSERTION], {
        'agent-1': { body: { memberCount: 2 } },
        'agent-2': { body: { memberCount: 2 } }
    });
    const original = service.snapshotForPersistence();
    const run = original.runs[0];
    const group = original.distributedRuns?.[0];
    assert(group);
    const result = run.results.find((item) => item.commandId.includes('-start-agent-1-'));
    assert(result);
    const restored = createRallarBlackBoxControlService(toControlServiceInput());
    restored.restoreSnapshot({
        runs: [
            { ...run, runId: 'a', results: [{ ...result, runId: 'a', commandId: 'bc' }] },
            { ...run, runId: 'ab', results: [{ ...result, runId: 'ab', commandId: 'c' }] }
        ],
        distributedRuns: [{ ...group, controlRunId: 'a', commandLinks: [{ phase: 'start', agentId: 'agent-1', commandId: 'bc', queuedAtEpochMs: 2000 }] }],
        fleetReports: []
    });
    const groupValue = restored.snapshotRun('a')?.results[0].result?.value;
    const ordinaryValue = restored.snapshotRun('ab')?.results[0].result?.value;
    assert(groupValue && typeof groupValue === 'object' && 'results' in groupValue);
    assert(Array.isArray(groupValue.results));
    assert(ordinaryValue && typeof ordinaryValue === 'object' && 'resultsOmitted' in ordinaryValue);
    assertJsonEquals(ordinaryValue.resultsOmitted, true);
});

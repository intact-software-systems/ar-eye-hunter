import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';

import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { toCompactedResultEnvelope } from '../src/control-evidence-compaction.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { toControlRecipeReloadCommands, type ControlRecipeReloadRoot } from '../src/recipe-reload/control-recipe-reload-commands.ts';
import {
    assertRight,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';
import { takeAgentDispatchableCommands } from './support/take-agent-dispatchable-commands.ts';

test('distributed starts forward the actual run history choice to existing agents', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ identity: toFleetIdentity('agent-1') }));
    const manifest = {
        ...toDistributedManifest({ targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1'] } }),
        eventHistory: { mode: 'recent', maxEvents: 2 } as const
    };
    assertRight(service.createDistributedRun(manifest));
    assertRight(service.stageDistributedRun(manifest.distributedRunId));
    for (const envelope of takeAgentDispatchableCommands(service, manifest.controlRunId, 'agent-1')) {
        service.receiveClientEnvelope(toCommandResultEnvelope({ runId: envelope.runId, agentId: 'agent-1', command: envelope, ok: true }));
    }
    assertRight(service.startDistributedRun(manifest.distributedRunId));
    const commands = takeAgentDispatchableCommands(service, manifest.controlRunId, 'agent-1');
    const start = commands.find((envelope) => envelope.command.kind === 'recipe.run');
    assert(start);
    assert(start.command.kind === 'recipe.run');
    expect(start.command.eventHistory).toEqual({ mode: 'recent', maxEvents: 2 });
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    await runtime.execute(start.command);
    expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 2 });
});

test('reload segments preserve run override and authored history independently', () => {
    const root: ControlRecipeReloadRoot = {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run',
        agentId: 'agent',
        commandId: 'root',
        command: {
            kind: 'recipe.run',
            eventHistory: { mode: 'full' },
            recipe: {
                schemaVersion: 1,
                recipeId: 'reload',
                eventHistory: { mode: 'recent', maxEvents: 64 },
                continueOnFailure: false,
                metadata: { profile: 'alm-conformance' },
                commands: [{ kind: 'health', commandId: 'before' }, { kind: 'agent.reload', commandId: 'reload', readyTimeoutMs: 100 }, {
                    kind: 'health',
                    commandId: 'after'
                }]
            }
        }
    };
    const segments = toControlRecipeReloadCommands(root).filter((envelope) => envelope.command.kind === 'recipe.run');
    expect(segments.length).toEqual(2);
    for (const segment of segments) {
        assert(segment.command.kind === 'recipe.run');
        expect(segment.command.eventHistory).toEqual({ mode: 'full' });
        expect(segment.command.recipe?.eventHistory).toEqual({ mode: 'recent', maxEvents: 64 });
    }
});

test('controller finite result compaction preserves actual admitted history choice', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute({
        kind: 'recipe.run',
        commandId: 'history-receipt',
        eventHistory: { mode: 'recent', maxEvents: 2 },
        recipe: { schemaVersion: 1, recipeId: 'history-receipt', commands: [{ kind: 'health' }] }
    });
    const stored = toCompactedResultEnvelope({
        kind: 'result',
        protocolVersion: 1,
        runId: 'run',
        agentId: 'agent',
        commandId: result.commandId,
        ok: true,
        result
    });
    assert(stored.result?.value && typeof stored.result.value === 'object' && 'invocation' in stored.result.value);
    const invocation = stored.result.value.invocation;
    assert(invocation && typeof invocation === 'object' && 'eventHistory' in invocation);
    expect(invocation.eventHistory).toEqual({ mode: 'recent', maxEvents: 2 });
});

test('finite stored receipts preserve the actual accepted recipe segment and its original intent', async () => {
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const result = await runtime.execute(
        {
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'original-intent',
                commands: [{ kind: 'health', commandId: 'first' }, { kind: 'health', commandId: 'later' }]
            }
        },
        undefined,
        { recipeExecution: { rootCommandId: 'receipt-owner', first: true, last: true, segment: { start: 0, end: 1, first: true } } }
    );
    expect(result.status).toEqual('ok');
    expect(runtime.state().resultCache.later).toBeUndefined();
    const stored = toCompactedResultEnvelope({
        kind: 'result',
        protocolVersion: 1,
        runId: 'run',
        agentId: 'agent',
        commandId: result.commandId,
        ok: true,
        result
    });
    assert(stored.result?.value && typeof stored.result.value === 'object' && 'invocation' in stored.result.value);
    const invocation = stored.result.value.invocation;
    assert(invocation && typeof invocation === 'object' && 'segment' in invocation);
    expect(invocation.segment).toEqual({ start: 0, end: 1, first: true });
});

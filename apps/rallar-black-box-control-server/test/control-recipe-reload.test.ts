import { assert, assertEquals } from '@std/assert';

import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createAlmConformance2AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertRight,
    toControlServiceInput,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

const RELOAD_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'held-delivery',
    continueOnFailure: false,
    metadata: { profile: 'alm-conformance' },
    commands: [
        { kind: 'messages.send', commandId: 'original-send', carrier: 'ws', typeId: 'held-message', payload: { text: 'once' }, timeoutMs: 100 },
        { kind: 'agent.reload', commandId: 'replace-page', readyTimeoutMs: 100 },
        { kind: 'rtc.connect', commandId: 'restore-session', connection: 'sender', timeoutMs: 100 }
    ]
};

Deno.test('ALM reload dispatches only the prefix before replacing the page', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(
        service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'logical-root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } })
    );

    const dispatched = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(dispatched.length, 1);
    assert(dispatched[0].command.kind === 'recipe.run');
    assertEquals(dispatched[0].command.recipe?.commands, [RELOAD_RECIPE.commands[0]]);
    assert(dispatched[0].commandId !== 'logical-root');
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
});

Deno.test('ALM reload waits for actual successful results and a later resumed connection', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    const prefixResult = toSuccessfulResult(prefix);
    assertEquals(service.receiveClientEnvelope({ ...prefixResult, agentId: 'other-agent' }).accepted, false);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    assertEquals(service.receiveClientEnvelope(prefixResult).accepted, true);
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(reload.command.kind, 'agent.reload');
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: ['replace-page'] }));
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    const [suffix] = service.takeDispatchableCommands('run-1', 'agent-1');
    assert(suffix.command.kind === 'recipe.run');
    assertEquals(suffix.command.recipe?.commands, [RELOAD_RECIPE.commands[2]]);
    service.receiveClientEnvelope(toSuccessfulResult(suffix));
    const root = service.snapshotRun('run-1')?.results.find((result) => result.commandId === 'root');
    assertEquals(root?.ok, true);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
});

Deno.test('ALM reload rejects a failed prefix without dispatching reload', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    const success = toSuccessfulResult(prefix);
    service.receiveClientEnvelope({
        ...success,
        ok: false,
        result: { ...success.result!, ok: false, status: 'failed', error: { code: 'SEND_REJECTED', message: 'denied' } }
    });
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    assertEquals(service.snapshotRun('run-1')?.results.find((result) => result.commandId === 'root')?.ok, false);
});

Deno.test('pending reload evidence survives low runtime and persistence bounds and restore', () => {
    const input = toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: 1, results: 1 } });
    let service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    let snapshot = service.snapshotForPersistence({ commands: 1, results: 1 });
    assert(snapshot.runs[0].commands.some((command) => command.envelope.commandId === 'root'));
    assert(snapshot.runs[0].results.some((result) => result.commandId === prefix.commandId));
    service = createRallarBlackBoxControlService(input);
    service.restoreSnapshot(snapshot);
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [prefix.commandId] }));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(reload.command.kind, 'agent.reload');
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    snapshot = service.snapshotForPersistence({ commands: 1, results: 1 });
    assertEquals(snapshot.runs[0].results.length, 2);
    service = createRallarBlackBoxControlService(input);
    service.restoreSnapshot(snapshot);
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    const [suffix] = service.takeDispatchableCommands('run-1', 'agent-1');
    assert(suffix.command.kind === 'recipe.run');
    assertEquals(suffix.command.recipe?.commands.map((command) => command.kind), ['rtc.connect']);
    service.receiveClientEnvelope(toSuccessfulResult(suffix));
    assertEquals(service.snapshotRun('run-1')?.commands.length, 1);
    assertEquals(service.snapshotRun('run-1')?.results.length, 1);
    assertEquals(service.snapshotRun('run-1')?.results[0].commandId, 'root');
});

Deno.test('a dispatched business segment with missing result is never resent after restore', () => {
    const input = toControlServiceInput({ now: () => 1_000 });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(service.snapshotForPersistence());
    restored.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [prefix.commandId] }));
    assertEquals(restored.takeDispatchableCommands('run-1', 'agent-1'), []);
    assertEquals(
        restored.snapshotRun('run-1')?.results.find((result) => result.commandId === 'root')?.result?.error?.code,
        'RALLAR_BLACK_BOX_RELOAD_RESULT_UNOBSERVABLE'
    );
});

Deno.test('reload readiness and parent deadlines are not renewed by restore or refresh', () => {
    let now = 1_000;
    const input = toControlServiceInput({ now: () => now });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(
        service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE, timeoutMs: 80 } })
    );
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(prefix.deadlineEpochMs, 1_080);
    now = 1_040;
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(reload.deadlineEpochMs, 1_080);
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(service.snapshotForPersistence());
    now = 1_081;
    restored.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    assertEquals(restored.takeDispatchableCommands('run-1', 'agent-1'), []);
    assertEquals(restored.snapshotRun('run-1')?.results.find((result) => result.commandId === 'root')?.result?.error?.code, 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT');
});

Deno.test('ordinary cancellation stops pending reload continuation', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'cancel', command: { kind: 'recipe.cancel', reason: 'stop' } }));
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.command.kind), ['recipe.cancel']);
    assertEquals(service.snapshotRun('run-1')?.results.find((result) => result.commandId === 'root')?.result?.status, 'cancelled');
});

Deno.test('ordinary recipes and ALM recipes without reload retain their original command', () => {
    for (const recipe of [{ ...RELOAD_RECIPE, metadata: {} }, { ...RELOAD_RECIPE, commands: [RELOAD_RECIPE.commands[0]] }]) {
        const service = createRallarBlackBoxControlService(toControlServiceInput());
        service.receiveClientEnvelope(toRegisterEnvelope());
        const queued = assertRight(
            service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'ordinary', command: { kind: 'recipe.run', recipe } })
        );
        assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), [queued]);
    }
});

Deno.test('external command and result collisions cannot impersonate reload work', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    const rootRequest = { runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run' as const, recipe: RELOAD_RECIPE } };
    const queued = assertRight(service.enqueueCommand(rootRequest));
    assertEquals(assertRight(service.enqueueCommand(rootRequest)), queued);
    assertEquals(service.enqueueCommand({ ...rootRequest, agentId: 'agent-2' }).left?.code, 'command-payload-conflict');
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(service.enqueueCommand({ ...rootRequest, commandId: prefix.commandId, command: prefix.command }).left?.code, 'command-payload-conflict');
    assertEquals(service.receiveClientEnvelope(toSuccessfulResult(queued)).accepted, false);
    const malformed = toSuccessfulResult(prefix);
    assertEquals(service.receiveClientEnvelope({ ...malformed, result: { ...malformed.result!, value: { recipeId: 'wrong', results: [] } } }).accepted, false);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    const collided = createRallarBlackBoxControlService(toControlServiceInput());
    assertRight(collided.enqueueCommand({ ...rootRequest, commandId: prefix.commandId, command: prefix.command }));
    assertEquals(collided.enqueueCommand(rootRequest).left?.code, 'command-payload-conflict');
    const forged = createRallarBlackBoxControlService(toControlServiceInput());
    forged.receiveClientEnvelope(toSuccessfulResult(queued));
    assertEquals(forged.enqueueCommand(rootRequest).left?.code, 'command-payload-conflict');
});

Deno.test('rate limits defer derived execution and the allowlist still rejects reload', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now, commandRateLimitMax: 1, commandRateLimitWindowMs: 20 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'agent-1',
            commandId: 'root',
            command: { kind: 'recipe.run', recipe: RELOAD_RECIPE, timeoutMs: 100 }
        })
    );
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    now = 1_021;
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(prefix.deadlineEpochMs, 1_121);
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    now = 1_042;
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(reload.deadlineEpochMs, 1_121);
    const restricted = createRallarBlackBoxControlService(toControlServiceInput({ allowedCommandKinds: ['recipe.run'], now: () => now }));
    restricted.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(restricted.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [allowedPrefix] = restricted.takeDispatchableCommands('run-1', 'agent-1');
    restricted.receiveClientEnvelope(toSuccessfulResult(allowedPrefix));
    assertEquals(restricted.takeDispatchableCommands('run-1', 'agent-1'), []);
});

Deno.test('reload readiness expires from first dispatch even when a valid resume arrives late', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    now = 1_101;
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    assertEquals(
        service.snapshotRun('run-1')?.results.find((result) => result.commandId === 'root')?.result?.error?.code,
        'RALLAR_BLACK_BOX_RELOAD_READY_TIMEOUT'
    );
});

Deno.test('a queued suffix is restored without replaying its preceding business send', () => {
    const input = toControlServiceInput({ now: () => 1_000 });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    service.snapshotRun('run-1');
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(service.snapshotForPersistence());
    restored.receiveClientEnvelope(toRegisterEnvelope());
    const commands = restored.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(commands.length, 1);
    assert(commands[0].command.kind === 'recipe.run');
    assertEquals(commands[0].command.recipe?.commands, [RELOAD_RECIPE.commands[2]]);
});

Deno.test('an ordinary hosted inline reload preserves its logical distributed link', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    const source = createAlmConformance2AgentEntry().manifest;
    const manifest = {
        ...source,
        controlRunId: 'run-1',
        barrier: { enabled: false as const },
        groupAssertions: [{
            groupAssertionId: 'actual-send-evidence',
            aggregate: 'allEqual' as const,
            scope: { role: 'sender' },
            source: { recipeId: source.recipes.find((selection) => selection.role === 'sender')!.recipeId, commandId: 'original-send', path: 'actual' }
        }],
        recipes: source.recipes.map((selection) => ({
            ...selection,
            recipe: selection.recipe && {
                ...selection.recipe,
                metadata: RELOAD_RECIPE.metadata,
                commands: selection.role === 'sender' ? RELOAD_RECIPE.commands : [{ kind: 'health' as const, commandId: 'receiver-health' }]
            }
        }))
    };
    for (const agentId of ['controller-01', 'controller-02']) {
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId, identity: toFleetIdentity(agentId, { groupId: 'hetzner-headless-room' }) }));
    }
    assertRight(service.createDistributedRun(manifest));
    assertRight(service.stageDistributedRun(manifest.distributedRunId));
    for (const agentId of ['controller-01', 'controller-02']) {
        const [stage] = service.takeDispatchableCommands('run-1', agentId);
        service.receiveClientEnvelope(toSuccessfulResult(stage));
    }
    const started = assertRight(service.startDistributedRun(manifest.distributedRunId));
    const logicalSender = started.commandLinks.find((link) => link.phase === 'start' && link.role === 'sender')!;
    const [prefix] = service.takeDispatchableCommands('run-1', logicalSender.agentId);
    assert(prefix.command.kind === 'recipe.run');
    assertEquals(prefix.command.recipe?.commands.at(-1)?.commandId, 'original-send');
    assertEquals(prefix.command.recipe?.commands.some((command) => command.kind === 'agent.reload'), false);
    assert(prefix.commandId !== logicalSender.commandId);
    const prefixResult = toSuccessfulResult(prefix);
    service.receiveClientEnvelope(prefixResult);
    const [reload] = service.takeDispatchableCommands('run-1', logicalSender.agentId);
    assertEquals(reload.command.kind, 'agent.reload');
    const reloadResult = toSuccessfulResult(reload);
    service.receiveClientEnvelope(reloadResult);
    assertEquals(service.snapshotDistributedRun(manifest.distributedRunId)?.state, 'running');
    service.markAgentDisconnected('run-1', logicalSender.agentId);
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: logicalSender.agentId, completedCommandIds: [reload.commandId] }));
    const [suffix] = service.takeDispatchableCommands('run-1', logicalSender.agentId);
    const suffixResult = toSuccessfulResult(suffix);
    service.receiveClientEnvelope(suffixResult);
    const logicalResult = service.snapshotRun('run-1')?.results.find((result) => result.commandId === logicalSender.commandId);
    assertEquals(logicalResult?.ok, true);
    const aggregate = logicalResult?.result?.value;
    const prefixValue = prefixResult.result?.value;
    const suffixValue = suffixResult.result?.value;
    assert(isJsonRecordValue(aggregate) && Array.isArray(aggregate.results));
    assert(isJsonRecordValue(prefixValue) && Array.isArray(prefixValue.results));
    assert(isJsonRecordValue(suffixValue) && Array.isArray(suffixValue.results));
    assertEquals(aggregate.results.slice(-3), [
        prefixValue.results.at(-1),
        { ...reloadResult.result, commandId: 'replace-page' },
        suffixValue.results[0]
    ]);
    assertEquals(service.snapshotRun('run-1')?.results.find((result) => result.commandId === reload.commandId), reloadResult);
    assertEquals(
        service.snapshotDistributedRun(manifest.distributedRunId)?.commandLinks.filter((link) => link.phase === 'start' && link.role === 'sender').length,
        1
    );
});

Deno.test('reload preserves an earlier child deadline instead of expanding it to the parent budget', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now }));
    const recipe = {
        ...RELOAD_RECIPE,
        commands: RELOAD_RECIPE.commands.map((command) => command.kind === 'agent.reload' ? { ...command, deadlineEpochMs: 1_040 } : command)
    };
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe, timeoutMs: 100 } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(reload.deadlineEpochMs, 1_040);
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    now = 1_041;
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
});

Deno.test('malformed result timing cannot become accepted reload evidence', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    const result = toSuccessfulResult(prefix);
    assertEquals(service.receiveClientEnvelope({ ...result, result: { ...result.result!, durationMs: NaN } }).accepted, false);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
});

Deno.test('restored unearned or altered suffix commands cannot bypass the reload fence', () => {
    const input = toControlServiceInput({ now: () => 1_000 });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    const beforeSuffix = service.snapshotRun('run-1')!;
    const suffix = beforeSuffix.commands.at(-1)!;
    const snapshot = service.snapshotForPersistence();
    const altered = {
        ...snapshot,
        runs: snapshot.runs.map((run) => ({
            ...run,
            commands: run.commands.map((command) =>
                command.envelope.commandId === suffix.envelope.commandId
                    ? { ...command, envelope: { ...command.envelope, command: { kind: 'health' as const } } }
                    : command
            )
        }))
    };
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(altered);
    restored.receiveClientEnvelope(toRegisterEnvelope());
    assertEquals(restored.takeDispatchableCommands('run-1', 'agent-1'), []);
});

Deno.test('restored missing dispatched prefix metadata cannot cause a repeated business send', () => {
    const input = toControlServiceInput({ now: () => 1_000 });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    service.receiveClientEnvelope(toSuccessfulResult(prefix));
    const snapshot = service.snapshotForPersistence();
    const missingPrefix = {
        ...snapshot,
        runs: snapshot.runs.map((run) => ({ ...run, commands: run.commands.filter((command) => command.envelope.commandId !== prefix.commandId) }))
    };
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(missingPrefix);
    restored.receiveClientEnvelope(toRegisterEnvelope());
    assertEquals(restored.takeDispatchableCommands('run-1', 'agent-1'), []);
    assertEquals(restored.snapshotRun('run-1')?.results.find((result) => result.commandId === 'root')?.ok, false);
});

Deno.test('terminal reload completes the logical root at the later resume time', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'root',
        command: {
            kind: 'recipe.run',
            recipe: { ...RELOAD_RECIPE, commands: [RELOAD_RECIPE.commands[1]] }
        }
    }));
    const [reload] = service.takeDispatchableCommands('run-1', 'agent-1');
    now = 1_010;
    service.receiveClientEnvelope(toSuccessfulResult(reload));
    now = 1_050;
    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [reload.commandId] }));
    const results = service.snapshotRun('run-1')!.results;
    const root = results.find((result) => result.commandId === 'root')!.result!;
    assertEquals(root.startedAtEpochMs, 1_000);
    assertEquals(root.endedAtEpochMs, 1_050);
    assertEquals(root.durationMs, 50);
    assertEquals(results.find((result) => result.commandId === reload.commandId)!.result!.endedAtEpochMs, 1_010);
});

Deno.test('a segment result must identify its actual recipe as well as its ordered children', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    const [prefix] = service.takeDispatchableCommands('run-1', 'agent-1');
    const actual = toSuccessfulResult(prefix);
    assert(actual.result?.value && typeof actual.result.value === 'object' && !Array.isArray(actual.result.value));
    assertEquals(
        service.receiveClientEnvelope({
            ...actual,
            result: {
                ...actual.result!,
                value: {
                    ...actual.result.value,
                    recipeId: 'different-recipe'
                }
            }
        }).accepted,
        false
    );
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    assertEquals(service.receiveClientEnvelope(actual).accepted, true);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1')[0].command.kind, 'agent.reload');
});

Deno.test('derived child identities support distinct root IDs containing lone UTF-16 surrogates', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    for (const commandId of ['root-\uD800', 'root-\uD801']) {
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId, command: { kind: 'recipe.run', recipe: RELOAD_RECIPE } }));
    }
    const dispatched = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(dispatched.length, 2);
    assertEquals(new Set(dispatched.map((command) => command.commandId)).size, 2);
    for (const command of dispatched) {
        assertEquals(service.receiveClientEnvelope(toSuccessfulResult(command)).accepted, true);
    }
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.command.kind), ['agent.reload', 'agent.reload']);
});

Deno.test('unsupported opt-in continuation and nested reload shapes fail before dispatch', () => {
    const recipes: readonly RallarBlackBoxTestRecipe[] = [
        { ...RELOAD_RECIPE, continueOnFailure: true },
        { ...RELOAD_RECIPE, commands: [{ kind: 'recipe.run', commandId: 'nested', recipe: RELOAD_RECIPE }] }
    ];
    for (const recipe of recipes) {
        const service = createRallarBlackBoxControlService(toControlServiceInput());
        service.receiveClientEnvelope(toRegisterEnvelope());
        assertEquals(
            service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'root', command: { kind: 'recipe.run', recipe } }).left?.code,
            'command-payload-conflict'
        );
        assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
    }
});

function toSuccessfulResult(command: ControlCommandEnvelope): ControlResultEnvelope {
    const value = command.command.kind === 'recipe.run'
        ? {
            recipeId: command.command.recipe!.recipeId,
            results: command.command.recipe!.commands.map((child, index) => ({
                commandId: child.commandId!,
                kind: child.kind,
                status: 'ok',
                ok: true,
                startedAtEpochMs: 1_000 + index,
                endedAtEpochMs: 1_001 + index,
                durationMs: 1,
                value: { actual: child.commandId }
            }))
        }
        : { reloading: true, readyTimeoutMs: 100 };
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: command.runId,
        agentId: command.agentId!,
        commandId: command.commandId,
        ok: true,
        result: {
            commandId: command.commandId,
            kind: command.command.kind,
            status: 'ok',
            ok: true,
            startedAtEpochMs: 1_000,
            endedAtEpochMs: 1_010,
            durationMs: 10,
            value
        }
    };
}

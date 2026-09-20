import { assert, assertEquals } from '@std/assert';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { isRallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/composite-results.ts';
import { bindAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    createRallarBlackBoxControlService,
    type EnqueueControlCommandInput,
    type RallarBlackBoxControlService
} from '../src/control-service.ts';
import {
    assertRight,
    toControlServiceInput,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

const PAIR = {
    runId: 'run-1',
    sender: { agentId: 'sender', commandId: 'sender-root' },
    receiver: { agentId: 'receiver', commandId: 'receiver-root' },
    checkpoints: [{
        key: 'ws-reload',
        senderPrefixEnd: 'sender-prefix',
        senderReload: 'replace-page',
        senderSuffixEnd: 'sender-recovered',
        receiverReadyEnd: 'receiver-ready',
        receiverAbsenceEnd: 'receiver-absence',
        receiverRecoveryEnd: 'receiver-recovered'
    }]
};

// The first gate reproduction uses real recipe results without claiming native delivery or storage proof.
const SENDER: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'reload-sender',
    continueOnFailure: false,
    metadata: { profile: 'alm-conformance', almReloadCheckpoints: PAIR.checkpoints },
    commands: [
        { kind: 'stats', commandId: 'sender-prefix' },
        { kind: 'agent.reload', commandId: 'replace-page', readyTimeoutMs: 100 },
        { kind: 'stats', commandId: 'sender-recovered' }
    ]
};

const RECEIVER: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'reload-receiver',
    continueOnFailure: false,
    metadata: { profile: 'alm-conformance', almReloadCheckpoints: PAIR.checkpoints },
    commands: [
        { kind: 'stats', commandId: 'receiver-ready' },
        { kind: 'wait', commandId: 'receiver-absence', absent: true, match: { topic: 'original' }, timeoutMs: 100 },
        { kind: 'stats', commandId: 'receiver-recovered' }
    ]
};

Deno.test('paired reload cannot dispatch before its exact receiver absence result', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const receiverRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const senderRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const [ready] = service.takeDispatchableCommands('run-1', 'receiver');
    await runSegment(service, receiverRuntime, ready);
    assertEquals(service.takeDispatchableCommands('run-1', 'receiver'), []);
    const [prefix] = service.takeDispatchableCommands('run-1', 'sender');
    await runSegment(service, senderRuntime, prefix);
    const [absence] = service.takeDispatchableCommands('run-1', 'receiver');
    assert(absence.command.kind === 'recipe.run');
    assertEquals(absence.command.recipe?.commands.map((command) => command.commandId), ['receiver-absence']);
    const absenceStarted = Promise.withResolvers<void>();
    const unsubscribe = receiverRuntime.subscribe((state) => {
        if (state.activeCommand?.commandId === 'receiver-absence') {
            absenceStarted.resolve();
        }
    });
    const receiverResult = runSegment(service, receiverRuntime, absence);
    await absenceStarted.promise;
    try {
        assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
        await receiverResult;
        const [reload] = service.takeDispatchableCommands('run-1', 'sender');
        assertEquals(reload.command.kind, 'agent.reload');
        assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
    }
    finally {
        await receiverResult;
        unsubscribe();
    }
});

Deno.test('paired reload waits for both exact logical roots before dispatching either prefix', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));

    assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
});

function toPairedRoot(role: 'sender' | 'receiver', recipe: RallarBlackBoxTestRecipe): EnqueueControlCommandInput {
    const pair = assertRight(bindAlmReloadPair({
        sender: toRootEnvelope('sender', role === 'sender' ? recipe : SENDER),
        receiver: toRootEnvelope('receiver', role === 'receiver' ? recipe : RECEIVER)
    }));
    return { ...pair[role], agentId: PAIR[role].agentId };
}

function toRootEnvelope(role: 'sender' | 'receiver', recipe: RallarBlackBoxTestRecipe): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: PAIR.runId,
        agentId: PAIR[role].agentId,
        commandId: PAIR[role].commandId,
        command: { kind: 'recipe.run', recipe, timeoutMs: 1_000 }
    };
}

async function runSegment(service: RallarBlackBoxControlService, runtime: RallarBlackBoxTestRuntime, command: ControlCommandEnvelope): Promise<void> {
    const result = await runtime.execute({ ...command.command, deadlineEpochMs: command.deadlineEpochMs });
    assertEquals(result.ok, true);
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: command.runId,
            agentId: command.agentId!,
            commandId: command.commandId,
            ok: result.ok,
            result
        }).accepted,
        true
    );
}

Deno.test('missing paired peer consumes the original queued deadline across restore', () => {
    let now = 1_000;
    const input = toControlServiceInput({ now: () => now });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    now = 1_500;
    assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(service.snapshotForPersistence());
    restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    now = 2_001;
    assertEquals(restored.takeDispatchableCommands('run-1', 'sender'), []);
    const root = restored.snapshotRun('run-1')?.results.find((result) => result.commandId === 'sender-root');
    assertEquals(root?.result?.error?.code, 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT');
});

Deno.test('malformed pair metadata cannot fall back to ordinary recipe dispatch', () => {
    for (const almReloadPair of [null, {}, { ...PAIR, receiver: PAIR.sender }]) {
        const service = createRallarBlackBoxControlService(toControlServiceInput());
        const root = toPairedRoot('receiver', RECEIVER);
        const outcome = service.enqueueCommand({ ...root, command: { ...root.command, metadata: { almReloadPair } } });
        assertEquals(outcome.left?.code, 'command-payload-conflict');
        assertEquals(service.takeDispatchableCommands('run-1', 'receiver'), []);
    }
});

Deno.test('receiver reconnect cannot reuse a ready result to authorize reload', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const [ready] = service.takeDispatchableCommands('run-1', 'receiver');
    await runSegment(service, createRallarBlackBoxTestRuntime({ now: () => 1_000 }), ready);
    service.markAgentDisconnected('run-1', 'receiver');
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
    assertEquals(service.takeDispatchableCommands('run-1', 'receiver'), []);
    const roots = service.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId));
    assertEquals(roots?.map((result) => result.ok), [false, false]);
});

for (const bounds of [1, 1_000]) {
    Deno.test(`paired cancellation reaches actual receiver invocation with retention bound ${bounds}`, async () => {
        const service = createRallarBlackBoxControlService(
            toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: bounds, results: bounds } })
        );
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
        assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
        const runtime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
        await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
        const senderRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
        await runSegment(service, senderRuntime, service.takeDispatchableCommands('run-1', 'sender')[0]);
        const [absence] = service.takeDispatchableCommands('run-1', 'receiver');
        const entered = Promise.withResolvers<void>();
        const unsubscribe = runtime.subscribe((state) => {
            if (state.activeCommand?.commandId === 'receiver-absence') {
                entered.resolve();
            }
        });
        const pending = runtime.execute(absence.command);
        await entered.promise;
        try {
            assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'sender', commandId: 'stop-pair', command: { kind: 'recipe.cancel' } }));
            const [cleanup] = service.takeDispatchableCommands('run-1', 'receiver');
            assert(cleanup.command.kind === 'recipe.cancel');
            assertEquals(cleanup.command.targetCommandId, absence.commandId);
            const cancellation = await runtime.execute(cleanup.command);
            assertEquals(cancellation.value, { cancelRequested: true, reason: 'Paired reload stopped.', targetCommandId: absence.commandId });
            assertEquals((await pending).status, 'cancelled');
            assertEquals(
                service.receiveClientEnvelope({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'receiver',
                    commandId: cleanup.commandId,
                    ok: cancellation.ok,
                    result: cancellation
                }).accepted,
                true
            );
            assertEquals(service.takeDispatchableCommands('run-1', 'receiver'), []);
            const senderCleanup = service.takeDispatchableCommands('run-1', 'sender');
            assertEquals(senderCleanup.map((command) => command.command.kind), ['recipe.cancel', 'close']);
            for (const command of senderCleanup) {
                await runSegment(service, senderRuntime, command);
            }
            const roots = service.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId));
            if (bounds > 1) {
                assertEquals(roots?.map((result) => result.result?.status), ['cancelled', 'cancelled']);
            }
            else {
                assertEquals(service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.length, 1);
            }
        }
        finally {
            await runtime.execute({ kind: 'recipe.cancel' });
            await pending;
            unsubscribe();
        }
    });
}

Deno.test('completed receiver proof remains full under retention pressure while sender reload is pending', async () => {
    const input = toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: 1, results: 1 } });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const [ready] = service.takeDispatchableCommands('run-1', 'receiver');
    await runSegment(service, runtime, ready);
    await runSegment(service, createRallarBlackBoxTestRuntime({ now: () => 1_000 }), service.takeDispatchableCommands('run-1', 'sender')[0]);
    const [absence] = service.takeDispatchableCommands('run-1', 'receiver');
    await runSegment(service, runtime, absence);
    const [recovery] = service.takeDispatchableCommands('run-1', 'receiver');
    await runSegment(service, runtime, recovery);
    const snapshot = service.snapshotForPersistence({ commands: 1, results: 1 });
    assertEquals(snapshot.runs[0].results.find((result) => result.commandId === 'receiver-root')?.ok, true);
    const retained = snapshot.runs[0].results.filter((result) => [ready.commandId, absence.commandId, recovery.commandId].includes(result.commandId));
    assertEquals(retained.length, 3);
    for (const result of retained) {
        assert(typeof result.result?.value === 'object' && result.result.value !== null && 'results' in result.result.value);
    }
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(snapshot);
    restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    const [reload] = restored.takeDispatchableCommands('run-1', 'sender');
    assertEquals(reload.command.kind, 'agent.reload');
    const restoredProof = restored.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.find((result) => result.commandId === absence.commandId);
    assertEquals(restoredProof?.result?.value, retained.find((result) => result.commandId === absence.commandId)?.result?.value);
});

for (const phase of ['ready', 'absence-pending', 'absence-completed'] as const) {
    Deno.test(`restored ${phase} proof cannot authorize a different receiver generation`, async () => {
        const input = toControlServiceInput({ now: () => 1_000 });
        const service = createRallarBlackBoxControlService(input);
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
        assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
        const runtime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
        await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
        if (phase !== 'ready') {
            await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'sender')[0]);
            const [absence] = service.takeDispatchableCommands('run-1', 'receiver');
            if (phase === 'absence-completed') {
                await runSegment(service, runtime, absence);
            }
        }
        const restored = createRallarBlackBoxControlService(input);
        restored.restoreSnapshot(service.snapshotForPersistence());
        restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertEquals(restored.takeDispatchableCommands('run-1', 'sender'), []);
        assertEquals(restored.takeDispatchableCommands('run-1', 'receiver'), []);
        const roots = restored.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId));
        assertEquals(roots?.length, 2);
        assert(roots?.every((root) => root.ok === false));
    });
}

Deno.test('queued cleanup is refused after receiver generation changes and never replays', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
    await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'sender')[0]);
    const [absence] = service.takeDispatchableCommands('run-1', 'receiver');
    assert(absence.command.kind === 'recipe.run');
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'sender', commandId: 'stop', command: { kind: 'recipe.cancel' } }));
    service.markAgentDisconnected('run-1', 'receiver');
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertEquals(service.takeDispatchableCommands('run-1', 'receiver'), []);
    const refused = service.snapshotRun('run-1')?.results.find((result) => result.result?.error?.code === 'RALLAR_BLACK_BOX_RELOAD_CLEANUP_TARGET_UNAVAILABLE');
    assertEquals(refused?.result?.value, { cancelRequested: false, targetCommandId: absence.commandId });
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertEquals(service.takeDispatchableCommands('run-1', 'receiver'), []);
});

Deno.test('only the exact complete receiver absence result unlocks sender reload', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
    await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'sender')[0]);
    const [absence] = service.takeDispatchableCommands('run-1', 'receiver');
    const result = await runtime.execute(absence.command);
    assertEquals(result.ok, true);
    const actual = {
        kind: 'result' as const,
        protocolVersion: 1 as const,
        runId: 'run-1',
        agentId: 'receiver',
        commandId: absence.commandId,
        ok: result.ok,
        result
    };
    for (
        const invalid of [
            { ...actual, agentId: 'sender' },
            { ...actual, result: { ...result, commandId: 'different-child' } },
            { ...actual, result: { ...result, value: { recipeId: 'reload-receiver', results: [] } } }
        ]
    ) {
        assertEquals(service.receiveClientEnvelope(invalid).accepted, false);
        assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
    }
    assertEquals(service.receiveClientEnvelope(actual).accepted, true);
    assertEquals(service.takeDispatchableCommands('run-1', 'sender').map((command) => command.command.kind), ['agent.reload']);
});

for (const restrictedBy of ['allowlist', 'rate'] as const) {
    Deno.test(`actual receiver failure reports cleanup ${restrictedBy} denial without claiming sender cancellation`, async () => {
        const service = createRallarBlackBoxControlService(
            toControlServiceInput({
                now: () => 1_000,
                allowedCommandKinds: restrictedBy === 'allowlist' ? ['recipe.run'] : undefined,
                commandRateLimitMax: restrictedBy === 'rate' ? 2 : 120
            })
        );
        const sender = {
            ...SENDER,
            commands: SENDER.commands.map((command) =>
                command.commandId === 'sender-prefix'
                    ? { kind: 'wait' as const, commandId: 'sender-prefix', match: { topic: 'never' }, timeoutMs: 1_000 }
                    : command
            )
        };
        const receiver = {
            ...RECEIVER,
            commands: RECEIVER.commands.map((command) =>
                command.commandId === 'receiver-ready'
                    ? { kind: 'wait' as const, commandId: 'receiver-ready', absent: true as const, match: { topic: 'unexpected' }, timeoutMs: 100 }
                    : command
            )
        };
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertRight(service.enqueueCommand(toPairedRoot('sender', sender)));
        assertRight(service.enqueueCommand(toPairedRoot('receiver', receiver)));
        const senderRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
        const receiverRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
        const [prefix] = service.takeDispatchableCommands('run-1', 'sender');
        const entered = Promise.withResolvers<void>();
        const unsubscribe = senderRuntime.subscribe((state) => {
            if (state.activeCommand?.commandId === 'sender-prefix') {
                entered.resolve();
            }
        });
        const running = senderRuntime.execute(prefix.command);
        await entered.promise;
        try {
            receiverRuntime.recordEvent({ kind: 'event', topic: 'unexpected' });
            const [ready] = service.takeDispatchableCommands('run-1', 'receiver');
            const failure = await receiverRuntime.execute(ready.command);
            assertEquals(failure.ok, false);
            assertEquals(
                service.receiveClientEnvelope({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'receiver',
                    commandId: ready.commandId,
                    ok: false,
                    result: failure
                }).accepted,
                true
            );
            assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
            const root = service.snapshotRun('run-1')?.results.find((result) => result.commandId === 'sender-root');
            assertEquals(root?.result?.error?.details, {
                cleanupFailure: restrictedBy === 'allowlist'
                    ? { code: 'command-kind-not-allowed', message: 'Command kind is not allowed: recipe.cancel.' }
                    : { code: 'command-rate-limited', message: 'Command rate limit exceeded.' }
            });
            assertEquals(senderRuntime.state().status, 'running');
        }
        finally {
            await senderRuntime.execute({ kind: 'recipe.cancel' });
            assertEquals((await running).status, 'cancelled');
            unsubscribe();
        }
    });
}

Deno.test('failed actual receiver absence closes the successful sender prefix instead of targeting idle cancellation', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const senderRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const receiverRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, receiverRuntime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
    const [prefix] = service.takeDispatchableCommands('run-1', 'sender');
    await runSegment(service, senderRuntime, prefix);
    const [absence] = service.takeDispatchableCommands('run-1', 'receiver');
    receiverRuntime.recordEvent({ kind: 'event', topic: 'original' });
    const failure = await receiverRuntime.execute(absence.command);
    assertEquals(failure.ok, false);
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'receiver',
            commandId: absence.commandId,
            ok: false,
            result: failure
        }).accepted,
        true
    );
    const [cleanup] = service.takeDispatchableCommands('run-1', 'sender');
    assert(cleanup.command.kind === 'close');
    assertEquals(cleanup.command.targetCommandId, prefix.commandId);
    const closed = await senderRuntime.execute(cleanup.command);
    assertEquals(closed.value, { closed: true });
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'sender',
            commandId: cleanup.commandId,
            ok: closed.ok,
            result: closed
        }).accepted,
        true
    );
    assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
});

Deno.test('actual finish between cancel queue and execution permits exactly one guarded close successor', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: 1, results: 1 } }));
    const sender = {
        ...SENDER,
        commands: SENDER.commands.map((command) =>
            command.commandId === 'sender-prefix'
                ? { kind: 'wait' as const, commandId: 'sender-prefix', match: { topic: 'finish-prefix' }, timeoutMs: 1_000 }
                : command
        )
    };
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', sender)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const [prefix] = service.takeDispatchableCommands('run-1', 'sender');
    const entered = Promise.withResolvers<void>();
    const unsubscribe = runtime.subscribe((state) => {
        if (state.activeCommand?.commandId === 'sender-prefix') {
            entered.resolve();
        }
    });
    const running = runtime.execute(prefix.command);
    await entered.promise;
    try {
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'receiver', commandId: 'stop', command: { kind: 'recipe.cancel' } }));
        const [cancellation] = service.takeDispatchableCommands('run-1', 'sender');
        assert(cancellation.command.kind === 'recipe.cancel');
        runtime.recordEvent({ kind: 'event', topic: 'finish-prefix' });
        const finished = await running;
        assertEquals(finished.ok, true);
        assertEquals(
            service.receiveClientEnvelope({
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'sender',
                commandId: prefix.commandId,
                ok: true,
                result: finished
            }).accepted,
            false
        );
        const refused = await runtime.execute(cancellation.command);
        assertEquals(refused.value, { cancelRequested: false, targetCommandId: prefix.commandId, reason: 'target-not-exclusively-active' });
        const refusal = {
            kind: 'result' as const,
            protocolVersion: 1 as const,
            runId: 'run-1',
            agentId: 'sender',
            commandId: cancellation.commandId,
            ok: refused.ok,
            result: refused
        };
        assertEquals(service.receiveClientEnvelope(refusal).accepted, true);
        const pending = service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
        assert(pending.commands.some((command) => command.envelope.commandId === prefix.commandId));
        assert(pending.results.some((result) => result.commandId === cancellation.commandId));
        const [close] = service.takeDispatchableCommands('run-1', 'sender');
        assert(close.command.kind === 'close');
        assertEquals(close.command.targetCommandId, prefix.commandId);
        assertEquals(close.deadlineEpochMs, cancellation.deadlineEpochMs);
        assertEquals(service.receiveClientEnvelope(refusal).accepted, false);
        const closed = await runtime.execute(close.command);
        assertEquals(closed.value, { closed: true });
        assertEquals(
            service.receiveClientEnvelope({
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'sender',
                commandId: close.commandId,
                ok: closed.ok,
                result: closed
            }).accepted,
            true
        );
        assertEquals(service.takeDispatchableCommands('run-1', 'sender'), []);
        assertEquals(service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.length, 1);
    }
    finally {
        await runtime.execute({ kind: 'recipe.cancel' });
        await running;
        unsubscribe();
    }
});

Deno.test('authored checkpoints cannot silently become an ordinary unpaired recipe', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    for (const role of ['sender', 'receiver'] as const) {
        const root = toRootEnvelope(role, role === 'sender' ? SENDER : RECEIVER);
        const outcome = service.enqueueCommand({ ...root, agentId: PAIR[role].agentId });
        assertEquals(outcome.left?.code, 'command-payload-conflict');
        assertEquals(service.takeDispatchableCommands('run-1', PAIR[role].agentId), []);
    }
});

Deno.test('completed sender proof remains full until actual receiver recovery completes', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: 1, results: 1 } }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const senderRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const receiverRuntime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, receiverRuntime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
    const [prefix] = service.takeDispatchableCommands('run-1', 'sender');
    await runSegment(service, senderRuntime, prefix);
    await runSegment(service, receiverRuntime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
    const [reload] = service.takeDispatchableCommands('run-1', 'sender');
    assert(reload.command.kind === 'agent.reload');
    // This acknowledgement is a control-client protocol input, not evidence of native document replacement.
    const acknowledgement = toAgentReloadResult({
        commandId: reload.commandId,
        readyTimeoutMs: reload.command.readyTimeoutMs,
        written: 'written',
        atEpochMs: 1_000
    });
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'sender',
            commandId: reload.commandId,
            ok: true,
            result: { ...acknowledgement, commandId: 'replace-page' }
        }).accepted,
        false
    );
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'sender',
            commandId: reload.commandId,
            ok: true,
            result: acknowledgement
        }).accepted,
        true
    );
    service.markAgentDisconnected('run-1', 'sender');
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender', completedCommandIds: [reload.commandId] }));
    const [suffix] = service.takeDispatchableCommands('run-1', 'sender');
    await runSegment(service, senderRuntime, suffix);
    const snapshot = service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
    assertEquals(snapshot.results.find((result) => result.commandId === 'sender-root')?.ok, true);
    const value = snapshot.results.find((result) => result.commandId === 'sender-root')?.result?.value;
    assert(isJsonRecordValue(value) && Array.isArray(value.results));
    const projectedReload = value.results.filter(isRallarBlackBoxTestResult).find((result) => result.kind === 'agent.reload');
    assertEquals(projectedReload, { ...acknowledgement, commandId: 'replace-page' });
    assertEquals(snapshot.results.find((result) => result.commandId === reload.commandId)?.result, acknowledgement);
    for (const id of [prefix.commandId, suffix.commandId]) {
        const result = snapshot.results.find((result) => result.commandId === id);
        assert(typeof result?.result?.value === 'object' && result.result.value !== null && 'results' in result.result.value);
    }
    await runSegment(service, receiverRuntime, service.takeDispatchableCommands('run-1', 'receiver')[0]);
    const terminal = service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
    assertEquals(terminal.results.length, 1);
    assertEquals(terminal.commands.length, 1);
});

Deno.test('a stale targeted external cancellation cannot terminalize the current paired roots', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, runtime, service.takeDispatchableCommands('run-1', 'sender')[0]);
    assertRight(
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'sender',
            commandId: 'stale-cancel',
            command: { kind: 'recipe.cancel', targetCommandId: 'old-unrelated-root' }
        })
    );
    const [cancel] = service.takeDispatchableCommands('run-1', 'sender');
    const refusal = await runtime.execute(cancel.command);
    assertEquals(refusal.value, { cancelRequested: false, targetCommandId: 'old-unrelated-root', reason: 'target-not-exclusively-active' });
    service.receiveClientEnvelope({
        kind: 'result',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'sender',
        commandId: cancel.commandId,
        ok: refusal.ok,
        result: refusal
    });
    assertEquals(service.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId)), []);
    const [ready] = service.takeDispatchableCommands('run-1', 'receiver');
    await runSegment(service, createRallarBlackBoxTestRuntime({ now: () => 1_000 }), ready);
    assertEquals(service.takeDispatchableCommands('run-1', 'receiver')[0]?.command.kind, 'recipe.run');
});

for (const restore of [false, true]) {
    Deno.test(`lost dispatched cleanup is bounded without replay (restore=${restore})`, async () => {
        let now = 1_000;
        const input = toControlServiceInput({ now: () => now, runtimeRetentionBounds: { commands: 1, results: 1 } });
        const service = createRallarBlackBoxControlService(input);
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
        assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
        const [prefix] = service.takeDispatchableCommands('run-1', 'sender');
        await runSegment(service, createRallarBlackBoxTestRuntime({ now: () => now }), prefix);
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'receiver', commandId: 'stop', command: { kind: 'recipe.cancel' } }));
        const [cleanup] = service.takeDispatchableCommands('run-1', 'sender');
        assert(cleanup.command.kind === 'close');
        const current = restore ? createRallarBlackBoxControlService(input) : service;
        if (restore) {
            current.restoreSnapshot(service.snapshotForPersistence({ commands: 1, results: 1 }));
            current.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        }
        assertEquals(current.takeDispatchableCommands('run-1', 'sender'), []);
        now = 2_001;
        assertEquals(current.takeDispatchableCommands('run-1', 'sender'), []);
        const snapshot = current.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
        const failure = snapshot.results.find((result) => result.commandId === cleanup.commandId);
        assertEquals(failure?.ok, false);
        assertEquals(failure?.result?.value, { targetCommandId: prefix.commandId });
        assertEquals(snapshot.commands.some((command) => command.envelope.commandId === prefix.commandId), false);
    });
}

import { expect, test } from 'bun:test';
import { assert } from './support/assert.ts';

import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
import { isRallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/composite-results.ts';
import { bindAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
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
import { executeControlRuntimeCommand } from './support/execute-control-runtime-command.ts';
import { takeAgentDispatchableCommands } from './support/take-agent-dispatchable-commands.ts';

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

test('paired reload cannot dispatch before its exact receiver absence result', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const receiverRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const senderRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const [ready] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    await runSegment(service, receiverRuntime, ready);
    expect(takeAgentDispatchableCommands(service, 'run-1', 'receiver')).toEqual([]);
    const [prefix] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    await runSegment(service, senderRuntime, prefix);
    const [absence] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    assert(absence.command.kind === 'recipe.run');
    expect(absence.command.recipe).toEqual(RECEIVER);
    expect(absence.recipeExecution?.segment).toEqual({ start: 1, end: 2, first: false });
    const absenceStarted = Promise.withResolvers<void>();
    const unsubscribe = receiverRuntime.subscribe((state) => {
        if (state.activeCommand?.commandId === 'receiver-absence') {
            absenceStarted.resolve();
        }
    });
    const receiverResult = runSegment(service, receiverRuntime, absence);
    await absenceStarted.promise;
    try {
        expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
        await receiverResult;
        const [reload] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
        expect(reload.command.kind).toEqual('agent.reload');
        expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
    }
    finally {
        await receiverResult;
        unsubscribe();
    }
});

test('paired reload waits for both exact logical roots before dispatching either prefix', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));

    expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
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
    const result = await executeControlRuntimeCommand(runtime, command);
    expect(result.ok).toEqual(true);
    expect(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: command.runId,
            agentId: command.agentId!,
            commandId: command.commandId,
            ok: result.ok,
            result
        }).accepted
    ).toEqual(true);
}

test('missing paired peer consumes the original queued deadline across restore', () => {
    let now = 1_000;
    const input = toControlServiceInput({ now: () => now });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    now = 1_500;
    expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(service.snapshotForPersistence());
    restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    now = 2_001;
    expect(takeAgentDispatchableCommands(restored, 'run-1', 'sender')).toEqual([]);
    const root = restored.snapshotRun('run-1')?.results.find((result) => result.commandId === 'sender-root');
    expect(root?.result?.error?.code).toEqual('RALLAR_BLACK_BOX_RECIPE_TIMEOUT');
});

test('malformed pair metadata cannot fall back to ordinary recipe dispatch', () => {
    for (const almReloadPair of [null, {}, { ...PAIR, receiver: PAIR.sender }]) {
        const service = createRallarBlackBoxControlService(toControlServiceInput());
        const root = toPairedRoot('receiver', RECEIVER);
        const outcome = service.enqueueCommand({ ...root, command: { ...root.command, metadata: { almReloadPair } } });
        expect(outcome.left?.code).toEqual('command-payload-conflict');
        expect(takeAgentDispatchableCommands(service, 'run-1', 'receiver')).toEqual([]);
    }
});

test('receiver reconnect cannot reuse a ready result to authorize reload', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const [ready] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    await runSegment(service, createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 }), ready);
    service.markAgentDisconnected('run-1', 'receiver');
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
    expect(takeAgentDispatchableCommands(service, 'run-1', 'receiver')).toEqual([]);
    const roots = service.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId));
    expect(roots?.map((result) => result.ok)).toEqual([false, false]);
});

for (const bounds of [1, 1_000]) {
    test(`paired cancellation reaches actual receiver invocation with retention bound ${bounds}`, async () => {
        const service = createRallarBlackBoxControlService(
            toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: bounds, results: bounds } })
        );
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
        assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
        const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
        await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
        const senderRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
        await runSegment(service, senderRuntime, takeAgentDispatchableCommands(service, 'run-1', 'sender')[0]);
        const [absence] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
        const entered = Promise.withResolvers<void>();
        const unsubscribe = runtime.subscribe((state) => {
            if (state.activeCommand?.commandId === 'receiver-absence') {
                entered.resolve();
            }
        });
        const pending = executeControlRuntimeCommand(runtime, absence);
        await entered.promise;
        try {
            assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'sender', commandId: 'stop-pair', command: { kind: 'recipe.cancel' } }));
            const [cleanup] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
            assert(cleanup.command.kind === 'recipe.cancel');
            expect(cleanup.command.targetCommandId).toEqual(absence.commandId);
            const cancellation = await executeControlRuntimeCommand(runtime, cleanup);
            expect(cancellation.value).toEqual({ cancelRequested: true, reason: 'Paired reload stopped.', targetCommandId: absence.commandId });
            expect((await pending).status).toEqual('cancelled');
            expect(
                service.receiveClientEnvelope({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'receiver',
                    commandId: cleanup.commandId,
                    ok: cancellation.ok,
                    result: cancellation
                }).accepted
            ).toEqual(true);
            expect(takeAgentDispatchableCommands(service, 'run-1', 'receiver')).toEqual([]);
            const senderCleanup = takeAgentDispatchableCommands(service, 'run-1', 'sender');
            expect(senderCleanup.map((command) => command.command.kind)).toEqual(['recipe.cancel', 'close']);
            for (const command of senderCleanup) {
                await runSegment(service, senderRuntime, command);
            }
            const roots = service.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId));
            if (bounds > 1) {
                expect(roots?.map((result) => result.result?.status)).toEqual(['cancelled', 'cancelled']);
            }
            else {
                expect(service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.length).toEqual(1);
            }
        }
        finally {
            await runtime.execute({ kind: 'recipe.cancel' });
            await pending;
            unsubscribe();
        }
    });
}

test('completed receiver proof remains full under retention pressure while sender reload is pending', async () => {
    const input = toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: 1, results: 1 } });
    const service = createRallarBlackBoxControlService(input);
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const [ready] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    await runSegment(service, runtime, ready);
    await runSegment(service, createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 }), takeAgentDispatchableCommands(service, 'run-1', 'sender')[0]);
    const [absence] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    await runSegment(service, runtime, absence);
    const [recovery] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    await runSegment(service, runtime, recovery);
    const snapshot = service.snapshotForPersistence({ commands: 1, results: 1 });
    expect(snapshot.runs[0].results.find((result) => result.commandId === 'receiver-root')?.ok).toEqual(true);
    const retained = snapshot.runs[0].results.filter((result) => [ready.commandId, absence.commandId, recovery.commandId].includes(result.commandId));
    expect(retained.length).toEqual(3);
    for (const result of retained) {
        assert(typeof result.result?.value === 'object' && result.result.value !== null && 'results' in result.result.value);
    }
    const restored = createRallarBlackBoxControlService(input);
    restored.restoreSnapshot(snapshot);
    restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    const [reload] = takeAgentDispatchableCommands(restored, 'run-1', 'sender');
    expect(reload.command.kind).toEqual('agent.reload');
    const restoredProof = restored.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.find((result) => result.commandId === absence.commandId);
    expect(restoredProof?.result?.value).toEqual(retained.find((result) => result.commandId === absence.commandId)?.result?.value);
});

for (const phase of ['ready', 'absence-pending', 'absence-completed'] as const) {
    test(`restored ${phase} proof cannot authorize a different receiver generation`, async () => {
        const input = toControlServiceInput({ now: () => 1_000 });
        const service = createRallarBlackBoxControlService(input);
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
        assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
        const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
        await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
        if (phase !== 'ready') {
            await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'sender')[0]);
            const [absence] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
            if (phase === 'absence-completed') {
                await runSegment(service, runtime, absence);
            }
        }
        const restored = createRallarBlackBoxControlService(input);
        restored.restoreSnapshot(service.snapshotForPersistence());
        restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        restored.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        expect(takeAgentDispatchableCommands(restored, 'run-1', 'sender')).toEqual([]);
        expect(takeAgentDispatchableCommands(restored, 'run-1', 'receiver')).toEqual([]);
        const roots = restored.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId));
        expect(roots?.length).toEqual(2);
        assert(roots?.every((root) => root.ok === false));
    });
}

test('queued cleanup is refused after receiver generation changes and never replays', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
    await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'sender')[0]);
    const [absence] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    assert(absence.command.kind === 'recipe.run');
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'sender', commandId: 'stop', command: { kind: 'recipe.cancel' } }));
    service.markAgentDisconnected('run-1', 'receiver');
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    expect(takeAgentDispatchableCommands(service, 'run-1', 'receiver')).toEqual([]);
    const refused = service.snapshotRun('run-1')?.results.find((result) => result.result?.error?.code === 'RALLAR_BLACK_BOX_RELOAD_CLEANUP_TARGET_UNAVAILABLE');
    expect(refused?.result?.value).toEqual({ cancelRequested: false, targetCommandId: absence.commandId });
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    expect(takeAgentDispatchableCommands(service, 'run-1', 'receiver')).toEqual([]);
});

test('only the exact complete receiver absence result unlocks sender reload', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
    await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'sender')[0]);
    const [absence] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    const result = await executeControlRuntimeCommand(runtime, absence);
    expect(result.ok).toEqual(true);
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
        expect(service.receiveClientEnvelope(invalid).accepted).toEqual(false);
        expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
    }
    expect(service.receiveClientEnvelope(actual).accepted).toEqual(true);
    expect(takeAgentDispatchableCommands(service, 'run-1', 'sender').map((command) => command.command.kind)).toEqual(['agent.reload']);
});

for (const restrictedBy of ['allowlist', 'rate'] as const) {
    test(`actual receiver failure reports cleanup ${restrictedBy} denial without claiming sender cancellation`, async () => {
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
        const senderRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
        const receiverRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
        const [prefix] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
        const entered = Promise.withResolvers<void>();
        const unsubscribe = senderRuntime.subscribe((state) => {
            if (state.activeCommand?.commandId === 'sender-prefix') {
                entered.resolve();
            }
        });
        const running = executeControlRuntimeCommand(senderRuntime, prefix);
        await entered.promise;
        try {
            receiverRuntime.recordEvent({ kind: 'event', topic: 'unexpected' });
            const [ready] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
            const failure = await executeControlRuntimeCommand(receiverRuntime, ready);
            expect(failure.ok).toEqual(false);
            expect(
                service.receiveClientEnvelope({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'receiver',
                    commandId: ready.commandId,
                    ok: false,
                    result: failure
                }).accepted
            ).toEqual(true);
            expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
            const root = service.snapshotRun('run-1')?.results.find((result) => result.commandId === 'sender-root');
            expect(root?.result?.error?.details).toEqual({
                cleanupFailure: restrictedBy === 'allowlist'
                    ? { code: 'command-kind-not-allowed', message: 'Command kind is not allowed: recipe.cancel.' }
                    : { code: 'command-rate-limited', message: 'Command rate limit exceeded.' }
            });
            expect(senderRuntime.state().status).toEqual('running');
        }
        finally {
            await senderRuntime.execute({ kind: 'recipe.cancel' });
            expect((await running).status).toEqual('cancelled');
            unsubscribe();
        }
    });
}

test('failed actual receiver absence closes the successful sender prefix instead of targeting idle cancellation', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const senderRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const receiverRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, receiverRuntime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
    const [prefix] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    await runSegment(service, senderRuntime, prefix);
    const [absence] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    receiverRuntime.recordEvent({ kind: 'event', topic: 'original' });
    const failure = await executeControlRuntimeCommand(receiverRuntime, absence);
    expect(failure.ok).toEqual(false);
    expect(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'receiver',
            commandId: absence.commandId,
            ok: false,
            result: failure
        }).accepted
    ).toEqual(true);
    const [cleanup] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    assert(cleanup.command.kind === 'close');
    expect(cleanup.command.targetCommandId).toEqual(prefix.commandId);
    const closed = await executeControlRuntimeCommand(senderRuntime, cleanup);
    expect(closed.value).toEqual({ closed: true });
    expect(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'sender',
            commandId: cleanup.commandId,
            ok: closed.ok,
            result: closed
        }).accepted
    ).toEqual(true);
    expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
});

test('actual finish between cancel queue and execution permits exactly one guarded close successor', async () => {
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
    const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const [prefix] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    const entered = Promise.withResolvers<void>();
    const unsubscribe = runtime.subscribe((state) => {
        if (state.activeCommand?.commandId === 'sender-prefix') {
            entered.resolve();
        }
    });
    const running = executeControlRuntimeCommand(runtime, prefix);
    await entered.promise;
    try {
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'receiver', commandId: 'stop', command: { kind: 'recipe.cancel' } }));
        const [cancellation] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
        assert(cancellation.command.kind === 'recipe.cancel');
        runtime.recordEvent({ kind: 'event', topic: 'finish-prefix' });
        const finished = await running;
        expect(finished.ok).toEqual(true);
        expect(
            service.receiveClientEnvelope({
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'sender',
                commandId: prefix.commandId,
                ok: true,
                result: finished
            }).accepted
        ).toEqual(false);
        const refused = await executeControlRuntimeCommand(runtime, cancellation);
        expect(refused.value).toEqual({ cancelRequested: false, targetCommandId: prefix.commandId, reason: 'target-not-exclusively-active' });
        const refusal = {
            kind: 'result' as const,
            protocolVersion: 1 as const,
            runId: 'run-1',
            agentId: 'sender',
            commandId: cancellation.commandId,
            ok: refused.ok,
            result: refused
        };
        expect(service.receiveClientEnvelope(refusal).accepted).toEqual(true);
        const pending = service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
        assert(pending.commands.some((command) => command.envelope.commandId === prefix.commandId));
        assert(pending.results.some((result) => result.commandId === cancellation.commandId));
        const [close] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
        assert(close.command.kind === 'close');
        expect(close.command.targetCommandId).toEqual(prefix.commandId);
        expect(close.deadlineEpochMs).toEqual(cancellation.deadlineEpochMs);
        expect(service.receiveClientEnvelope(refusal).accepted).toEqual(false);
        const closed = await executeControlRuntimeCommand(runtime, close);
        expect(closed.value).toEqual({ closed: true });
        expect(
            service.receiveClientEnvelope({
                kind: 'result',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'sender',
                commandId: close.commandId,
                ok: closed.ok,
                result: closed
            }).accepted
        ).toEqual(true);
        expect(takeAgentDispatchableCommands(service, 'run-1', 'sender')).toEqual([]);
        expect(service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0].results.length).toEqual(1);
    }
    finally {
        await runtime.execute({ kind: 'recipe.cancel' });
        await running;
        unsubscribe();
    }
});

test('authored checkpoints cannot silently become an ordinary unpaired recipe', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    for (const role of ['sender', 'receiver'] as const) {
        const root = toRootEnvelope(role, role === 'sender' ? SENDER : RECEIVER);
        const outcome = service.enqueueCommand({ ...root, agentId: PAIR[role].agentId });
        expect(outcome.left?.code).toEqual('command-payload-conflict');
        expect(takeAgentDispatchableCommands(service, 'run-1', PAIR[role].agentId)).toEqual([]);
    }
});

test('completed sender proof remains full until actual receiver recovery completes', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000, runtimeRetentionBounds: { commands: 1, results: 1 } }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const senderRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    const receiverRuntime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, receiverRuntime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
    const [prefix] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    await runSegment(service, senderRuntime, prefix);
    await runSegment(service, receiverRuntime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
    const [reload] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    assert(reload.command.kind === 'agent.reload');
    // This acknowledgement is a control-client protocol input, not evidence of native document replacement.
    const acknowledgement = toAgentReloadResult({
        commandId: reload.commandId,
        readyTimeoutMs: reload.command.readyTimeoutMs,
        written: 'written',
        atEpochMs: 1_000
    });
    expect(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'sender',
            commandId: reload.commandId,
            ok: true,
            result: { ...acknowledgement, commandId: 'replace-page' }
        }).accepted
    ).toEqual(false);
    expect(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'sender',
            commandId: reload.commandId,
            ok: true,
            result: acknowledgement
        }).accepted
    ).toEqual(true);
    service.markAgentDisconnected('run-1', 'sender');
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender', completedCommandIds: [reload.commandId] }));
    const [suffix] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    await runSegment(service, senderRuntime, suffix);
    const snapshot = service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
    expect(snapshot.results.find((result) => result.commandId === 'sender-root')?.ok).toEqual(true);
    const value = snapshot.results.find((result) => result.commandId === 'sender-root')?.result?.value;
    assert(isJsonRecordValue(value) && Array.isArray(value.results));
    const projectedReload = value.results.filter(isRallarBlackBoxTestResult).find((result) => result.kind === 'agent.reload');
    expect(projectedReload).toEqual({ ...acknowledgement, commandId: 'replace-page' });
    expect(snapshot.results.find((result) => result.commandId === reload.commandId)?.result).toEqual(acknowledgement);
    for (const id of [prefix.commandId, suffix.commandId]) {
        const result = snapshot.results.find((result) => result.commandId === id);
        assert(typeof result?.result?.value === 'object' && result.result.value !== null && 'results' in result.result.value);
    }
    await runSegment(service, receiverRuntime, takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]);
    const terminal = service.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
    expect(terminal.results.length).toEqual(1);
    expect(terminal.commands.length).toEqual(1);
});

test('a stale targeted external cancellation cannot terminalize the current paired roots', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
    assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
    assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
    const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 });
    await runSegment(service, runtime, takeAgentDispatchableCommands(service, 'run-1', 'sender')[0]);
    assertRight(
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'sender',
            commandId: 'stale-cancel',
            command: { kind: 'recipe.cancel', targetCommandId: 'old-unrelated-root' }
        })
    );
    const [cancel] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
    const refusal = await executeControlRuntimeCommand(runtime, cancel);
    expect(refusal.value).toEqual({ cancelRequested: false, targetCommandId: 'old-unrelated-root', reason: 'target-not-exclusively-active' });
    service.receiveClientEnvelope({
        kind: 'result',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'sender',
        commandId: cancel.commandId,
        ok: refusal.ok,
        result: refusal
    });
    expect(service.snapshotRun('run-1')?.results.filter((result) => ['sender-root', 'receiver-root'].includes(result.commandId))).toEqual([]);
    const [ready] = takeAgentDispatchableCommands(service, 'run-1', 'receiver');
    await runSegment(service, createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 }), ready);
    expect(takeAgentDispatchableCommands(service, 'run-1', 'receiver')[0]?.command.kind).toEqual('recipe.run');
});

for (const restore of [false, true]) {
    test(`lost dispatched cleanup is bounded without replay (restore=${restore})`, async () => {
        let now = 1_000;
        const input = toControlServiceInput({ now: () => now, runtimeRetentionBounds: { commands: 1, results: 1 } });
        const service = createRallarBlackBoxControlService(input);
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'receiver' }));
        assertRight(service.enqueueCommand(toPairedRoot('sender', SENDER)));
        assertRight(service.enqueueCommand(toPairedRoot('receiver', RECEIVER)));
        const [prefix] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
        await runSegment(service, createDefaultRallarBlackBoxTestRuntime({ now: () => now }), prefix);
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'receiver', commandId: 'stop', command: { kind: 'recipe.cancel' } }));
        const [cleanup] = takeAgentDispatchableCommands(service, 'run-1', 'sender');
        assert(cleanup.command.kind === 'close');
        const current = restore ? createRallarBlackBoxControlService(input) : service;
        if (restore) {
            current.restoreSnapshot(service.snapshotForPersistence({ commands: 1, results: 1 }));
            current.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'sender' }));
        }
        expect(takeAgentDispatchableCommands(current, 'run-1', 'sender')).toEqual([]);
        now = 2_001;
        expect(takeAgentDispatchableCommands(current, 'run-1', 'sender')).toEqual([]);
        const snapshot = current.snapshotForPersistence({ commands: 1, results: 1 }).runs[0];
        const failure = snapshot.results.find((result) => result.commandId === cleanup.commandId);
        expect(failure?.ok).toEqual(false);
        expect(failure?.result?.value).toEqual({ targetCommandId: prefix.commandId });
        expect(snapshot.commands.some((command) => command.envelope.commandId === prefix.commandId)).toEqual(false);
    });
}

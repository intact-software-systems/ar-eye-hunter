import { assert, assertEquals, assertThrows } from '@std/assert';

import { toRallarBlackBoxCompositeResultFlatEntries } from '@shared-test/rallar-bb-test/composite-results.ts';
import { bindAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    RallarBlackBoxControlClient,
    type RallarBlackBoxControlSocketEvent,
    type RallarBlackBoxControlSocketEventType,
    type RallarBlackBoxControlSocketListener,
    type RallarBlackBoxControlWebSocket
} from '@shared-test/rallar-bb-test/control-client.ts';
import {
    parseControlClientMessage,
    parseControlServerMessage,
    type ControlCommandEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestRecipe,
    type RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    createRallarBlackBoxControlService,
    type RallarBlackBoxControlService
} from '../src/control-service.ts';
import { assertRight, toControlServiceInput, toRegisterEnvelope } from './support/control-service-test-fixtures.ts';

const FAILURE: RallarBlackBoxTestCommand = {
    kind: 'assert',
    commandId: 'missing-message',
    source: 'state.messages.length',
    operator: 'gte',
    expected: 1
};

const APPLIED_OFF_RECEIPT = {
    status: 'observed',
    value: {
        configuration: { mode: 'off', origin: 'run' },
        application: { status: 'applied', mode: 'off' },
        configurationVersion: 1,
        connectionId: { status: 'observed', value: 'original-connection' },
        nativeScopeId: { status: 'unavailable', reason: 'not-applicable' },
        nativeAvailability: { status: 'unavailable', reason: 'disabled' },
        nativeCoverage: 'not-applicable'
    }
} as const;

for (
    const scenario of [
        'missing result',
        'missing receipt',
        'malformed application',
        'unavailable application',
        'wrong application mode',
        'outer and inner completion disagree',
        'wrong root command',
        'wrong child command',
        'wrong agent',
        'wrong invocation selection',
        'wrong connection name',
        'wrong run',
        'outer replay contradicts inner replay'
    ]
) {
    Deno.test(`required capture refuses ${scenario} before accepting completion`, () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
        service.receiveClientEnvelope({
            kind: 'register',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'capture-agent',
            atEpochMs: 1_000,
            identity: { sessionLabel: 'capture-agent', updatedAtEpochMs: 1_000 },
            resume: { completedCommandIds: [] }
        });
        const queued = assertRight(service.enqueueCommand({
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: 'capture-root',
            command: {
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'capture-recipe',
                    commands: [{ kind: 'rtc.connect', commandId: 'capture-connect', connection: 'required-connection' }]
                }
            }
        }));
        assert(parseControlServerMessage(JSON.stringify(queued), { runId: 'run-1', agentId: 'capture-agent' }).ok);
        assertEquals(service.takeDispatchableCommands('run-1', 'capture-agent').map((command) => command.commandId), ['capture-root']);
        const envelope = toRequiredCaptureEnvelope(scenario);
        const parsed = parseControlClientMessage(JSON.stringify(envelope));
        const accepted = parsed.ok && service.receiveClientEnvelope(parsed.envelope).accepted;
        const snapshot = service.snapshotRun('run-1');
        assert(snapshot);
        assertEquals({
            accepted,
            storedResults: snapshot.results.length,
            completedAtEpochMs: snapshot.commands[0].completedAtEpochMs,
            completedCommandIds: snapshot.agents.find((agent) => agent.agentId === 'capture-agent')?.completedCommandIds
        }, {
            accepted: false,
            storedResults: 0,
            completedAtEpochMs: undefined,
            completedCommandIds: []
        }, 'required success must validate actual application and attribution before mutating completion');
    });
}

for (const required of [false, true]) {
    Deno.test(`serialized ${required ? 'valid applied Off' : 'omitted intent'} completion remains admissible`, () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
        service.receiveClientEnvelope({
            kind: 'register',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'capture-agent',
            atEpochMs: 1_000,
            identity: { sessionLabel: 'capture-agent', updatedAtEpochMs: 1_000 },
            resume: { completedCommandIds: [] }
        });
        assertRight(service.enqueueCommand({
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: 'capture-root',
            command: {
                kind: 'recipe.run',
                rtcCaptureMode: required ? 'off' : undefined,
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'capture-recipe',
                    commands: [{ kind: 'rtc.connect', commandId: 'capture-connect', connection: 'required-connection' }]
                }
            }
        }));
        assertEquals(service.takeDispatchableCommands('run-1', 'capture-agent').length, 1);
        const envelope = toRequiredCaptureEnvelope(required ? 'valid' : 'omitted intent');
        const parsed = parseControlClientMessage(JSON.stringify(envelope));
        assert(parsed.ok);
        assertEquals(service.receiveClientEnvelope(parsed.envelope).accepted, true);
        assertEquals(service.snapshotCommand('run-1', 'capture-root')?.completedAtEpochMs, 1_000);
        const run = service.snapshotRun('run-1');
        assert(run);
        assert(decodeControlRunSnapshot(JSON.parse(JSON.stringify(run))).right !== undefined);
        if (required) {
            const corrupt = JSON.parse(JSON.stringify(run));
            delete corrupt.results[0].result.value.results[0].value.rtcCapture;
            assert(decodeControlRunSnapshot(corrupt).left !== undefined, 'restore must refuse a required success whose stored receipt was lost');
            assertThrows(() => service.restoreSnapshot({ ...service.snapshotForPersistence({}), runs: [corrupt] }), Error, 'required application');
            assertEquals(service.snapshotRun('run-1')?.results, run.results);
        }
    });
}

for (const reference of [false, true]) {
    Deno.test(`required applied receipt accepts ${reference ? 'loaded reference' : 'continueOnFailure'} runtime completion`, async () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
        service.receiveClientEnvelope({
            kind: 'register',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'capture-agent',
            atEpochMs: 1_000,
            identity: { sessionLabel: 'capture-agent', updatedAtEpochMs: 1_000 },
            resume: { completedCommandIds: [] }
        });
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => 1_000,
            commandExecutor: (command) =>
                command.kind === 'rtc.connect'
                    ? { status: 'ok', value: { connection: command.connection, rtcCapture: APPLIED_OFF_RECEIPT } }
                    : undefined
        });
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'capture-recipe',
            continueOnFailure: true,
            commands: [
                { kind: 'rtc.connect', commandId: 'capture-connect', connection: 'required-connection' },
                FAILURE
            ]
        };
        if (reference) {
            assertRight(service.enqueueCommand({
                runId: 'run-1',
                agentId: 'capture-agent',
                commandId: 'accepted-load',
                command: { kind: 'recipe.load', recipe }
            }));
            const [load] = service.takeDispatchableCommands('run-1', 'capture-agent');
            const result = await runtime.execute({ ...load.command, commandId: load.commandId });
            assertEquals(
                service.receiveClientEnvelope({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'run-1',
                    agentId: 'capture-agent',
                    commandId: load.commandId,
                    ok: result.ok,
                    result
                }).accepted,
                true
            );
        }
        assertRight(service.enqueueCommand({
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: 'capture-root',
            command: { kind: 'recipe.run', rtcCaptureMode: 'off', recipe: reference ? undefined : recipe }
        }));
        const [queued] = service.takeDispatchableCommands('run-1', 'capture-agent');
        const result = await runtime.execute({ ...queued.command, commandId: queued.commandId });
        assertEquals(result.status, 'ok');
        assertEquals(result.ok, true);
        const parsed = parseControlClientMessage(JSON.stringify({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: queued.commandId,
            ok: result.ok,
            result
        }));
        assert(parsed.ok);
        assertEquals(service.receiveClientEnvelope(parsed.envelope).accepted, true);
        const stored = service.snapshotRun('run-1')?.results.find((entry) => entry.commandId === queued.commandId);
        assert(isJsonRecordValue(stored?.result?.value));
        assertEquals(stored.result.value.failureCount, 1);
        assert(Array.isArray(stored.result.value.results));
        assertEquals(stored.result.value.results[1].ok, false);
        assertEquals(stored.result.value.results[1].error.code, 'RALLAR_BLACK_BOX_ASSERT_FAILED');
        assert(decodeControlRunSnapshot(JSON.parse(JSON.stringify(service.snapshotRun('run-1')))).right !== undefined);
    });
}

for (
    const { completedCurrent, historicalOk } of [{ completedCurrent: false, historicalOk: true }, { completedCurrent: true, historicalOk: true }, {
        completedCurrent: false,
        historicalOk: false
    }]
) {
    Deno.test(`unowned historical ${historicalOk ? 'success' : 'failure'} cannot complete or replay a ${completedCurrent ? 'completed' : 'pending'} required command`, () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'capture-agent' }));
        assertRight(service.enqueueCommand({
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: 'capture-root',
            command: {
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'capture-recipe',
                    commands: [{ kind: 'rtc.connect', commandId: 'capture-connect', connection: 'required-connection' }]
                }
            }
        }));
        service.takeDispatchableCommands('run-1', 'capture-agent');
        if (completedCurrent) {
            assertEquals(service.receiveClientEnvelope(toRequiredCaptureEnvelope('valid')).accepted, true);
        }
        const snapshot = service.snapshotRun('run-1');
        assert(snapshot);
        const historical = toRequiredCaptureEnvelope('valid');
        const fact = historicalOk
            ? historical
            : {
                ...historical,
                ok: false,
                result: historical.result &&
                    { ...historical.result, status: 'failed' as const, ok: false, error: { code: 'historical-failure', message: 'Earlier execution failed.' } }
            };
        const corrupt = { ...snapshot, results: [{ ...fact, commandId: 'unowned-root' }] };
        const decoded = assertRight(decodeControlRunSnapshot(corrupt));
        assertEquals(decoded.results[0].attribution, { status: 'unavailable', reason: 'queued-command-not-retained' });
        assertEquals(decoded.results[0].result, fact.result);
        const replay = parseControlClientMessage(JSON.stringify({ ...decoded.results[0], commandId: 'capture-root' }));
        assert(replay.ok);
        assertEquals(replay.envelope.kind, 'result');
        assertEquals(
            service.receiveClientEnvelope(replay.envelope).accepted,
            false,
            'historical unavailable ownership cannot certify current required completion or replay'
        );
        const after = service.snapshotRun('run-1');
        assert(after);
        assertEquals(after.results, snapshot.results);
        assertEquals(after.commands, snapshot.commands);
        assertEquals(after.agents, snapshot.agents);
        if (!completedCurrent) {
            assertEquals(after.results.length, 0);
            assertEquals(after.commands[0].completedAtEpochMs, undefined);
            assertEquals(after.agents[0].completedCommandIds, []);
        }
    });
}

Deno.test('nested inline recipe selection remains admissible with omitted outer intent', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'capture-agent' }));
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: () => 1_000,
        commandExecutor: (command) =>
            command.kind === 'rtc.connect'
                ? { status: 'ok', value: { connection: command.connection, rtcCapture: APPLIED_OFF_RECEIPT } }
                : undefined
    });
    assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'capture-agent',
        commandId: 'capture-root',
        command: {
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                commands: [
                    {
                        kind: 'recipe.run',
                        commandId: 'inner-run',
                        rtcCaptureMode: 'off',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'inner',
                            commands: [
                                { kind: 'rtc.connect', commandId: 'nested-connect', connection: 'required-connection' }
                            ]
                        }
                    }
                ]
            }
        }
    }));
    const [queued] = service.takeDispatchableCommands('run-1', 'capture-agent');
    const result = await runtime.execute({ ...queued.command, commandId: queued.commandId });
    assertEquals(result.ok, true);
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: queued.commandId,
            ok: true,
            result
        }).accepted,
        true,
        'the nested command owns the run selection when its parent omitted one'
    );
});

Deno.test('serialized result rejects malformed nested lifecycle at the wire boundary', () => {
    const valid = toRequiredCaptureEnvelope('valid');
    const parsed = parseControlClientMessage(JSON.stringify({ ...valid, result: { ...valid.result, durationMs: 'not-a-number' } }));
    assertEquals(parsed.ok, false);
    assertEquals(parseControlClientMessage(JSON.stringify({ ...valid, error: { code: 'FAILURE', message: 42 } })).ok, false);
});

for (const corruption of ['none', 'duplicate iteration', 'duplicate child index']) {
    Deno.test(`runtime count-2 capture loop ${corruption} validates owned positions before completion`, async () => {
        const execution = await toRuntimeCaptureExecution({
            kind: 'loop',
            count: 2,
            commands: [{ kind: 'rtc.connect', commandId: 'connect', rallar: { rtcCaptureMode: 'off' } }]
        });
        const entries = toRallarBlackBoxCompositeResultFlatEntries([execution.result]);
        assertEquals(entries.filter((entry) => entry.kind === 'rtc.connect').map((entry) => entry.path), [
            '$.iterations[1].commands[0]',
            '$.iterations[2].commands[0]'
        ]);
        const changed = JSON.parse(JSON.stringify(execution.envelope));
        if (corruption === 'duplicate iteration') {
            changed.result.value.results[1] = changed.result.value.results[0];
        }
        if (corruption === 'duplicate child index') {
            changed.result.value.results[1].childIndex = changed.result.value.results[0].childIndex;
        }
        const parsed = parseControlClientMessage(JSON.stringify(changed));
        assert(parsed.ok);
        const before = execution.service.snapshotRun('run-1');
        assert(before);
        const accepted = execution.service.receiveClientEnvelope(parsed.envelope).accepted;
        assertEquals(accepted, corruption === 'none');
        const after = execution.service.snapshotRun('run-1');
        assert(after);
        if (corruption !== 'none') {
            assertEquals(after.results.length, 0);
            assertEquals(after.commands, before.commands);
            assertEquals(after.agents, before.agents);
        }
        else {
            assertEquals(after.results.length, 1);
            assertEquals(after.commands[0].completedAtEpochMs, 1_000);
        }
    });
}

for (const ending of ['first-success', 'failed', 'cancelled']) {
    Deno.test(`runtime capture loop retains legitimate ${ending} partial execution`, async () => {
        const endingCommand: RallarBlackBoxTestCommand | undefined = ending === 'failed'
            ? FAILURE
            : ending === 'cancelled'
            ? { kind: 'recipe.cancel', commandId: 'stop' }
            : undefined;
        const execution = await toRuntimeCaptureExecution({
            kind: 'loop',
            count: 2,
            until: ending === 'first-success' ? 'first-success' : undefined,
            commands: [
                { kind: 'rtc.connect', commandId: 'connect', rallar: { rtcCaptureMode: 'off' } },
                ...(endingCommand === undefined ? [] : [endingCommand]),
                ...(ending === 'cancelled' ? [{ kind: 'stats' as const, commandId: 'unexecuted' }] : [])
            ]
        });
        assertEquals(execution.result.status, ending === 'first-success' ? 'ok' : ending);
        const entries = toRallarBlackBoxCompositeResultFlatEntries([execution.result]);
        assertEquals(entries.filter((entry) => entry.kind === 'rtc.connect').length, 1);
        assert(entries.every((entry) => entry.childDecodeIssues.length === 0));
        const parsed = parseControlClientMessage(JSON.stringify(execution.envelope));
        assert(parsed.ok);
        assertEquals(execution.service.receiveClientEnvelope(parsed.envelope).accepted, true);
    });
}

interface RuntimeCaptureExecution {
    readonly service: RallarBlackBoxControlService;
    readonly result: RallarBlackBoxTestResult;
    readonly envelope: ControlResultEnvelope;
}

for (const corruption of ['none', 'invalid receipt', 'unknown body', 'wrong selection']) {
    Deno.test(`runtime nested loaded reference ${corruption} validates authored body and application`, async () => {
        const execution = await toRuntimeCaptureExecution({
            kind: 'recipe.run',
            rtcCaptureMode: 'off',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer-loaded-reference',
                commands: [
                    {
                        kind: 'recipe.load',
                        commandId: 'load-inner',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'known-inner',
                            commands: [{ kind: 'rtc.connect', commandId: 'loaded-connect', connection: 'required-connection' }]
                        }
                    },
                    { kind: 'recipe.run', commandId: 'invoke-inner' }
                ]
            }
        });
        assertEquals(execution.result.ok, true);
        const changed = JSON.parse(JSON.stringify(execution.envelope));
        const children = changed.result.value.results;
        assertEquals(children.map((child: RallarBlackBoxTestResult) => child.kind), ['recipe.load', 'recipe.run']);
        assertEquals(children[0].value.recipeBodyId, children[1].value.invocation.recipeBodyId);
        assertEquals(children[1].value.invocation.run, 'off');
        if (corruption === 'invalid receipt') {
            children[1].value.results[0].value.rtcCapture.value.application.mode = 'native';
        }
        if (corruption === 'unknown body') {
            children[1].value.invocation.recipeBodyId = 'unowned-body';
        }
        if (corruption === 'wrong selection') {
            children[1].value.invocation.run = 'native';
        }
        const parsed = parseControlClientMessage(JSON.stringify(changed));
        assert(parsed.ok);
        const before = execution.service.snapshotRun('run-1');
        assert(before);
        assertEquals(execution.service.receiveClientEnvelope(parsed.envelope).accepted, corruption === 'none');
        const after = execution.service.snapshotRun('run-1');
        assert(after);
        if (corruption === 'none') {
            assertEquals(after.results.length, 1);
            const stored = JSON.parse(JSON.stringify(after.results[0].result));
            assertEquals(
                stored.value.results[0].value?.recipeBodyId,
                children[0].value.recipeBodyId,
                'finite storage must retain the actual load acknowledgment needed for nested reference attribution'
            );
            assert(decodeControlRunSnapshot(JSON.parse(JSON.stringify(after))).right !== undefined);
        }
        else {
            assertEquals(after.results.length, 0);
            assertEquals(after.commands, before.commands);
            assertEquals(after.agents, before.agents);
        }
    });
}

/** Executes the real recipe runtime; its controlled receipt tests admission, never actual SDK application. */
async function toRuntimeCaptureExecution(command: RallarBlackBoxTestCommand): Promise<RuntimeCaptureExecution> {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'capture-agent' }));
    const queued = assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'capture-agent',
        commandId: 'capture-root',
        command
    }));
    assertEquals(service.takeDispatchableCommands('run-1', 'capture-agent').length, 1);
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: () => 1_000,
        commandExecutor: (command) =>
            command.kind === 'rtc.connect'
                ? { status: 'ok', value: { connection: command.connection, rtcCapture: APPLIED_OFF_RECEIPT } }
                : undefined
    });
    const result = await runtime.execute({ ...queued.command, commandId: queued.commandId });
    return {
        service,
        result,
        envelope: {
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: queued.commandId,
            ok: result.ok,
            result
        }
    };
}

for (const scenario of ['wrong parent', 'wrong path', 'wrong source path', 'wrong wrapper command', 'wrong group']) {
    Deno.test(`required capture refuses attributed composite ${scenario}`, async () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'capture-agent' }));
        const child: RallarBlackBoxTestCommand = { kind: 'rtc.connect', commandId: 'same-child', rallar: { rtcCaptureMode: 'off' } };
        const command: RallarBlackBoxTestCommand = scenario === 'wrong group'
            ? { kind: 'parallel', groups: [{ groupId: 'owned', commands: [child] }] }
            : { kind: 'loop', count: 2, commands: [child] };
        const queued = assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'capture-agent', commandId: 'capture-composite', command }));
        service.takeDispatchableCommands('run-1', 'capture-agent');
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => 1_000,
            commandExecutor: (command) => command.kind === 'rtc.connect' ? { status: 'ok', value: { rtcCapture: APPLIED_OFF_RECEIPT } } : undefined
        });
        const result = await runtime.execute({ ...queued.command, commandId: queued.commandId });
        assert(result.ok);
        const envelope = { kind: 'result', protocolVersion: 1, runId: 'run-1', agentId: 'capture-agent', commandId: queued.commandId, ok: true, result };
        const parsed = parseControlClientMessage(JSON.stringify(envelope));
        assert(parsed.ok);
        assertEquals(service.receiveClientEnvelope(parsed.envelope).accepted, true);
        if (scenario === 'wrong group') {
            const stored = service.snapshotRun('run-1')?.results[0].result;
            const group = JSON.parse(JSON.stringify(stored?.value)).groups[0];
            assertEquals(
                { commandCount: group.commandCount, passed: group.passed, failed: group.failed, cancelled: group.cancelled, durationMs: group.durationMs },
                { commandCount: 1, passed: 1, failed: 0, cancelled: false, durationMs: 0 },
                'finite receipt projection retains independent parallel completion and timing facts'
            );
        }
        const changed = JSON.parse(JSON.stringify(envelope));
        const wrapper = scenario === 'wrong group' ? changed.result.value.groups[0].results[0] : changed.result.value.results[0];
        if (scenario === 'wrong parent') {
            wrapper.parentCommandId = 'different-parent';
        }
        if (scenario === 'wrong path') {
            wrapper.path = '$.unowned[0]';
        }
        if (scenario === 'wrong source path') {
            wrapper.sourceRecipePath = '$.unowned[0]';
        }
        if (scenario === 'wrong wrapper command') {
            wrapper.commandId = 'different-wrapper';
        }
        if (scenario === 'wrong group') {
            wrapper.groupId = 'different-group';
        }
        const corrupt = parseControlClientMessage(JSON.stringify(changed));
        assert(corrupt.ok);
        assertEquals(service.receiveClientEnvelope(corrupt.envelope).accepted, false);
    });
}

for (const native of [false, true]) {
    Deno.test(`application accepts ${native ? 'Native partial' : 'original same-mode construction origin'} without a complete-history claim`, () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'capture-agent' }));
        const mode = native ? 'native' : 'off';
        assertRight(service.enqueueCommand({
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: 'capture-root',
            command: {
                kind: 'recipe.run',
                rtcCaptureMode: mode,
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'capture-recipe',
                    commands: [{ kind: 'rtc.connect', commandId: 'capture-connect', connection: 'required-connection' }]
                }
            }
        }));
        service.takeDispatchableCommands('run-1', 'capture-agent');
        const envelope = JSON.parse(JSON.stringify(toRequiredCaptureEnvelope('valid')));
        envelope.result.value.invocation.run = mode;
        const receipt = envelope.result.value.results[0].value.rtcCapture;
        receipt.value.configuration = { mode, origin: 'step' };
        receipt.value.application = { status: 'applied', mode };
        if (native) {
            receipt.value.nativeScopeId = { status: 'observed', value: 'original-native-scope' };
            receipt.value.nativeAvailability = { status: 'observed', value: 'enabled' };
            receipt.value.nativeCoverage = 'partial';
        }
        const parsed = parseControlClientMessage(JSON.stringify(envelope));
        assert(parsed.ok);
        assertEquals(service.receiveClientEnvelope(parsed.envelope).accepted, true);
        const stored = service.snapshotRun('run-1');
        assert(stored);
        assert(decodeControlRunSnapshot(JSON.parse(JSON.stringify(stored))).right !== undefined);
        assertEquals(JSON.parse(JSON.stringify(stored.results[0].result?.value)).results[0].value.rtcCapture, receipt);
    });
}

/** Serialized admission fixture; SDK application is proved separately in its existing private fixture seat. */
function toRequiredCaptureEnvelope(scenario: string): ControlResultEnvelope {
    const application = scenario === 'malformed application'
        ? { status: 'applied' }
        : scenario === 'unavailable application'
        ? { status: 'unavailable', reason: 'sink-unavailable' }
        : scenario === 'wrong application mode'
        ? { status: 'applied', mode: 'native' }
        : APPLIED_OFF_RECEIPT.value.application;
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: scenario === 'wrong run' ? 'different-run' : 'run-1',
        agentId: scenario === 'wrong agent' ? 'different-agent' : 'capture-agent',
        commandId: 'capture-root',
        ok: true,
        replayed: false,
        result: scenario === 'missing result' ? undefined : {
            commandId: scenario === 'wrong root command' ? 'different-root' : 'capture-root',
            kind: 'recipe.run',
            status: scenario === 'outer and inner completion disagree' ? 'failed' : 'ok',
            ok: scenario !== 'outer and inner completion disagree',
            replayed: scenario === 'outer replay contradicts inner replay' ? true : undefined,
            startedAtEpochMs: 900,
            endedAtEpochMs: 1_000,
            durationMs: 100,
            value: {
                recipeId: 'capture-recipe',
                invocation: {
                    invocationId: 'original-invocation',
                    recipeBodyId: 'accepted-body',
                    run: scenario === 'omitted intent' ? undefined : scenario === 'wrong invocation selection' ? 'native' : 'off'
                },
                results: [{
                    commandId: scenario === 'wrong child command' ? 'different-child' : 'capture-connect',
                    kind: 'rtc.connect',
                    status: 'ok',
                    ok: true,
                    startedAtEpochMs: 900,
                    endedAtEpochMs: 1_000,
                    durationMs: 100,
                    value: {
                        status: 'connected',
                        connection: scenario === 'wrong connection name' ? 'different-connection' : 'required-connection',
                        rtcCapture: scenario === 'missing receipt' || scenario === 'omitted intent' ? undefined : {
                            ...APPLIED_OFF_RECEIPT,
                            value: { ...APPLIED_OFF_RECEIPT.value, application }
                        }
                    }
                }]
            }
        }
    };
}

Deno.test('actual client failed partial recipe evidence promptly terminates both paired reload roots', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    const sender = new ControlClientWire(service, 'sender');
    const receiver = new ControlClientWire(service, 'receiver');
    try {
        sender.connect();
        receiver.connect();
        const checkpoints = [{
            key: 'reload',
            senderPrefixEnd: 'sender-ready',
            senderReload: 'replace-page',
            senderSuffixEnd: 'sender-restored',
            receiverReadyEnd: 'receiver-ready',
            receiverAbsenceEnd: 'receiver-absence',
            receiverRecoveryEnd: 'receiver-recovered'
        }];
        const pair = assertRight(bindAlmReloadPair({
            sender: toRootEnvelope('sender', {
                schemaVersion: 1,
                recipeId: 'sender-reload',
                continueOnFailure: false,
                metadata: { profile: 'alm-conformance', almReloadCheckpoints: checkpoints },
                commands: [
                    { kind: 'stats', commandId: 'sender-ready' },
                    { kind: 'agent.reload', commandId: 'replace-page', readyTimeoutMs: 100 },
                    { kind: 'stats', commandId: 'sender-restored' }
                ]
            }),
            receiver: toRootEnvelope('receiver', {
                schemaVersion: 1,
                recipeId: 'receiver-reload',
                continueOnFailure: false,
                metadata: { profile: 'alm-conformance', almReloadCheckpoints: checkpoints },
                commands: [
                    { kind: 'stats', commandId: 'receiver-started' },
                    FAILURE,
                    { kind: 'stats', commandId: 'receiver-ready' },
                    { kind: 'wait', commandId: 'receiver-absence', absent: true, match: { topic: 'original' }, timeoutMs: 100 },
                    { kind: 'stats', commandId: 'receiver-recovered' }
                ]
            })
        }));
        assertRight(service.enqueueCommand({ ...pair.sender, agentId: 'sender' }));
        assertRight(service.enqueueCommand({ ...pair.receiver, agentId: 'receiver' }));
        const [prefix] = service.takeDispatchableCommands('run-1', 'receiver');
        assert(prefix);
        const receipt = await receiver.execute(prefix);
        assertEquals(receipt.accepted, true, 'the actual failed wire result must be admitted, not lost until the root deadline');
        const failed = receipt.envelope.result;
        assert(failed);
        assertEquals(failed.ok, false);
        assertEquals(failed.status, 'failed');
        assertEquals(receipt.envelope.error?.code, 'RALLAR_BLACK_BOX_RECIPE_FAILED');
        assertEquals(toExecutedChildIdentities(failed), [
            { commandId: 'receiver-started', status: 'ok' },
            { commandId: 'missing-message', status: 'failed' }
        ]);
        service.takeDispatchableCommands('run-1', 'sender');
        const snapshot = service.snapshotRun('run-1');
        assert(snapshot);
        const results = snapshot.results;
        const receiverRoot = results.find((result) => result.commandId === 'receiver-root');
        const senderRoot = results.find((result) => result.commandId === 'sender-root');
        assertEquals(receiverRoot?.result?.error?.code, 'RALLAR_BLACK_BOX_RECIPE_FAILED');
        assertEquals(senderRoot?.ok, false);
        assertEquals(receiverRoot?.result?.endedAtEpochMs, 1_000);
        assertEquals(senderRoot?.result?.endedAtEpochMs, 1_000);
        assert(receiverRoot?.result);
        assertEquals(toExecutedChildIdentities(receiverRoot.result), toExecutedChildIdentities(failed));
    }
    finally {
        sender.dispose();
        receiver.dispose();
    }
});

Deno.test('ordinary failed command and reconnect replay preserve the same actual result and outer error', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    const wire = new ControlClientWire(service, 'ordinary');
    try {
        wire.connect();
        assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'ordinary', commandId: 'missing-message', command: FAILURE }));
        const [command] = service.takeDispatchableCommands('run-1', 'ordinary');
        const immediate = await wire.execute(command);
        assertEquals(immediate.accepted, true);
        assert(immediate.envelope.result, 'ordinary failures retain the actual detailed result too');
        assertEquals(immediate.envelope.result.status, 'failed');
        assertEquals(immediate.envelope.result.commandId, 'missing-message');
        assertEquals(immediate.envelope.error?.code, immediate.envelope.result.error?.code);
        const replay = await wire.reconnectResult('missing-message');
        assertEquals(replay.accepted, true);
        assertEquals(replay.envelope.replayed, true);
        assertEquals(immediate.envelope.result.replayed, false);
        assertEquals(replay.envelope.result, { ...immediate.envelope.result, replayed: true });
        assertEquals(replay.envelope.error, immediate.envelope.error);
    }
    finally {
        wire.dispose();
    }
});

Deno.test('cancelled recipe publication preserves cancellation and only the children actually executed', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    const wire = new ControlClientWire(service, 'ordinary');
    try {
        wire.connect();
        assertRight(service.enqueueCommand({
            runId: 'run-1',
            agentId: 'ordinary',
            commandId: 'cancelled-recipe',
            command: {
                kind: 'recipe.run',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'cancelled',
                    commands: [
                        { kind: 'stats', commandId: 'started' },
                        { kind: 'recipe.cancel', commandId: 'stop' },
                        { kind: 'stats', commandId: 'unexecuted' }
                    ]
                }
            }
        }));
        const [command] = service.takeDispatchableCommands('run-1', 'ordinary');
        const receipt = await wire.execute(command);
        assertEquals(receipt.accepted, true);
        assert(receipt.envelope.result);
        assertEquals(receipt.envelope.result.status, 'cancelled');
        assertEquals(receipt.envelope.ok, false);
        assertEquals(toExecutedChildIdentities(receipt.envelope.result), [
            { commandId: 'started', status: 'ok' },
            { commandId: 'stop', status: 'ok' }
        ]);
        const replay = await wire.reconnectResult('cancelled-recipe');
        assertEquals(receipt.envelope.result.replayed, false);
        assertEquals(replay.envelope.result, { ...receipt.envelope.result, replayed: true });
        assertEquals(replay.envelope.error, receipt.envelope.error);
    }
    finally {
        wire.dispose();
    }
});

function toRootEnvelope(agentId: string, recipe: RallarBlackBoxTestRecipe): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-1',
        agentId,
        commandId: `${agentId}-root`,
        command: { kind: 'recipe.run', recipe, timeoutMs: 1_000 }
    };
}

interface ExecutedChildIdentity {
    readonly commandId: string;
    readonly status: string;
}

function toExecutedChildIdentities(result: RallarBlackBoxTestResult): readonly ExecutedChildIdentity[] {
    assert(isJsonRecordValue(result.value));
    assert(Array.isArray(result.value.results));
    return result.value.results.map((child) => {
        assert(isJsonRecordValue(child));
        assert(typeof child.commandId === 'string' && typeof child.status === 'string');
        return { commandId: child.commandId, status: child.status };
    });
}

interface ResultReceipt {
    readonly envelope: ControlResultEnvelope;
    readonly accepted: boolean;
}

/** Only the socket is controlled; bytes cross the real client serializer and production parser into the real service. */
class ControlClientWire implements RallarBlackBoxControlWebSocket {
    readyState = 0;
    private readonly service: RallarBlackBoxControlService;
    private readonly agentId: string;
    private readonly client: RallarBlackBoxControlClient;
    private readonly listeners = new Map<RallarBlackBoxControlSocketEventType, Set<RallarBlackBoxControlSocketListener>>();
    private expectedCommandId: string | undefined;
    private pendingResult = Promise.withResolvers<ResultReceipt>();

    constructor(service: RallarBlackBoxControlService, agentId: string) {
        this.service = service;
        this.agentId = agentId;
        this.client = new RallarBlackBoxControlClient({
            now: Date.now,
            runtime: createDefaultRallarBlackBoxTestRuntime({ now: () => 1_000 }),
            webSocketFactory: () => this,
            fetch: () => Promise.reject(new Error('This fixture does not upload reports.')),
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 0,
            reconnectBaseMs: 600,
            reconnectMaxMs: 5_000
        });
    }

    connect(): void {
        this.client.connect({ url: 'ws://control.test', runId: 'run-1', agentId: this.agentId, completedCommandIds: [] });
        this.readyState = 1;
        this.publish('open', {});
    }

    execute(command: ControlCommandEnvelope): Promise<ResultReceipt> {
        this.expectedCommandId = command.commandId;
        this.pendingResult = Promise.withResolvers<ResultReceipt>();
        this.publish('message', { data: JSON.stringify(command) });
        return this.pendingResult.promise;
    }

    reconnectResult(commandId: string): Promise<ResultReceipt> {
        this.expectedCommandId = commandId;
        this.pendingResult = Promise.withResolvers<ResultReceipt>();
        this.service.markAgentDisconnected('run-1', this.agentId);
        this.connect();
        return this.pendingResult.promise;
    }

    send(message: string): void {
        const parsed = parseControlClientMessage(message);
        assert(parsed.ok);
        const accepted = this.service.receiveClientEnvelope(parsed.envelope).accepted;
        if (parsed.envelope.kind === 'result' && parsed.envelope.commandId === this.expectedCommandId) {
            this.pendingResult.resolve({ envelope: parsed.envelope, accepted });
        }
    }

    close(): void {
        this.readyState = 3;
    }

    dispose(): void {
        this.client.dispose();
    }

    addEventListener(type: RallarBlackBoxControlSocketEventType, listener: RallarBlackBoxControlSocketListener): void {
        const listeners = this.listeners.get(type) ?? new Set<RallarBlackBoxControlSocketListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: RallarBlackBoxControlSocketEventType, listener: RallarBlackBoxControlSocketListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    private publish(type: RallarBlackBoxControlSocketEventType, event: RallarBlackBoxControlSocketEvent): void {
        this.listeners.get(type)?.forEach((listener) => listener(event));
    }
}

Deno.test('ordinary omitted intent compaction reports descendant retention limits without a complete-history claim', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_000 }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'capture-agent' }));
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'finite-history',
        commands: [
            { kind: 'loop', commandId: 'first', count: 1_000, commands: [{ kind: 'rtc.connect', commandId: 'same-child' }] },
            { kind: 'loop', commandId: 'second', count: 1_000, commands: [{ kind: 'rtc.connect', commandId: 'same-child' }] }
        ]
    };
    const queued = assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'capture-agent',
        commandId: 'finite-root',
        command: { kind: 'recipe.run', recipe }
    }));
    service.takeDispatchableCommands('run-1', 'capture-agent');
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command) =>
            command.kind === 'rtc.connect' ? { status: 'ok', value: { rtcCapture: APPLIED_OFF_RECEIPT, arbitraryPayload: 'x'.repeat(100) } } : undefined
    });
    const result = await runtime.execute({ ...queued.command, commandId: queued.commandId });
    assert(result.ok);
    assertEquals(
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId: 'capture-agent',
            commandId: queued.commandId,
            ok: true,
            result
        }).accepted,
        true
    );
    const stored = service.snapshotRun('run-1')?.results[0].result;
    assert(stored);
    assert(isJsonRecordValue(stored.value));
    assertEquals(stored.value.resultEvidence, { status: 'limited', payloadsOmitted: true });
    const entries = toRallarBlackBoxCompositeResultFlatEntries([stored]);
    assert(entries.length <= RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands);
    assert(entries.every((entry) => !isJsonRecordValue(entry.result.value) || entry.result.value.arbitraryPayload === undefined));
});

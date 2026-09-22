import { assert, assertEquals } from '@std/assert';

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
    type ControlCommandEnvelope,
    type ControlResultEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    createRallarBlackBoxControlService,
    type RallarBlackBoxControlService
} from '../src/control-service.ts';
import { assertRight, toControlServiceInput } from './support/control-service-test-fixtures.ts';

const FAILURE: RallarBlackBoxTestCommand = {
    kind: 'assert',
    commandId: 'missing-message',
    source: 'state.messages.length',
    operator: 'gte',
    expected: 1
};

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
        const results = service.snapshotRun('run-1')!.results;
        const receiverRoot = results.find((result) => result.commandId === 'receiver-root');
        const senderRoot = results.find((result) => result.commandId === 'sender-root');
        assertEquals(receiverRoot?.result?.error?.code, 'RALLAR_BLACK_BOX_RECIPE_FAILED');
        assertEquals(senderRoot?.ok, false);
        assertEquals(receiverRoot?.result?.endedAtEpochMs, 1_000);
        assertEquals(senderRoot?.result?.endedAtEpochMs, 1_000);
        assertEquals(toExecutedChildIdentities(receiverRoot!.result!), toExecutedChildIdentities(failed));
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
        assertEquals(replay.envelope.result, immediate.envelope.result);
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
        assertEquals(replay.envelope.result, receipt.envelope.result);
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
            runtime: createRallarBlackBoxTestRuntime({ now: () => 1_000 }),
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

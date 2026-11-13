import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import type { RallarBlackBoxTestMessagesObserveResultValue } from '@shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts';
import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxDistributedRunManifest, RallarBlackBoxDistributedRunState } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestMessagesReceiptsCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { createAlmConformance2AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertRight,
    toControlServiceInput,
    toFleetIdentity,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';
import { takeAgentDispatchableCommands } from './support/take-agent-dispatchable-commands.ts';

for (const scheduled of [false, true]) {
    test(`generated full ALM ${scheduled ? 'scheduled' : 'manual'} start preserves paired recovery connections and execution budget`, () => {
        let now = 1_000;
        const generated = createAlmConformance2AgentEntry().manifest;
        const manifest = scheduled
            ? { ...generated, startMode: 'scheduled' as const, startDeadlineEpochMs: 2_000 }
            : generated;
        const runId = manifest.controlRunId;
        const agents = ['controller-01', 'controller-02'];
        const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now }));
        for (const agentId of agents) {
            service.receiveClientEnvelope(toRegisterEnvelope({
                runId,
                agentId,
                identity: toFleetIdentity(agentId, manifest.group)
            }));
        }
        assertRight(service.createDistributedRun(manifest));
        assertRight(service.stageDistributedRun(manifest.distributedRunId));
        // Only configuration and the existing fleet barrier are acknowledged here; no ALM outcome is invented.
        for (const phase of ['stage', 'barrier']) {
            for (const agentId of agents) {
                const commands = takeAgentDispatchableCommands(service, runId, agentId);
                assert(commands.length > 0);
                for (const command of commands) {
                    service.receiveClientEnvelope(resultEnvelope(command));
                }
            }
        }
        assertRight(service.startDistributedRun(manifest.distributedRunId));
        if (scheduled) {
            for (const agentId of agents) {
                expect(takeAgentDispatchableCommands(service, runId, agentId)).toEqual([]);
            }
            expect(service.snapshotDistributedRun(manifest.distributedRunId)?.state).toEqual('ready');
            now = 2_000;
            expect(service.snapshotDistributedRun(manifest.distributedRunId)?.state).toEqual('running');
        }
        const queuedAt = now;
        const [senderPrefix] = takeAgentDispatchableCommands(service, runId, agents[0]);
        const [receiverReady] = takeAgentDispatchableCommands(service, runId, agents[1]);
        assert(senderPrefix?.command.kind === 'recipe.run' && senderPrefix.command.recipe);
        assert(receiverReady?.command.kind === 'recipe.run' && receiverReady.command.recipe);
        expect(senderPrefix.command.recipe.recipeId).toEqual('alm-conformance-sender');
        expect(receiverReady.command.recipe.recipeId).toEqual('alm-conformance-receiver');
        expect(senderPrefix.recipeExecution?.segment?.start).toEqual(0);
        expect(senderPrefix.recipeExecution?.segment?.first).toEqual(true);
        expect(receiverReady.recipeExecution?.segment?.start).toEqual(0);
        expect(receiverReady.recipeExecution?.segment?.first).toEqual(true);

        const roots = service.snapshotRun(runId)!.commands.map((command) => command.envelope);
        const sender = roots.find((root) => root.command.kind === 'recipe.run' && root.command.recipe?.recipeId === 'alm-conformance-sender');
        const receiver = roots.find((root) => root.command.kind === 'recipe.run' && root.command.recipe?.recipeId === 'alm-conformance-receiver');
        assert(sender?.command.kind === 'recipe.run' && sender.command.recipe);
        assert(receiver?.command.kind === 'recipe.run' && receiver.command.recipe);
        const pair = toAlmReloadPair(sender.command);
        assert(pair);
        expect(toAlmReloadPair(receiver.command)).toEqual(pair);
        expect(pair.runId).toEqual(runId);
        expect(pair.sender).toEqual({ agentId: agents[0], commandId: sender.commandId });
        expect(pair.receiver).toEqual({ agentId: agents[1], commandId: receiver.commandId });
        expect(sender.command.timeoutMs).toEqual(1_800_000);
        expect(receiver.command.timeoutMs).toEqual(1_800_000);
        expect(pair.checkpoints.length).toEqual(3);
        expect(sender.command.recipe.metadata?.almReloadCheckpoints).toEqual(pair.checkpoints);
        expect(receiver.command.recipe.metadata?.almReloadCheckpoints).toEqual(pair.checkpoints);
        assert(senderPrefix.recipeExecution?.segment);
        expect(senderPrefix.command.recipe.commands[senderPrefix.recipeExecution.segment.end - 1]?.commandId).toEqual(pair.checkpoints[0].senderPrefixEnd);
        expect(senderPrefix.command.recipe).toEqual(sender.command.recipe);
        assert(receiverReady.recipeExecution?.segment);
        expect(receiverReady.command.recipe.commands[receiverReady.recipeExecution.segment.end - 1]?.commandId).toEqual(pair.checkpoints[0].receiverReadyEnd);
        expect(receiverReady.command.recipe).toEqual(receiver.command.recipe);
        expect(takeAgentDispatchableCommands(service, runId, agents[1])).toEqual([]);

        let prefixStart = 0;
        const carriers = ['ws', 'rtc', 'rtc-with-ws-fallback'] as const;
        const commands: RallarBlackBoxTestRecipe['commands'] = sender.command.recipe.commands;
        for (const [index, checkpoint] of pair.checkpoints.entries()) {
            const prefixEnd = commands.findIndex((command) => command.commandId === checkpoint.senderPrefixEnd);
            const reloadIndex = commands.findIndex((command) => command.commandId === checkpoint.senderReload);
            const suffixEnd = commands.findIndex((command) => command.commandId === checkpoint.senderSuffixEnd);
            const prefix = commands.slice(prefixStart, prefixEnd + 1);
            const originals = prefix.filter(isRallarBlackBoxTestMessagesSendCommand);
            expect(originals.map((command) => command.carrier)).toEqual([carriers[index]]);
            expect(reloadIndex).toEqual(prefixEnd + 1);
            expect(commands[reloadIndex]?.kind).toEqual('agent.reload');
            const suffix = commands.slice(reloadIndex + 1, suffixEnd + 1);
            const reconnect = suffix[0];
            assert(reconnect?.kind === 'rtc.connect');
            expect(reconnect.transport).toEqual('messages.rtc');
            expect(reconnect.rallar?.messageSelector).toEqual({ topicId: 'room.alm-conformance' });
            expect(reconnect.rallar?.username).toEqual('');
            expect(reconnect.rallar?.password).toEqual('');
            expect(reconnect.rallar?.restoreSession).toEqual(true);
            expect(reconnect.readiness?.minReadyPeers).toEqual(1);
            expect(suffix.filter((command) => command.kind === 'messages.send')).toEqual([]);
            prefixStart = suffixEnd + 1;
        }
        expect(takeAgentDispatchableCommands(service, runId, agents[0])).toEqual([]);
        now = queuedAt + 1_799_999;
        takeAgentDispatchableCommands(service, runId, agents[0]);
        expect(service.snapshotRun(runId)!.results.find((result) => result.commandId === sender.commandId)).toEqual(undefined);
        now = queuedAt + 1_800_000;
        takeAgentDispatchableCommands(service, runId, agents[0]);
        const expired = service.snapshotRun(runId)!.results.find((result) => result.commandId === sender.commandId);
        expect(expired?.result?.error?.code).toEqual('RALLAR_BLACK_BOX_RECIPE_TIMEOUT');
    });
}

for (const invalid of ['budget', 'peer'] as const) {
    test(`generated paired start rejects a missing ${invalid} before queueing either root`, () => {
        const source = createAlmConformance2AgentEntry().manifest;
        const manifest = {
            ...source,
            barrier: { enabled: false as const },
            metadata: invalid === 'budget' ? {} : source.metadata,
            recipes: invalid === 'peer'
                ? source.recipes.map((selection) => ({
                    ...selection,
                    recipe: selection.role === 'receiver' && selection.recipe
                        ? { ...selection.recipe, metadata: { profile: 'alm-conformance' } }
                        : selection.recipe
                }))
                : source.recipes
        };
        const service = createRallarBlackBoxControlService(toControlServiceInput());
        for (const agentId of ['controller-01', 'controller-02']) {
            service.receiveClientEnvelope(toRegisterEnvelope({
                runId: manifest.controlRunId,
                agentId,
                identity: toFleetIdentity(agentId, manifest.group)
            }));
        }
        assertRight(service.createDistributedRun(manifest));
        assertRight(service.stageDistributedRun(manifest.distributedRunId));
        for (const agentId of ['controller-01', 'controller-02']) {
            for (const stage of takeAgentDispatchableCommands(service, manifest.controlRunId, agentId)) {
                service.receiveClientEnvelope(resultEnvelope(stage));
            }
        }
        const rejected = service.startDistributedRun(manifest.distributedRunId);
        expect(rejected.left?.code).toEqual('command-payload-conflict');
        expect(service.snapshotRun(manifest.controlRunId)?.commands.filter((entry) => entry.envelope.command.kind === 'recipe.run')).toEqual([]);
    });
}

for (const wrongIdentity of [false, true]) {
    test(`lifecycle-only ALM assessment ${wrongIdentity ? 'rejects wrong identity' : 'passes actual identity'} through bounded restore`, () => {
        const manifest = toLifecycleManifest();
        const runId = manifest.controlRunId;
        const agents = ['controller-01', 'controller-02'];
        const input = toControlServiceInput({ runtimeRetentionBounds: { commands: 0, results: 0 } });
        let service = createRallarBlackBoxControlService(input);
        for (const agentId of agents) {
            service.receiveClientEnvelope(toRegisterEnvelope({
                runId,
                agentId,
                identity: toFleetIdentity(agentId, manifest.group)
            }));
        }
        assertRight(service.createDistributedRun(manifest));
        assertRight(service.stageDistributedRun(manifest.distributedRunId));
        for (const agentId of agents) {
            for (const command of takeAgentDispatchableCommands(service, runId, agentId)) {
                service.receiveClientEnvelope(resultEnvelope(command));
            }
        }
        for (const agentId of agents) {
            for (const command of takeAgentDispatchableCommands(service, runId, agentId)) {
                service.receiveClientEnvelope(resultEnvelope(command));
            }
        }
        assertRight(service.startDistributedRun(manifest.distributedRunId));
        const sender = takeAgentDispatchableCommands(service, runId, agents[0])[0];
        const receiver = takeAgentDispatchableCommands(service, runId, agents[1])[0];
        assert(sender && receiver);
        const senderRecipe = manifest.recipes.find((selection) => selection.recipe?.recipeId === 'alm-conformance-sender')!.recipe!;
        const receiverRecipe = manifest.recipes.find((selection) => selection.recipe?.recipeId === 'alm-conformance-receiver')!.recipe!;
        service.receiveClientEnvelope(resultEnvelope(sender, senderRecipe));
        const snapshot = service.snapshot({ commands: 0, results: 0 });
        assert(snapshot.runs[0].results.some((result) => result.commandId === sender.commandId));
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(snapshot);
        service.receiveClientEnvelope(resultEnvelope(receiver, receiverRecipe, wrongIdentity));
        const completed = service.snapshotDistributedRun(manifest.distributedRunId);
        expect(completed?.state).toEqual(wrongIdentity ? 'failed' : 'passed');
        expect(completed?.rollup.ok).toEqual(!wrongIdentity);
        expect(service.snapshot({ commands: 0, results: 0 }).runs[0].results.length).toEqual(0);
    });
}

test('three-role ALM assessment accepts a complete recipient-b envelope (D45)', () => {
    expect(toThreeRoleLifecycleOutcome(undefined)).toEqual({ state: 'passed', ok: true });
});

test('three-role ALM assessment rejects a malformed recipient-b envelope (D45)', () => {
    expect(toThreeRoleLifecycleOutcome('controller-03')).toEqual({ state: 'failed', ok: false });
});

test('independent local ALM roots keep actual child evidence only within normal finite limits', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ runtimeRetentionBounds: { commands: 1, results: 1 } }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    const recipe = toLifecycleManifest().recipes[0].recipe!;
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'local', command: { kind: 'recipe.run', recipe } }));
    const root = takeAgentDispatchableCommands(service, 'run-1', 'agent-1')[0];
    service.receiveClientEnvelope(resultEnvelope(root, recipe));
    const recorded = service.snapshotRun('run-1')!.results[0].result?.value;
    assert(isJsonRecordValue(recorded) && Array.isArray(recorded.results));
    expect(recorded.results.length).toEqual(recipe.commands.length);
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'next', command: { kind: 'health' } }));
    service.receiveClientEnvelope(resultEnvelope(takeAgentDispatchableCommands(service, 'run-1', 'agent-1')[0]));
    expect(service.snapshotRun('run-1')!.results.map((result) => result.commandId)).toEqual(['next']);
});

/** Synthetic lifecycle outcomes exercise identity/retention only; full reload uses the unmodified generated manifest above. */
function toLifecycleManifest(): RallarBlackBoxDistributedRunManifest {
    const manifest = createAlmConformance2AgentEntry().manifest;
    const scenarios = (['ws', 'rtc', 'rtc-with-ws-fallback'] as const).map((carrier) =>
        createAlmConformanceRecipes({
            group: manifest.group,
            carrier,
            typeId: 'alm.conformance',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000,
            laneFamilies: ['two-agent'],
            principalIdsByRole: {}
        }).find((scenario) => scenario.scenarioId === 'delivery-lifecycle')!
    );
    return {
        ...manifest,
        metadata: { ...manifest.metadata, scenarios: ['delivery-lifecycle'] },
        recipes: manifest.recipes.map((selection) => {
            const role = selection.role === 'sender' ? 'sender' : 'receiver';
            return {
                ...selection,
                recipe: {
                    schemaVersion: 1 as const,
                    recipeId: `alm-conformance-${role}`,
                    continueOnFailure: false,
                    metadata: { profile: 'alm-conformance', role },
                    commands: scenarios.flatMap((scenario) => scenario[role].commands)
                }
            };
        })
    };
}

interface LifecycleAssessmentOutcome {
    readonly state: RallarBlackBoxDistributedRunState | undefined;
    readonly ok: boolean | undefined;
}

/** Stages, releases and starts the three-role run, then answers each root with its own recipe evidence. */
function toThreeRoleLifecycleOutcome(malformedAgentId: string | undefined): LifecycleAssessmentOutcome {
    const manifest = toThreeRoleLifecycleManifest();
    const runId = manifest.controlRunId;
    const agents = ['controller-01', 'controller-02', 'controller-03'];
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    agents.forEach((agentId) => service.receiveClientEnvelope(toRegisterEnvelope({ runId, agentId, identity: toFleetIdentity(agentId, manifest.group) })));
    assertRight(service.createDistributedRun(manifest));
    assertRight(service.stageDistributedRun(manifest.distributedRunId));
    const acknowledgeDispatched = () =>
        agents.flatMap((agentId) => takeAgentDispatchableCommands(service, runId, agentId))
            .forEach((command) => service.receiveClientEnvelope(resultEnvelope(command)));
    acknowledgeDispatched();
    acknowledgeDispatched();
    assertRight(service.startDistributedRun(manifest.distributedRunId));
    agents.forEach((agentId) => {
        const [root] = takeAgentDispatchableCommands(service, runId, agentId);
        assert(root?.command.kind === 'recipe.run' && root.command.recipe);
        const recipe = root.command.recipe;
        service.receiveClientEnvelope(resultEnvelope(root, agentId === malformedAgentId ? { ...recipe, commands: [] } : recipe));
    });
    const completed = service.snapshotDistributedRun(manifest.distributedRunId);
    return { state: completed?.state, ok: completed?.rollup.ok };
}

/** The lifecycle manifest with a third agent that runs what the receiver runs, as the declared `recipient-b`. */
function toThreeRoleLifecycleManifest(): RallarBlackBoxDistributedRunManifest {
    const manifest = toLifecycleManifest();
    const receiver = manifest.recipes.find((selection) => selection.role === 'receiver')!;
    const recipientB = {
        ...receiver,
        recipeId: 'alm-conformance-recipient-b',
        role: 'recipient-b',
        recipe: { ...receiver.recipe!, recipeId: 'alm-conformance-recipient-b', metadata: { profile: 'alm-conformance', role: 'recipient-b' } }
    };
    return {
        ...manifest,
        recipes: [...manifest.recipes, recipientB],
        targetPolicy: {
            mode: 'role-map' as const,
            expectedParticipantCount: 3,
            roles: { sender: ['controller-01'], receiver: ['controller-02'], 'recipient-b': ['controller-03'] }
        },
        roleAssignments: [
            ...manifest.roleAssignments,
            { role: 'recipient-b', agentId: 'controller-03', recipeIds: [], variables: {} }
        ]
    };
}

function resultEnvelope(
    envelope: ControlCommandEnvelope,
    recipe?: RallarBlackBoxTestRecipe,
    wrongIdentity = false
): ControlResultEnvelope {
    const result: RallarBlackBoxTestResult = {
        commandId: envelope.commandId,
        kind: envelope.command.kind,
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1,
        endedAtEpochMs: 2,
        durationMs: 1,
        value: recipe
            ? {
                recipeId: recipe.recipeId,
                results: recipe.commands.map((command) => {
                    const payload = isRallarBlackBoxTestMessagesSendCommand(command)
                        ? command.payload
                        : command.kind === 'wait'
                        ? command.match.equals
                        : undefined;
                    const identity = isJsonRecordValue(payload) ? JSON.stringify(payload) : undefined;
                    // The fabricated identity is the payload's text, so its trace keeps that text to the trace grammar:
                    // its characters and its 128-character bound.
                    const traceId = identity?.replaceAll(/[^A-Za-z0-9_-]/gu, '_').slice(0, 128);
                    return {
                        commandId: command.commandId,
                        kind: command.kind,
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 1,
                        endedAtEpochMs: 2,
                        durationMs: 1,
                        value: command.kind === 'messages.send' ? { msgId: identity, traceId, corrId: identity } : command.kind === 'wait'
                            ? {
                                matched: true,
                                event: {
                                    payload: {
                                        data: {
                                            msgId: wrongIdentity ? 'unrelated' : identity,
                                            transport: isJsonRecordValue(payload) && payload.carrier === 'ws' ? 'ws' : 'rtc',
                                            typeId: isJsonRecordValue(payload) ? `alm.conformance.${payload.carrier}.delivery-lifecycle` : '',
                                            payload,
                                            traceId,
                                            corrId: identity
                                        }
                                    }
                                }
                            }
                            : command.kind === 'messages.receipts'
                            ? toReceiptsFabricatedValue(command, recipe)
                            : command.kind === 'rtc.connect'
                            ? { sessionId: toFabricatedSessionId(recipe) }
                            : {}
                    };
                })
            }
            : {}
    };
    return { kind: 'result', protocolVersion: 1, runId: envelope.runId, agentId: envelope.agentId!, commandId: envelope.commandId, ok: true, result };
}

/**
 * D28: the sender's receipts are read after the whole scenario and correlated by handle id
 * (`assessAlmAcknowledgedIdentity`). A ws submission names no hop: its server receipt confirms the session of the
 * receiver as its logical recipient. A non-ws submission confirms its receiver hop.
 */
function toReceiptsFabricatedValue(
    command: RallarBlackBoxTestMessagesReceiptsCommand,
    recipe: RallarBlackBoxTestRecipe
): RallarBlackBoxTestMessagesObserveResultValue {
    const send = recipe.commands.filter(isRallarBlackBoxTestMessagesSendCommand).find((candidate) => candidate.handleId === command.handleId);
    const confirmed = send?.carrier === 'ws' ? ['receiver-session'] : ['peer'];
    return {
        handleId: command.handleId,
        state: 'acknowledged',
        submitted: true,
        enqueued: true,
        receiptMode: send?.carrier === 'ws' ? 'receiver' : 'hop',
        confirmedHopPeerIds: send?.carrier === 'ws' ? [] : confirmed,
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: confirmed,
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: [],
        outsideAudienceRecipientPeerIds: [],
        attempts: 1,
        attemptOutcomes: ['sent'],
        attemptCarriers: [send?.carrier === 'ws' ? 'ws' : 'rtc'],
        attemptRefusalReasons: [],
        relayRejection: undefined,
        carrierFallback: undefined,
        durabilityDowngrade: undefined,
        failure: undefined,
        reason: undefined
    };
}

function toFabricatedSessionId(recipe: RallarBlackBoxTestRecipe): string {
    return `${recipe.metadata?.role}-session`;
}

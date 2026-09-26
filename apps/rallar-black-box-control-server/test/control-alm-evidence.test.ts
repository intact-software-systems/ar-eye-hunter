import { assert, assertEquals } from '@std/assert';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import type { RallarBlackBoxTestMessagesObserveResultValue } from '@shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts';
import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
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

for (const scheduled of [false, true]) {
    Deno.test(`generated full ALM ${scheduled ? 'scheduled' : 'manual'} start preserves paired recovery connections and execution budget`, () => {
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
                const commands = service.takeDispatchableCommands(runId, agentId);
                assert(commands.length > 0, `${phase} must reach ${agentId}`);
                for (const command of commands) {
                    service.receiveClientEnvelope(resultEnvelope(command));
                }
            }
        }
        assertRight(service.startDistributedRun(manifest.distributedRunId));
        if (scheduled) {
            for (const agentId of agents) {
                assertEquals(service.takeDispatchableCommands(runId, agentId), [], 'scheduled start remains a not-before gate');
            }
            assertEquals(service.snapshotDistributedRun(manifest.distributedRunId)?.state, 'ready');
            now = 2_000;
            assertEquals(service.snapshotDistributedRun(manifest.distributedRunId)?.state, 'running');
        }
        const queuedAt = now;
        const [senderPrefix] = service.takeDispatchableCommands(runId, agents[0]);
        const [receiverReady] = service.takeDispatchableCommands(runId, agents[1]);
        assert(senderPrefix?.command.kind === 'recipe.run' && senderPrefix.command.recipe);
        assert(receiverReady?.command.kind === 'recipe.run' && receiverReady.command.recipe);
        assert(
            senderPrefix.command.recipe.recipeId !== 'alm-conformance-sender',
            'generated hosted start must dispatch the held-original prefix, not the entire sender recipe'
        );
        assert(
            receiverReady.command.recipe.recipeId !== 'alm-conformance-receiver',
            'receiver readiness must finish before its separately gated absence window'
        );

        const roots = service.snapshotRun(runId)!.commands.map((command) => command.envelope);
        const sender = roots.find((root) => root.command.kind === 'recipe.run' && root.command.recipe?.recipeId === 'alm-conformance-sender');
        const receiver = roots.find((root) => root.command.kind === 'recipe.run' && root.command.recipe?.recipeId === 'alm-conformance-receiver');
        assert(sender?.command.kind === 'recipe.run' && sender.command.recipe);
        assert(receiver?.command.kind === 'recipe.run' && receiver.command.recipe);
        const pair = toAlmReloadPair(sender.command);
        assert(pair, 'actual hosted roots must bind the generated checkpoints');
        assertEquals(toAlmReloadPair(receiver.command), pair);
        assertEquals(pair.runId, runId);
        assertEquals(pair.sender, { agentId: agents[0], commandId: sender.commandId });
        assertEquals(pair.receiver, { agentId: agents[1], commandId: receiver.commandId });
        assertEquals(sender.command.timeoutMs, 300_000);
        assertEquals(receiver.command.timeoutMs, 300_000);
        assertEquals(pair.checkpoints.length, 3, 'one full reload specimen per supported carrier');
        assertEquals(sender.command.recipe.metadata?.almReloadCheckpoints, pair.checkpoints);
        assertEquals(receiver.command.recipe.metadata?.almReloadCheckpoints, pair.checkpoints);
        assertEquals(senderPrefix.command.recipe.commands.at(-1)?.commandId, pair.checkpoints[0].senderPrefixEnd);
        assertEquals(receiverReady.command.recipe.commands.at(-1)?.commandId, pair.checkpoints[0].receiverReadyEnd);

        let prefixStart = 0;
        const carriers = ['ws', 'rtc', 'rtc-with-ws-fallback'];
        const commands: RallarBlackBoxTestRecipe['commands'] = sender.command.recipe.commands;
        for (const [index, checkpoint] of pair.checkpoints.entries()) {
            const prefixEnd = commands.findIndex((command) => command.commandId === checkpoint.senderPrefixEnd);
            const reloadIndex = commands.findIndex((command) => command.commandId === checkpoint.senderReload);
            const suffixEnd = commands.findIndex((command) => command.commandId === checkpoint.senderSuffixEnd);
            const prefix = commands.slice(prefixStart, prefixEnd + 1);
            const originals = prefix.filter(isRallarBlackBoxTestMessagesSendCommand);
            assertEquals(originals.map((command) => command.carrier), [carriers[index]], 'reload precedes ordinary scenario work');
            assertEquals(reloadIndex, prefixEnd + 1);
            assertEquals(commands[reloadIndex]?.kind, 'agent.reload');
            const suffix = commands.slice(reloadIndex + 1, suffixEnd + 1);
            const reconnect = suffix[0];
            assert(reconnect?.kind === 'rtc.connect', 'fresh document reconnect must survive combined composition');
            assertEquals(reconnect.transport, 'messages.rtc');
            assertEquals(reconnect.rallar?.messageSelector, { topicId: 'room.alm-conformance' });
            assertEquals(reconnect.rallar?.username, '');
            assertEquals(reconnect.rallar?.password, '');
            assertEquals(reconnect.rallar?.restoreSession, true);
            assertEquals(reconnect.readiness?.minReadyPeers, 1);
            assertEquals(suffix.filter((command) => command.kind === 'messages.send'), [], 'recovery must not resend the original');
            prefixStart = suffixEnd + 1;
        }
        assertEquals(service.takeDispatchableCommands(runId, agents[0]), [], 'no reload while the initial prefix is incomplete');
        now = queuedAt + 299_999;
        service.takeDispatchableCommands(runId, agents[0]);
        assertEquals(
            service.snapshotRun(runId)!.results.find((result) => result.commandId === sender.commandId),
            undefined,
            'the actual root remains pending within its original execution budget'
        );
        now = queuedAt + 300_000;
        service.takeDispatchableCommands(runId, agents[0]);
        const expired = service.snapshotRun(runId)!.results.find((result) => result.commandId === sender.commandId);
        assertEquals(expired?.result?.error?.code, 'RALLAR_BLACK_BOX_RECIPE_TIMEOUT', 'dispatch does not reset or extend the original queued budget');
    });
}

for (const invalid of ['budget', 'peer'] as const) {
    Deno.test(`generated paired start rejects a missing ${invalid} before queueing either root`, () => {
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
            for (const stage of service.takeDispatchableCommands(manifest.controlRunId, agentId)) {
                service.receiveClientEnvelope(resultEnvelope(stage));
            }
        }
        const rejected = service.startDistributedRun(manifest.distributedRunId);
        assertEquals(rejected.left?.code, 'command-payload-conflict');
        assertEquals(
            service.snapshotRun(manifest.controlRunId)?.commands.filter((entry) => entry.envelope.command.kind === 'recipe.run'),
            [],
            'invalid pairing must not queue a one-sided root'
        );
    });
}

for (const wrongIdentity of [false, true]) {
    Deno.test(`lifecycle-only ALM assessment ${wrongIdentity ? 'rejects wrong identity' : 'passes actual identity'} through bounded restore`, () => {
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
            for (const command of service.takeDispatchableCommands(runId, agentId)) {
                service.receiveClientEnvelope(resultEnvelope(command));
            }
        }
        for (const agentId of agents) {
            for (const command of service.takeDispatchableCommands(runId, agentId)) {
                service.receiveClientEnvelope(resultEnvelope(command));
            }
        }
        assertRight(service.startDistributedRun(manifest.distributedRunId));
        const sender = service.takeDispatchableCommands(runId, agents[0])[0];
        const receiver = service.takeDispatchableCommands(runId, agents[1])[0];
        assert(sender && receiver);
        const senderRecipe = manifest.recipes.find((selection) => selection.recipe?.recipeId === 'alm-conformance-sender')!.recipe!;
        const receiverRecipe = manifest.recipes.find((selection) => selection.recipe?.recipeId === 'alm-conformance-receiver')!.recipe!;
        service.receiveClientEnvelope(resultEnvelope(sender, senderRecipe));
        const snapshot = service.snapshot({ commands: 0, results: 0 });
        assert(snapshot.runs[0].results.some((result) => result.commandId === sender.commandId), 'pending sender evidence survives bounds');
        service = createRallarBlackBoxControlService(input);
        service.restoreSnapshot(snapshot);
        service.receiveClientEnvelope(resultEnvelope(receiver, receiverRecipe, wrongIdentity));
        const completed = service.snapshotDistributedRun(manifest.distributedRunId);
        assertEquals(completed?.state, wrongIdentity ? 'failed' : 'passed');
        assertEquals(completed?.rollup.ok, !wrongIdentity);
        assertEquals(service.snapshot({ commands: 0, results: 0 }).runs[0].results.length, 0, 'terminal evidence obeys bounds');
    });
}

Deno.test('independent local ALM roots keep actual child evidence only within normal finite limits', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ runtimeRetentionBounds: { commands: 1, results: 1 } }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    const recipe = toLifecycleManifest().recipes[0].recipe!;
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'local', command: { kind: 'recipe.run', recipe } }));
    const root = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(resultEnvelope(root, recipe));
    const recorded = service.snapshotRun('run-1')!.results[0].result?.value;
    assert(isJsonRecordValue(recorded) && Array.isArray(recorded.results));
    assertEquals(recorded.results.length, recipe.commands.length);
    assertRight(service.enqueueCommand({ runId: 'run-1', agentId: 'agent-1', commandId: 'next', command: { kind: 'health' } }));
    service.receiveClientEnvelope(resultEnvelope(service.takeDispatchableCommands('run-1', 'agent-1')[0]));
    assertEquals(service.snapshotRun('run-1')!.results.map((result) => result.commandId), ['next']);
});

/** Synthetic lifecycle outcomes exercise identity/retention only; full reload uses the unmodified generated manifest above. */
function toLifecycleManifest() {
    const manifest = createAlmConformance2AgentEntry().manifest;
    const scenarios = (['ws', 'rtc', 'rtc-with-ws-fallback'] as const).map((carrier) =>
        createAlmConformanceRecipes({
            group: manifest.group,
            carrier,
            typeId: 'alm.conformance',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
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
                    return {
                        commandId: command.commandId,
                        kind: command.kind,
                        status: 'ok',
                        ok: true,
                        startedAtEpochMs: 1,
                        endedAtEpochMs: 2,
                        durationMs: 1,
                        value: command.kind === 'messages.send' ? { msgId: identity } : command.kind === 'wait'
                            ? {
                                matched: true,
                                event: {
                                    payload: {
                                        data: {
                                            msgId: wrongIdentity ? 'unrelated' : identity,
                                            transport: isJsonRecordValue(payload) && payload.carrier === 'ws' ? 'ws' : 'rtc',
                                            typeId: isJsonRecordValue(payload) ? `alm.conformance.${payload.carrier}.delivery-lifecycle` : '',
                                            payload
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
        attempts: 1,
        attemptOutcomes: ['sent'],
        relayRejection: undefined,
        reason: undefined
    };
}

function toFabricatedSessionId(recipe: RallarBlackBoxTestRecipe): string {
    return `${recipe.metadata?.role}-session`;
}

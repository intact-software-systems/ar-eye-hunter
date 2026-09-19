import type { ControlCommandEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { assert, assertEquals } from '@std/assert';

import { createAlmConformance2AgentEntry } from '../../rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { assertRight, toControlServiceInput, toFleetIdentity, toRegisterEnvelope } from './support/control-service-test-fixtures.ts';

for (const wrongIdentity of [false, true]) {
    Deno.test(`combined ALM assessment ${wrongIdentity ? 'rejects wrong identity' : 'passes actual identity'} through bounded restore`, () => {
        const manifest = createAlmConformance2AgentEntry().manifest;
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
                    const payload = command.kind === 'messages.send' ? command.payload : command.kind === 'wait' ? command.match.equals : undefined;
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
                            : {}
                    };
                })
            }
            : {}
    };
    return { kind: 'result', protocolVersion: 1, runId: envelope.runId, agentId: envelope.agentId!, commandId: envelope.commandId, ok: true, result };
}

Deno.test('independent local ALM roots keep actual child evidence only within normal finite limits', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ runtimeRetentionBounds: { commands: 1, results: 1 } }));
    service.receiveClientEnvelope(toRegisterEnvelope());
    const recipe = createAlmConformance2AgentEntry().manifest.recipes[0].recipe!;
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

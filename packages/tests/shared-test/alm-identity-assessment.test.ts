import { describe, expect, it } from 'vitest';

import { assessAlmConformanceIdentity } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-conformance-identity.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

const scenario = createAlmConformanceRecipes({
    group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
    carrier: 'ws',
    typeId: 'identity',
    senderConnection: 'sender',
    receiverConnection: 'receiver',
    deadlineMs: 18_000
}).find((candidate) => candidate.scenarioId === 'delivery-lifecycle')!;

describe('actual ALM recipe identity assessment', () => {
    it('joins actual sender IDs and matching receiver envelopes', async () => {
        expect(assessAlmConformanceIdentity(await evidence())).toEqual([]);
    });

    it.each(
        ['wrong-id', 'same-old-id', 'failed-child', 'missing-child', 'duplicate-child', 'compacted', 'wrong-agent', 'wrong-run', 'wrong-transport'] as const
    )(
        'rejects %s even with successful outer envelopes',
        async (defect) => {
            const input = await evidence();
            const receiver = input.participants[1];
            const root = receiver.result.result!;
            const value = root.value as { results: RallarBlackBoxTestResult[]; };
            const results = [...value.results];
            const index = results.findIndex((result) => result.commandId.endsWith('receive-replacement'));
            if (defect === 'wrong-id' || defect === 'same-old-id') {
                const recorded = results[index].value as { event: { payload: { data: { msgId: string; }; }; }; };
                recorded.event.payload.data.msgId = defect === 'wrong-id' ? 'unrelated-message' : 'send-3';
            }
            if (defect === 'wrong-transport') {
                const recorded = results[index].value as { event: { payload: { data: { transport: string; }; }; }; };
                recorded.event.payload.data.transport = 'rtc';
            }
            if (defect === 'failed-child') {
                results[index] = { ...results[index], ok: false, status: 'failed' };
            }
            if (defect === 'missing-child') {
                results.splice(index, 1);
            }
            if (defect === 'duplicate-child') {
                results.push(results[index]);
            }
            const modified: ControlResultEnvelope = {
                ...receiver.result,
                ...(defect === 'wrong-agent' ? { agentId: 'another' } : {}),
                ...(defect === 'wrong-run' ? { runId: 'another' } : {}),
                result: { ...root, value: defect === 'compacted' ? { recipeId: scenario.receiver.recipeId, resultsOmitted: true } : { ...value, results } }
            };
            expect(assessAlmConformanceIdentity({ ...input, participants: [input.participants[0], { ...receiver, result: modified }] })).not.toEqual([]);
        }
    );
});

async function evidence() {
    return {
        runId: 'run',
        participants: await Promise.all((['sender', 'receiver'] as const).map(async (role) => ({
            role,
            agentId: role,
            commandId: `${role}-root`,
            recipe: scenario[role],
            result: await executeRecipe(scenario[role], role)
        })))
    };
}

async function executeRecipe(recipe: RallarBlackBoxTestRecipe, role: 'sender' | 'receiver'): Promise<ControlResultEnvelope> {
    const runtime = createRallarBlackBoxTestRuntime({
        sleep: async () => {},
        commandExecutor: async (command) => {
            if (command.kind === 'assert' || command.kind === 'wait' || command.kind === 'recipe.run') {
                return undefined;
            }
            if (command.kind === 'messages.send') {
                return { status: 'ok', value: { msgId: `send-${command.commandId!.slice(-1)}` } };
            }
            if (command.kind === 'messages.observe' || command.kind === 'messages.cancel' || command.kind === 'messages.receipts') {
                const state = command.kind === 'messages.observe'
                    ? command.state.length === 1 && command.state[0] === 'superseded'
                        ? 'superseded'
                        : command.state.includes('transport-accepted') && command.handleId.endsWith('1')
                        ? 'transport-accepted'
                        : 'accepted'
                    : command.kind === 'messages.cancel'
                    ? 'cancelled'
                    : 'transport-accepted';
                return {
                    status: 'ok',
                    value: { state, enqueued: true, submitted: command.handleId.endsWith('1'), confirmedHopPeerIds: [], unconfirmedHopPeerIds: [] }
                };
            }
            return { status: 'ok', value: {} };
        }
    });
    if (role === 'receiver') {
        for (const [specimen, msgId, revision] of [['submission', 'send-1', undefined], ['supersedence', 'send-4', 'replacement']] as const) {
            runtime.recordEvent({
                kind: 'message',
                topic: 'typed',
                connection: 'receiver',
                payload: {
                    data: {
                        msgId,
                        transport: 'ws',
                        typeId: 'identity.ws.delivery-lifecycle',
                        payload: { marker: 'delivery-lifecycle', specimen, carrier: 'ws', ...(revision ? { revision } : {}) }
                    }
                }
            });
        }
    }
    const result = await runtime.execute({ kind: 'recipe.run', commandId: `${role}-root`, recipe });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return { kind: 'result', protocolVersion: 1, runId: 'run', agentId: role, commandId: `${role}-root`, ok: true, result };
}

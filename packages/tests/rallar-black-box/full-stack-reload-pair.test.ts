import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxTestError } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { runRecipePairOnTwoAgents, type RecipePairRun } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';

import { openRecordingControlRequest, type RecordedControlCommand } from './recording-control-request-fixture.ts';

function toRunSnapshot(results: readonly ControlResultEnvelope[]): ControlRunSnapshot {
    return {
        runId: 'actual-local-run',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        agents: [],
        commands: [],
        results: [...results],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

function toRootResult(command: RecordedControlCommand, error: RallarBlackBoxTestError | undefined): ControlResultEnvelope {
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: 'actual-local-run',
        agentId: command.agentId,
        commandId: command.commandId,
        ok: error === undefined,
        ...(error === undefined ? {} : { error })
    };
}

const reloadScenario = createAlmConformanceRecipes({
    group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
    carrier: 'ws',
    typeId: 'probe',
    senderConnection: 'sender',
    receiverConnection: 'receiver',
    deadlineMs: 18_000,
    laneFamilies: ['two-agent'],
    principalIdsByRole: {}
}).find((candidate) => candidate.scenarioId === 'delivery-reload')!;

describe('local paired reload enqueue', () => {
    for (const malformed of [false, true]) {
        it(
            malformed
                ? 'rejects missing peer checkpoints before sending either root'
                : 'binds both actual HTTP addresses before waiting for receiver readiness or a root outcome',
            async () => {
                const scenario = reloadScenario;
                let readBeforeBothEnqueued = false;
                const control = await openRecordingControlRequest('actual-local-run');
                const posted = control.posted;
                const run: RecipePairRun = {
                    request: control.request,
                    runId: 'actual-local-run',
                    sender: { agentId: 'actual-sender' },
                    receiver: { agentId: 'actual-receiver' },
                    startedRoots: [],
                    readSnapshot: async () => {
                        readBeforeBothEnqueued ||= posted.length !== 2;
                        return toRunSnapshot(posted.map((command) => toRootResult(command, undefined)));
                    }
                };
                try {
                    if (malformed) {
                        await expect(runRecipePairOnTwoAgents(run, {
                            sender: scenario.sender,
                            receiver: { ...scenario.receiver, metadata: {} }
                        })).rejects.toThrow('Cannot enqueue paired reload:');
                        expect(posted, 'invalid pairing must not leave a one-sided durable root').toEqual([]);
                        return;
                    }
                    const outcome = await runRecipePairOnTwoAgents(run, scenario);
                    expect(posted.map((command) => new URL(command.url).pathname).sort()).toEqual([
                        '/runs/actual-local-run/agents/actual-receiver/commands',
                        '/runs/actual-local-run/agents/actual-sender/commands'
                    ]);
                    expect(readBeforeBothEnqueued, 'both roots must exist before readiness/result polling').toBe(false);
                    const pair = toAlmReloadPair(posted[0].command);
                    expect(pair).toMatchObject({
                        runId: 'actual-local-run',
                        sender: { agentId: 'actual-sender', commandId: outcome.sender.commandId },
                        receiver: { agentId: 'actual-receiver', commandId: outcome.receiver.commandId }
                    });
                    expect(toAlmReloadPair(posted[1].command)).toEqual(pair);
                    expect(run.startedRoots.map(({ commandId }) => commandId)).toEqual([
                        outcome.sender.commandId,
                        outcome.receiver.commandId
                    ]);
                    expect(posted.map((command) => command.command.timeoutMs)).toEqual([180_000, 180_000]);
                    expect(outcome).toEqual({
                        sender: { commandId: `${scenario.sender.recipeId}-run`, ok: true, summary: 'ok' },
                        receiver: { commandId: `${scenario.receiver.recipeId}-run`, ok: true, summary: 'ok' }
                    });
                }
                finally {
                    vi.restoreAllMocks();
                    await control.close();
                }
            }
        );
    }

    it('keeps the first root, which the owner of the run waits for, when the second enqueue fails', async () => {
        const control = await openRecordingControlRequest('actual-local-run', (recorded) => {
            if (recorded.agentId === 'actual-receiver') {
                throw new Error('The control server refused the receiver\'s root.');
            }
        });
        const run: RecipePairRun = {
            request: control.request,
            runId: 'actual-local-run',
            sender: { agentId: 'actual-sender' },
            receiver: { agentId: 'actual-receiver' },
            startedRoots: [],
            readSnapshot: async () => toRunSnapshot([])
        };
        try {
            await expect(runRecipePairOnTwoAgents(run, reloadScenario)).rejects.toThrow('refused the receiver');

            expect(control.posted.map(({ agentId }) => agentId)).toEqual(['actual-sender', 'actual-receiver']);
            expect(run.startedRoots.map(({ commandId }) => commandId)).toEqual([control.posted[0].commandId]);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('stops a reload pair with no result past its grace through each agent\'s untargeted recipe.cancel', async () => {
        const control = await openRecordingControlRequest('actual-local-run');
        const posted = control.posted;
        let nowEpochMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowEpochMs);
        const cancelledAgents = () => new Set(posted.filter(({ command }) => command.kind === 'recipe.cancel').map(({ agentId }) => agentId));
        // Each read moves the clock 30 s; a root ends only once its own agent was told to cancel.
        const run: RecipePairRun = {
            request: control.request,
            runId: 'actual-local-run',
            sender: { agentId: 'actual-sender' },
            receiver: { agentId: 'actual-receiver' },
            startedRoots: [],
            readSnapshot: async () => {
                nowEpochMs += 30_000;
                const cancelled = cancelledAgents();
                return toRunSnapshot(
                    posted
                        .filter(({ command, agentId }) => command.kind === 'recipe.run' && cancelled.has(agentId))
                        .map((command) => toRootResult(command, { code: 'RALLAR_BLACK_BOX_COMMAND_CANCELLED', message: 'Paired reload stopped.' }))
                );
            }
        };
        try {
            const outcome = await runRecipePairOnTwoAgents(run, reloadScenario);

            const senderRunId = `${reloadScenario.sender.recipeId}-run`;
            const receiverRunId = `${reloadScenario.receiver.recipeId}-run`;
            expect(
                posted.filter(({ command }) => command.kind === 'recipe.cancel').map(({ commandId, agentId, command }) => ({
                    commandId,
                    agentId,
                    targetCommandId: command.kind === 'recipe.cancel' ? command.targetCommandId : 'not a cancel'
                })).toSorted((left, right) => right.agentId.localeCompare(left.agentId))
            ).toEqual([
                { commandId: `cancel-${senderRunId}`, agentId: 'actual-sender', targetCommandId: undefined },
                { commandId: `cancel-${receiverRunId}`, agentId: 'actual-receiver', targetCommandId: undefined }
            ]);
            const cancelled = 'RALLAR_BLACK_BOX_COMMAND_CANCELLED: Paired reload stopped.';
            expect(outcome).toEqual({
                sender: { commandId: senderRunId, ok: false, summary: cancelled },
                receiver: { commandId: receiverRunId, ok: false, summary: cancelled }
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });
});

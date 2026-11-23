import type * as Playwright from '@playwright/test';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxTestError } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { runRecipePairOnTwoAgents, type RecipePairRun } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
import { runRecipeTrioOnSameContext } from '../../../tests/playwright/rallar-black-box/full-stack-same-context-run.ts';

import { openRecordingControlRequest, type RecordedControlCommand } from './recording-control-request-fixture.ts';

const scenarios = createAlmConformanceRecipes({
    group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
    carrier: 'ws',
    typeId: 'cross-cancel',
    senderConnection: 'sender',
    receiverConnection: 'receiver',
    deadlineMs: 18_000,
    laneFamilies: ['two-agent'],
    principalIdsByRole: {}
});
const baseline = scenarios.find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
const reload = scenarios.find((scenario) => scenario.scenarioId === 'delivery-reload')!;
const receiverConnectId = baseline.receiver.commands.find((command) => command.kind === 'rtc.connect')!.commandId!;

const ROLE_FAILURE: RallarBlackBoxTestError = { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message: 'the role\'s wait failed' };
/** What an agent reports for a recipe the lane cancelled. */
const LANE_CANCELLED: RallarBlackBoxTestError = { code: 'RALLAR_BLACK_BOX_COMMAND_CANCELLED', message: 'cancelled by the lane' };

/** How a root started on the run ends: failing at once, passing at once, or only once the lane cancels it. */
type RootEnd = 'fails' | 'passes' | 'runs-until-cancelled';

/**
 * A run whose snapshot holds each started root's result as `ends` states it, read by its run command id, and the
 * receiver's passed connect, which releases its barrier.
 */
function toCrossCancelRun(
    control: Readonly<{ request: Playwright.APIRequestContext; posted: readonly RecordedControlCommand[]; }>,
    ends: ReadonlyMap<string, RootEnd>
): RecipePairRun {
    const toResult = (command: RecordedControlCommand): readonly ControlResultEnvelope[] => {
        const end = ends.get(command.commandId);
        const cancelled = control.posted.some(({ agentId, command: posted }) => posted.kind === 'recipe.cancel' && agentId === command.agentId);
        const error = end === 'fails' ? ROLE_FAILURE : end === 'runs-until-cancelled' && cancelled ? LANE_CANCELLED : undefined;
        if (end === undefined || (end === 'runs-until-cancelled' && !cancelled)) {
            return [];
        }
        return [{
            kind: 'result',
            protocolVersion: 1,
            runId: 'cross-cancel-run',
            agentId: command.agentId,
            commandId: command.commandId,
            ok: error === undefined,
            ...(error === undefined ? {} : { error })
        }];
    };
    return {
        request: control.request,
        runId: 'cross-cancel-run',
        sender: { agentId: 'sender-agent' },
        receiver: { agentId: 'receiver-agent' },
        startedRoots: [],
        readSnapshot: async (): Promise<ControlRunSnapshot> => ({
            runId: 'cross-cancel-run',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
            agents: [],
            commands: [],
            events: [{
                kind: 'event',
                protocolVersion: 1,
                runId: 'cross-cancel-run',
                agentId: 'receiver-agent',
                atEpochMs: 1,
                eventId: 'receiver-connected',
                commandId: receiverConnectId,
                payload: { kind: 'result', topic: 'rallar.bb.command.result', commandId: receiverConnectId, payload: { ok: true } }
            }],
            stats: [],
            reports: [],
            heartbeats: [],
            results: control.posted.filter(({ command }) => command.kind === 'recipe.run').flatMap(toResult)
        })
    };
}

function toPostedCancels(posted: readonly RecordedControlCommand[]) {
    return posted.filter(({ command }) => command.kind === 'recipe.cancel').map(({ agentId, commandId, command }) => ({
        agentId,
        commandId,
        command
    }));
}

describe('a scenario role that ends not ok cancels its peers', () => {
    const senderRunId = `${baseline.sender.recipeId}-run`;
    const receiverRunId = `${baseline.receiver.recipeId}-run`;

    it('leaves a passing pair as it was: no cancel, and neither role cancelled', async () => {
        const control = await openRecordingControlRequest('cross-cancel-run');
        const run = toCrossCancelRun(control, new Map([[senderRunId, 'passes'], [receiverRunId, 'passes']]));
        try {
            const outcome = await runRecipePairOnTwoAgents(run, baseline);

            expect(control.posted.map(({ command }) => command.kind)).toEqual(['recipe.run', 'recipe.run']);
            expect(outcome).toStrictEqual({
                sender: { commandId: senderRunId, ok: true, summary: 'ok', cancelledAfter: undefined },
                receiver: { commandId: receiverRunId, ok: true, summary: 'ok', cancelledAfter: undefined }
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('cancels the pair\'s sender with its targeted cancel once the receiver failed, keeping the receiver\'s own error', async () => {
        const control = await openRecordingControlRequest('cross-cancel-run');
        const run = toCrossCancelRun(control, new Map([[senderRunId, 'runs-until-cancelled'], [receiverRunId, 'fails']]));
        try {
            const outcome = await runRecipePairOnTwoAgents(run, baseline);

            expect(toPostedCancels(control.posted)).toEqual([{
                agentId: 'sender-agent',
                commandId: `cancel-${senderRunId}`,
                command: {
                    kind: 'recipe.cancel',
                    targetCommandId: senderRunId,
                    reason: `${senderRunId} cancelled after ${receiverRunId} ended not ok.`
                }
            }]);
            expect(outcome).toStrictEqual({
                sender: {
                    commandId: senderRunId,
                    ok: false,
                    summary: 'RALLAR_BLACK_BOX_COMMAND_CANCELLED: cancelled by the lane',
                    cancelledAfter: receiverRunId
                },
                receiver: {
                    commandId: receiverRunId,
                    ok: false,
                    summary: 'RALLAR_BLACK_BOX_COMMAND_FAILED: the role\'s wait failed',
                    cancelledAfter: undefined
                }
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('cancels a reload pair\'s receiver through its agent\'s untargeted cancel once the sender failed', async () => {
        const reloadSenderRunId = `${reload.sender.recipeId}-run`;
        const reloadReceiverRunId = `${reload.receiver.recipeId}-run`;
        const control = await openRecordingControlRequest('cross-cancel-run');
        const run = toCrossCancelRun(
            control,
            new Map([[reloadSenderRunId, 'fails'], [reloadReceiverRunId, 'runs-until-cancelled']])
        );
        try {
            const outcome = await runRecipePairOnTwoAgents(run, reload);

            expect(toPostedCancels(control.posted)).toEqual([{
                agentId: 'receiver-agent',
                commandId: `cancel-${reloadReceiverRunId}`,
                command: {
                    kind: 'recipe.cancel',
                    reason: `${reloadReceiverRunId} cancelled after ${reloadSenderRunId} ended not ok.`
                }
            }]);
            expect(outcome.sender).toMatchObject({ ok: false, summary: 'RALLAR_BLACK_BOX_COMMAND_FAILED: the role\'s wait failed' });
            expect(outcome.receiver).toMatchObject({ ok: false, cancelledAfter: reloadSenderRunId });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('cancels the same-context receiver and the successor started after the owner failed, each as cancelled after the owner', async () => {
        const successor = { ...baseline.sender, recipeId: `${baseline.sender.recipeId}-successor` };
        const successorRunId = `${successor.recipeId}-run`;
        const control = await openRecordingControlRequest('cross-cancel-run');
        const run = toCrossCancelRun(
            control,
            new Map([
                [senderRunId, 'fails'],
                [receiverRunId, 'runs-until-cancelled'],
                [successorRunId, 'runs-until-cancelled']
            ])
        );
        // The owner's page ends by a close and nothing else of it is read.
        const ownerPage = { close: async () => undefined } as Playwright.Page;
        try {
            const outcome = await runRecipeTrioOnSameContext(
                run,
                {
                    owner: { ...run.sender, page: ownerPage },
                    successor: { agentId: 'successor-agent' },
                    ownerEnd: 'close',
                    successorGate: undefined
                },
                { sender: baseline.sender, receiver: baseline.receiver, successor }
            );

            expect(toPostedCancels(control.posted).map(({ commandId }) => commandId).toSorted()).toEqual(
                [`cancel-${receiverRunId}`, `cancel-${successorRunId}`].toSorted()
            );
            expect(outcome.sender).toMatchObject({ ok: false, cancelledAfter: undefined });
            expect(outcome.receiver).toMatchObject({ ok: false, cancelledAfter: senderRunId });
            expect(outcome.successor).toMatchObject({ ok: false, cancelledAfter: senderRunId });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });
});

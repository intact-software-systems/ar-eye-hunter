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
const ROLE_FAILURE_SUMMARY = `${ROLE_FAILURE.code}: ${ROLE_FAILURE.message}`;
const LANE_CANCELLED_SUMMARY = `${LANE_CANCELLED.code}: ${LANE_CANCELLED.message}`;

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

function toPostedRuns(posted: readonly RecordedControlCommand[]): readonly string[] {
    return posted.filter(({ command }) => command.kind === 'recipe.run').map(({ commandId }) => commandId);
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
    const successor = { ...baseline.sender, recipeId: `${baseline.sender.recipeId}-successor` };
    const successorRunId = `${successor.recipeId}-run`;
    // The owner's page ends by a close and nothing else of it is read.
    const ownerPage = { close: async () => undefined } as Playwright.Page;
    const runTrio = async (run: RecipePairRun, successorGate: string | undefined) =>
        await runRecipeTrioOnSameContext(
            run,
            { owner: { ...run.sender, page: ownerPage }, successor: { agentId: 'successor-agent' }, ownerEnd: 'close', successorGate },
            { sender: baseline.sender, receiver: baseline.receiver, successor }
        );

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

    it('cancels the same-context receiver once the owner failed, and never starts the successor', async () => {
        const control = await openRecordingControlRequest('cross-cancel-run');
        const run = toCrossCancelRun(
            control,
            new Map([
                [senderRunId, 'fails'],
                [receiverRunId, 'runs-until-cancelled'],
                [successorRunId, 'passes']
            ])
        );
        try {
            const outcome = await runTrio(run, undefined);

            expect(toPostedRuns(control.posted)).toEqual([receiverRunId, senderRunId]);
            expect(toPostedCancels(control.posted).map(({ commandId }) => commandId)).toEqual([`cancel-${receiverRunId}`]);
            expect(outcome).toStrictEqual({
                sender: { commandId: senderRunId, ok: false, summary: ROLE_FAILURE_SUMMARY, cancelledAfter: undefined },
                receiver: { commandId: receiverRunId, ok: false, summary: LANE_CANCELLED_SUMMARY, cancelledAfter: senderRunId },
                successor: { commandId: successorRunId, ok: false, summary: 'not started', cancelledAfter: senderRunId }
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it.each([undefined, 'owner-gate'])(
        'cancels the same-context owner while it runs once the receiver failed, and never starts the successor, with gate %s',
        async (successorGate) => {
            const control = await openRecordingControlRequest('cross-cancel-run');
            const run = toCrossCancelRun(
                control,
                new Map([
                    [senderRunId, 'runs-until-cancelled'],
                    [receiverRunId, 'fails'],
                    [successorRunId, 'passes']
                ])
            );
            try {
                const outcome = await runTrio(run, successorGate);

                expect(toPostedRuns(control.posted)).toEqual([receiverRunId, senderRunId]);
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
                    sender: { commandId: senderRunId, ok: false, summary: LANE_CANCELLED_SUMMARY, cancelledAfter: receiverRunId },
                    receiver: { commandId: receiverRunId, ok: false, summary: ROLE_FAILURE_SUMMARY, cancelledAfter: undefined },
                    successor: { commandId: successorRunId, ok: false, summary: 'not started', cancelledAfter: receiverRunId }
                });
            }
            finally {
                vi.restoreAllMocks();
                await control.close();
            }
        },
        // Before the fix the owner waits out its deadline and grace; a few polls are enough with it.
        10_000
    );
});

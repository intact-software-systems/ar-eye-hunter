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
/**
 * What an agent's control client reports for a recipe the lane cancelled: the recipe's result is `cancelled` and
 * carries no error, so the envelope's error is the client's default, which the lane does not report as the outcome.
 */
const LANE_CANCELLED: RallarBlackBoxTestError = { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message: 'Command failed.' };
const ROLE_FAILURE_SUMMARY = `${ROLE_FAILURE.code}: ${ROLE_FAILURE.message}`;
const LANE_CANCELLED_SUMMARY = 'cancelled';

/**
 * How a root started on the run ends: failing at once, passing at once, only once the lane cancels it, or with its own
 * failure that lands only after the lane's cancel went out, the cancel not having stopped it.
 */
type RootEnd = 'fails' | 'passes' | 'runs-until-cancelled' | 'fails-on-its-own-after-cancel';

/** Whether the agent answers the lane's cancel; an accepted answer says it aborted its target. */
type CancelAnswer = 'unanswered' | 'accepted';

/**
 * A run whose snapshot holds each started root's result as `ends` states it, read by its run command id, each cancel's
 * answer as `answer` states it, and the receiver's passed connect, which releases its barrier.
 */
function toCrossCancelRun(
    control: Readonly<{ request: Playwright.APIRequestContext; posted: readonly RecordedControlCommand[]; }>,
    ends: ReadonlyMap<string, RootEnd>,
    answer: CancelAnswer = 'unanswered'
): RecipePairRun {
    const toResult = (command: RecordedControlCommand): readonly ControlResultEnvelope[] => {
        const end = ends.get(command.commandId);
        const cancelled = control.posted.some(({ agentId, command: posted }) => posted.kind === 'recipe.cancel' && agentId === command.agentId);
        const failsOnItsOwn = end === 'fails' || end === 'fails-on-its-own-after-cancel';
        const cancelledByTheLane = end === 'runs-until-cancelled' && cancelled;
        const error = failsOnItsOwn ? ROLE_FAILURE : cancelledByTheLane ? LANE_CANCELLED : undefined;
        if (end === undefined || (end !== 'fails' && end !== 'passes' && !cancelled)) {
            return [];
        }
        return [{
            kind: 'result',
            protocolVersion: 1,
            runId: 'cross-cancel-run',
            agentId: command.agentId,
            commandId: command.commandId,
            ok: error === undefined,
            result: {
                commandId: command.commandId,
                kind: 'recipe.run',
                status: cancelledByTheLane ? 'cancelled' : error === undefined ? 'ok' : 'failed',
                ok: error === undefined,
                startedAtEpochMs: 1,
                endedAtEpochMs: 1,
                durationMs: 0
            },
            ...(error === undefined ? {} : { error })
        }];
    };
    const toAnswer = ({ agentId, commandId }: RecordedControlCommand): ControlResultEnvelope => ({
        kind: 'result',
        protocolVersion: 1,
        runId: 'cross-cancel-run',
        agentId,
        commandId,
        ok: true,
        result: {
            commandId,
            kind: 'recipe.cancel',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 1,
            endedAtEpochMs: 1,
            durationMs: 0,
            value: { cancelRequested: true }
        }
    });
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
            results: [
                ...control.posted.filter(({ command }) => command.kind === 'recipe.run').flatMap(toResult),
                ...(answer === 'accepted' ? control.posted.filter(({ command }) => command.kind === 'recipe.cancel').map(toAnswer) : [])
            ]
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
                    summary: LANE_CANCELLED_SUMMARY,
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

    it.each(
        [
            { answer: 'unanswered', cancelledAfter: undefined },
            { answer: 'accepted', cancelledAfter: receiverRunId }
        ] as const
    )(
        'names the receiver as what cancelled a sender whose own failure raced the cancel only when the cancel answer is $answer',
        async ({ answer, cancelledAfter }) => {
            const control = await openRecordingControlRequest('cross-cancel-run');
            const run = toCrossCancelRun(
                control,
                new Map([[senderRunId, 'fails-on-its-own-after-cancel'], [receiverRunId, 'fails']]),
                answer
            );
            try {
                const outcome = await runRecipePairOnTwoAgents(run, baseline);

                expect(toPostedCancels(control.posted).map(({ commandId }) => commandId)).toEqual([`cancel-${senderRunId}`]);
                expect(outcome).toStrictEqual({
                    sender: { commandId: senderRunId, ok: false, summary: ROLE_FAILURE_SUMMARY, cancelledAfter },
                    receiver: { commandId: receiverRunId, ok: false, summary: ROLE_FAILURE_SUMMARY, cancelledAfter: undefined }
                });
            }
            finally {
                vi.restoreAllMocks();
                await control.close();
            }
        }
    );

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

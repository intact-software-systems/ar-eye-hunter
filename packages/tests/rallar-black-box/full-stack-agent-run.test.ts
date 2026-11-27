import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
import { ALM_CONFORMANCE_LANE_FAMILIES } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RallarBlackBoxTestError } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    closeAgentConnections,
    runRecipesOnAgents,
    toAgentRunPrincipalIds,
    type AgentRecipeRun
} from '../../../tests/playwright/rallar-black-box/full-stack-agent-run.ts';

import { openRecordingControlRequest } from './recording-control-request-fixture.ts';

/** How many recipe gates the lane has begun to wait on: a gate's first read follows its start at once. */
const recipeGates = vi.hoisted(() => ({ started: 0 }));
vi.mock('../../../tests/playwright/rallar-black-box/full-stack-recipe-gate.ts', async (importOriginal) => {
    const gate = await importOriginal<typeof import('../../../tests/playwright/rallar-black-box/full-stack-recipe-gate.ts')>();
    return {
        ...gate,
        waitForRecipeGate: async (...input: Parameters<typeof gate.waitForRecipeGate>) => {
            recipeGates.started += 1;
            return await gate.waitForRecipeGate(...input);
        }
    };
});

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

const SENDER_FAILURE: RallarBlackBoxTestError = { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message: 'the sender\'s reconnect failed' };
/**
 * What an agent's control client reports for a recipe the lane cancelled: the recipe's result is `cancelled` and
 * carries no error, so the envelope's error is the client's default, which the lane does not report as the outcome.
 */
const LANE_CANCELLED: RallarBlackBoxTestError = { code: 'RALLAR_BLACK_BOX_COMMAND_FAILED', message: 'Command failed.' };

function toLaneCancelledResult(commandId: string): SiblingContinuationResult {
    return { commandId, ok: false, error: LANE_CANCELLED, cancelled: true };
}

function toScenarios(carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number]) {
    return createAlmConformanceRecipes({
        group,
        carrier,
        typeId: 'probe',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000,
        laneFamilies: ALM_CONFORMANCE_LANE_FAMILIES,
        principalIdsByRole: { sender: 'alice', receiver: 'bob', 'publisher-b': 'charlie' }
    });
}

describe('ALM run on an agent per role', () => {
    it('selects exactly the exhausted repair, paced list-isolation, receipted-audience, membership fence, leader, claim and reply-first-wins scenarios for the three-agent family on every carrier', () => {
        const rtcScenarioKeys = [
            'aggregated-receipt',
            'missing-recipient-retry',
            'unknown-ack-version',
            'unsigned-ack-refused',
            'forged-recipient-ack',
            'frozen-audience-membership'
        ];
        const fallbackScenarioKeys = rtcScenarioKeys.filter((key) => key !== 'forged-recipient-ack');
        const expectedKeys = {
            ws: [
                'repair-exhausted',
                'paced-isolation-lists',
                'aggregated-receipt',
                'missing-recipient-retry',
                'frozen-audience-membership',
                'fenced-delivery',
                'fenced-catch-up',
                'fenced-rejection',
                'leader-confirms',
                'no-leader-refused',
                'leader-outside-list',
                'claim-first-wins',
                'claim-expires-reclaims',
                'reply-first-wins'
            ],
            rtc: [
                'repair-exhausted',
                'paced-isolation-lists',
                ...rtcScenarioKeys,
                'fenced-delivery',
                'fenced-catch-up',
                'leader-confirms',
                'no-leader-refused',
                'claim-refused-on-rtc',
                'receipted-relay-path',
                'relayed-gap-renewal',
                'relayed-unreceipted-gap-renewal'
            ],
            'rtc-with-ws-fallback': [
                'paced-isolation-lists',
                ...fallbackScenarioKeys,
                'leader-confirms',
                'claim-first-wins'
            ]
        };
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const threeAgent = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'three-agent');
            expect(threeAgent.map((scenario) => scenario.scenarioKey), carrier).toEqual(expectedKeys[carrier]);
            expect(threeAgent.every((scenario) => scenario.recipientB !== undefined), carrier).toBe(true);
        }
    });

    it('selects exactly the audience scenarios and, over ws, the server-ordered entry cell for the same-principal family, each with a sibling', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const samePrincipal = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'same-principal');
            expect(samePrincipal.map((scenario) => scenario.scenarioKey), carrier).toEqual([
                ...(carrier === 'ws' ? ['server-ordered-entry'] : []),
                'principal-delivery',
                'fixed-list-delivery',
                'world-routing',
                ...(carrier === 'rtc' ? ['granted-rtc-principal-delivered'] : [])
            ]);
            expect(samePrincipal.every((scenario) => scenario.sibling !== undefined && scenario.recipientB === undefined), carrier)
                .toBe(true);
        }
    });

    it('selects exactly the topic subscription cells for the four-role family on every carrier', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const fourRole = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'four-role');
            expect(fourRole.map((scenario) => scenario.scenarioKey), carrier).toEqual([
                'subscription-delivery',
                'subscription-token-count',
                'subscription-revoke-disconnected',
                'subscription-ordered-entry',
                'subscription-ordered-omission',
                'subscription-ordered-reconnect'
            ]);
            expect(fourRole.every((scenario) => scenario.publisherB !== undefined && scenario.sibling !== undefined), carrier)
                .toBe(true);
        }
    });

    it('names each role\'s principal by the client id its agent signed in as', () => {
        const agents = new Map<AlmConformanceRole, Readonly<{ principalId: string; }>>([
            ['sender', { principalId: 'alice-client' }],
            ['sibling', { principalId: 'alice-client' }],
            ['publisher-b', { principalId: 'charlie-client' }]
        ]);

        expect(toAgentRunPrincipalIds({ agents })).toEqual({
            sender: 'alice-client',
            sibling: 'alice-client',
            'publisher-b': 'charlie-client'
        });
    });

    // The receiver's prologue creates the run's group, so it owns it; an only owner's leave is refused.
    it('starts every other role only after the receiver\'s connect barrier, and the sender after all of them', async () => {
        const baseline = toScenarios('ws').find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const sibling = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-sibling` };
        const publisherB = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-publisher-b` };
        const runIds = {
            receiver: `${baseline.receiver.recipeId}-run`,
            sibling: `${sibling.recipeId}-run`,
            publisherB: `${publisherB.recipeId}-run`,
            sender: `${baseline.sender.recipeId}-run`
        };
        const receiverConnected = Promise.withResolvers<void>();
        const control = await openRecordingControlRequest('agent-run');
        const request = control.request;
        const posted = (): readonly string[] => control.posted.map(({ commandId }) => commandId);
        const run: AgentRecipeRun = {
            request,
            runId: 'agent-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }],
                ['sibling', { agentId: 'sibling-agent' }],
                ['publisher-b', { agentId: 'publisher-b-agent' }]
            ]),
            startedRoots: [],
            readSnapshot: async () => {
                await receiverConnected.promise;
                return {
                    runId: 'agent-run',
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 2,
                    agents: [],
                    commands: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                    results: posted().map((commandId) => ({
                        kind: 'result',
                        protocolVersion: 1,
                        runId: 'agent-run',
                        agentId: 'observed-agent',
                        commandId,
                        ok: true
                    }))
                };
            }
        };
        try {
            const running = runRecipesOnAgents(
                run,
                new Map([
                    ['sender', baseline.sender],
                    ['publisher-b', publisherB],
                    ['receiver', baseline.receiver],
                    ['sibling', sibling]
                ]),
                undefined
            );
            await vi.waitFor(() => expect(posted()).toContain(runIds.receiver));
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(posted()).toEqual([runIds.receiver]);

            receiverConnected.resolve();
            const outcome = await running;

            expect(posted()).toEqual([runIds.receiver, runIds.publisherB, runIds.sibling, runIds.sender]);
            expect(outcome.continuation).toBeUndefined();
            expect(Object.fromEntries(outcome.roles)).toEqual({
                sender: { commandId: runIds.sender, ok: true, summary: 'ok' },
                receiver: { commandId: runIds.receiver, ok: true, summary: 'ok' },
                sibling: { commandId: runIds.sibling, ok: true, summary: 'ok' },
                'publisher-b': { commandId: runIds.publisherB, ok: true, summary: 'ok' }
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('starts the sibling\'s continuation on its own agent only once its first recipe passed and the gate passed in the receiver\'s still running recipe', async () => {
        let gateOpen = false;
        let siblingDone = false;
        // The receiver runs on until the gate opens; the sibling's first recipe until it is done.
        const fixture = await createSiblingContinuationFixture('gated-run', (posted, runIds) => ({
            gateOpen,
            results: posted
                .filter((commandId) => (gateOpen || commandId !== runIds.receiver) && (siblingDone || commandId !== runIds.sibling))
                .map((commandId) => ({ commandId, ok: true }))
        }));
        const { control, runIds } = fixture;
        try {
            const running = runRecipesOnAgents(fixture.run, fixture.recipes, fixture.continuation);
            await vi.waitFor(() => expect(fixture.posted()).toContain(runIds.sibling));
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(fixture.posted()).not.toContain(runIds.continuation);

            // The gate passed, but the continuation is the sibling's later steps: its first recipe must pass first.
            gateOpen = true;
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(fixture.posted()).not.toContain(runIds.continuation);

            siblingDone = true;
            const outcome = await running;

            expect(fixture.posted().at(-1)).toBe(runIds.continuation);
            expect(control.posted.find(({ commandId }) => commandId === runIds.continuation)?.agentId).toBe('sibling-agent');
            expect(outcome.continuation).toEqual({ commandId: runIds.continuation, ok: true, summary: 'ok' });
            expect([...outcome.roles.keys()].toSorted()).toEqual(['receiver', 'sender', 'sibling']);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it.each([
        { first: 'failed', ok: false, continued: false },
        { first: 'passed', ok: true, continued: true }
    ])('starts a continuation only after its role\'s first recipe passed: the first recipe $first', async ({ ok, continued }) => {
        // The gate passed and every recipe ended; only the sibling's first recipe may have failed.
        const fixture = await createSiblingContinuationFixture('failed-first-run', (posted, runIds) => ({
            gateOpen: true,
            results: posted.map((commandId) => ({ commandId, ok: commandId !== runIds.sibling || ok }))
        }));
        const { control, runIds } = fixture;
        try {
            const outcome = await runRecipesOnAgents(fixture.run, fixture.recipes, fixture.continuation);

            expect(fixture.posted().includes(runIds.continuation)).toBe(continued);
            expect(outcome.continuation).toStrictEqual(
                continued
                    ? { commandId: runIds.continuation, ok: true, summary: 'ok', cancelledAfter: undefined }
                    : { commandId: runIds.continuation, ok: false, summary: 'not started', cancelledAfter: runIds.sibling }
            );
            expect(outcome.roles.get('sibling')).toMatchObject({ commandId: runIds.sibling, ok });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('closes every agent\'s room connection before the next cell, and returns once each close passed', async () => {
        const control = await openRecordingControlRequest('four-role-run');
        const request = control.request;
        const posted = () => control.posted.map(({ commandId, command }) => ({ commandId, command: JSON.stringify(command) }));
        const run: AgentRecipeRun = {
            request,
            runId: 'four-role-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }]
            ]),
            startedRoots: [],
            readSnapshot: async () => ({
                runId: 'four-role-run',
                createdAtEpochMs: 1,
                updatedAtEpochMs: 2,
                agents: [],
                commands: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: [],
                results: posted().map(({ commandId }) => ({
                    kind: 'result',
                    protocolVersion: 1,
                    runId: 'four-role-run',
                    agentId: 'observed-agent',
                    commandId,
                    ok: true
                }))
            })
        };
        try {
            await closeAgentConnections(run, 'subscription-delivery');

            expect(posted()).toEqual([
                { commandId: 'close-subscription-delivery-sender-agent', command: '{"kind":"close"}' },
                { commandId: 'close-subscription-delivery-receiver-agent', command: '{"kind":"close"}' }
            ]);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('fails the family before the next cell when a role\'s recipe is still live after its cancel', async () => {
        const baseline = toScenarios('ws').find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const receiverRunId = `${baseline.receiver.recipeId}-run`;
        const senderRunId = `${baseline.sender.recipeId}-run`;
        const connect = baseline.receiver.commands.find((command) => command.kind === 'rtc.connect')!.commandId!;
        const control = await openRecordingControlRequest('stale-run');
        const request = control.request;
        const posted = () => control.posted.map(({ commandId, command }) => ({ commandId, kind: command.kind }));
        let nowEpochMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowEpochMs);
        // Each read moves the clock 30 s. The receiver connects and its recipe never ends, cancelled or not.
        const run: AgentRecipeRun = {
            request,
            runId: 'stale-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }]
            ]),
            startedRoots: [],
            readSnapshot: async () => {
                nowEpochMs += 30_000;
                return {
                    runId: 'stale-run',
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 2,
                    agents: [],
                    commands: [],
                    events: [{
                        kind: 'event',
                        protocolVersion: 1,
                        runId: 'stale-run',
                        agentId: 'receiver-agent',
                        atEpochMs: 1,
                        eventId: 'receiver-connected',
                        commandId: connect,
                        payload: { kind: 'result', topic: 'rallar.bb.command.result', commandId: connect, payload: { ok: true } }
                    }],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                    results: posted().filter(({ commandId }) => commandId === senderRunId).map(({ commandId }) => ({
                        kind: 'result',
                        protocolVersion: 1,
                        runId: 'stale-run',
                        agentId: 'sender-agent',
                        commandId,
                        ok: true
                    }))
                };
            }
        };
        try {
            await expect(runRecipesOnAgents(
                run,
                new Map([['sender', baseline.sender], ['receiver', baseline.receiver]]),
                undefined
            )).rejects.toThrow(`${receiverRunId} is still running after its deadline and cancellation`);

            expect(posted()).toEqual([
                { commandId: receiverRunId, kind: 'recipe.run' },
                { commandId: senderRunId, kind: 'recipe.run' },
                { commandId: `cancel-${receiverRunId}`, kind: 'recipe.cancel' }
            ]);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('fails the family without starting the continuation when the role holding it is still live after its cancel', async () => {
        let nowEpochMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowEpochMs);
        // Each read moves the clock 30 s. The sibling's first recipe never ends, cancelled or not.
        const fixture = await createSiblingContinuationFixture('stale-continuation-run', (posted, runIds) => {
            nowEpochMs += 30_000;
            return {
                gateOpen: true,
                results: posted.filter((commandId) => commandId !== runIds.sibling && !commandId.startsWith('cancel-'))
                    .map((commandId) => ({ commandId, ok: true }))
            };
        });
        const { control, runIds } = fixture;
        try {
            await expect(runRecipesOnAgents(fixture.run, fixture.recipes, fixture.continuation)).rejects.toThrow(
                `${runIds.sibling} is still running after its deadline and cancellation`
            );

            expect(fixture.posted()).toContain(`cancel-${runIds.sibling}`);
            expect(fixture.posted()).not.toContain(runIds.continuation);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('cancels every role still running once one ended not ok, reporting the failing role\'s own error and the cancelled role as cancelled after it', async () => {
        // The sender fails and the receiver passes at once; the sibling runs until the lane cancels it.
        const fixture = await createSiblingContinuationFixture('peer-failure-run', (posted, runIds) => ({
            gateOpen: false,
            results: [
                ...posted.filter((commandId) => commandId === runIds.sender).map((commandId) => ({ commandId, ok: false, error: SENDER_FAILURE })),
                ...posted.filter((commandId) => commandId === runIds.receiver).map((commandId) => ({ commandId, ok: true })),
                ...(posted.includes(`cancel-${runIds.sibling}`) ? [toLaneCancelledResult(runIds.sibling)] : [])
            ]
        }));
        const { control, runIds } = fixture;
        try {
            const outcome = await runRecipesOnAgents(fixture.run, fixture.recipes, undefined);

            expect(
                control.posted.filter(({ command }) => command.kind === 'recipe.cancel')
                    .map(({ agentId, commandId, command }) => ({ agentId, commandId, command }))
            ).toEqual([{
                agentId: 'sibling-agent',
                commandId: `cancel-${runIds.sibling}`,
                command: {
                    kind: 'recipe.cancel',
                    targetCommandId: runIds.sibling,
                    reason: `${runIds.sibling} cancelled after ${runIds.sender} ended not ok.`
                }
            }]);
            expect(Object.fromEntries(outcome.roles)).toStrictEqual({
                sender: {
                    commandId: runIds.sender,
                    ok: false,
                    summary: 'RALLAR_BLACK_BOX_COMMAND_FAILED: the sender\'s reconnect failed',
                    cancelledAfter: undefined
                },
                receiver: { commandId: runIds.receiver, ok: true, summary: 'ok', cancelledAfter: undefined },
                sibling: {
                    commandId: runIds.sibling,
                    ok: false,
                    summary: 'cancelled',
                    cancelledAfter: runIds.sender
                }
            });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('fails the family, naming the failing role\'s error first, when a role cancelled after it is still live after its cancel', async () => {
        let nowEpochMs = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => nowEpochMs);
        // Each read moves the clock 10 s. The sender fails and the receiver passes at once; the sibling never ends.
        const fixture = await createSiblingContinuationFixture('peer-failure-live-run', (posted, runIds) => {
            nowEpochMs += 10_000;
            return {
                gateOpen: false,
                results: [
                    ...posted.filter((commandId) => commandId === runIds.sender).map((commandId) => ({ commandId, ok: false, error: SENDER_FAILURE })),
                    ...posted.filter((commandId) => commandId === runIds.receiver).map((commandId) => ({ commandId, ok: true }))
                ]
            };
        });
        const { control, runIds } = fixture;
        try {
            await expect(runRecipesOnAgents(fixture.run, fixture.recipes, undefined)).rejects.toThrow(
                `${runIds.sender} ended not ok (RALLAR_BLACK_BOX_COMMAND_FAILED: the sender's reconnect failed), and ` +
                    `${runIds.sibling}, cancelled after it, is still running; no later cell may run on its page.`
            );

            expect(fixture.posted().filter((commandId) => commandId.startsWith('cancel-'))).toEqual([`cancel-${runIds.sibling}`]);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('does not start a continuation whose gate passed because the gating role\'s recipe failed, before that failure is read', async () => {
        // The gate starts once the sibling's pass was read, and the receiver's own failure shows from that gate's first
        // read on, so the gate sees the receiver's recipe ended a poll before the receiver's read does.
        const gatesBefore = recipeGates.started;
        const fixture = await createSiblingContinuationFixture('gating-failure-continuation-run', (posted, runIds) => ({
            gateOpen: false,
            results: [
                ...posted.filter((commandId) => [runIds.sibling, runIds.sender, runIds.continuation].includes(commandId))
                    .map((commandId) => ({ commandId, ok: true })),
                ...(recipeGates.started > gatesBefore ? [{ commandId: runIds.receiver, ok: false, error: SENDER_FAILURE }] : [])
            ]
        }));
        const { control, runIds } = fixture;
        try {
            const outcome = await runRecipesOnAgents(fixture.run, fixture.recipes, fixture.continuation);

            expect(fixture.posted()).not.toContain(runIds.continuation);
            expect(outcome.continuation).toStrictEqual({
                commandId: runIds.continuation,
                ok: false,
                summary: 'not started',
                cancelledAfter: runIds.receiver
            });
            expect(outcome.roles.get('receiver')).toMatchObject({ ok: false, cancelledAfter: undefined });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('does not start a continuation once a peer of its role ended not ok', async () => {
        // The sibling's first recipe passes and the sender fails at once; the receiver, whose recipe holds the gate, runs
        // until the lane cancels it, so the gate passes only once the sender's failure is known.
        const fixture = await createSiblingContinuationFixture('peer-failure-continuation-run', (posted, runIds) => ({
            gateOpen: false,
            results: [
                ...posted.filter((commandId) => commandId === runIds.sibling).map((commandId) => ({ commandId, ok: true })),
                ...posted.filter((commandId) => commandId === runIds.sender).map((commandId) => ({ commandId, ok: false, error: SENDER_FAILURE })),
                ...(posted.includes(`cancel-${runIds.receiver}`) ? [toLaneCancelledResult(runIds.receiver)] : [])
            ]
        }));
        const { control, runIds } = fixture;
        try {
            const outcome = await runRecipesOnAgents(fixture.run, fixture.recipes, fixture.continuation);

            expect(fixture.posted()).not.toContain(runIds.continuation);
            expect(outcome.continuation).toStrictEqual({
                commandId: runIds.continuation,
                ok: false,
                summary: 'not started',
                cancelledAfter: runIds.sender
            });
            expect(outcome.roles.get('receiver')).toMatchObject({ ok: false, cancelledAfter: runIds.sender });
            expect(outcome.roles.get('sibling')).toMatchObject({ ok: true, cancelledAfter: undefined });
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });

    it('throws when an agent\'s close has not passed within the close timeout, reading no snapshot after it', async () => {
        const control = await openRecordingControlRequest('close-timeout-run');
        const request = control.request;
        const posted = (): readonly string[] => control.posted.map(({ commandId }) => commandId);
        let nowEpochMs = 1_000;
        let reads = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => nowEpochMs);
        // Each read moves the clock 10 s: the receiver's close never passes, the sender's passes at once.
        const run: AgentRecipeRun = {
            request,
            runId: 'close-timeout-run',
            agents: new Map([
                ['sender', { agentId: 'sender-agent' }],
                ['receiver', { agentId: 'receiver-agent' }]
            ]),
            startedRoots: [],
            readSnapshot: async () => {
                reads += 1;
                nowEpochMs += 10_000;
                return {
                    runId: 'close-timeout-run',
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 2,
                    agents: [],
                    commands: [],
                    events: [],
                    stats: [],
                    reports: [],
                    heartbeats: [],
                    results: posted().map((commandId) => ({
                        kind: 'result',
                        protocolVersion: 1,
                        runId: 'close-timeout-run',
                        agentId: 'observed-agent',
                        commandId,
                        ok: commandId !== 'close-subscription-delivery-receiver-agent'
                    }))
                };
            }
        };
        try {
            await expect(closeAgentConnections(run, 'subscription-delivery')).rejects.toThrow(
                'subscription-delivery: not every agent closed its room connection within 30000 ms.'
            );
            expect(reads).toBe(3);
        }
        finally {
            vi.restoreAllMocks();
            await control.close();
        }
    });
});

interface SiblingContinuationRunIds {
    readonly sender: string;
    readonly receiver: string;
    readonly sibling: string;
    readonly continuation: string;
}

/** What a snapshot read of the sibling-continuation run states: whether the receiver passed the gate, and the results. */
interface SiblingContinuationSnapshot {
    readonly gateOpen: boolean;
    readonly results: readonly SiblingContinuationResult[];
}

/** A root's result; one that is not ok carries the agent's error, or none, and a cancelled one says so. */
interface SiblingContinuationResult {
    readonly commandId: string;
    readonly ok: boolean;
    readonly error?: RallarBlackBoxTestError;
    readonly cancelled?: true;
}

type ReadSiblingContinuationSnapshot = (
    posted: readonly string[],
    runIds: SiblingContinuationRunIds
) => SiblingContinuationSnapshot;

/** The cell's recipes: the sibling copies the receiver's, and holds a continuation gated on `receiver-p4-confirmed`. */
function toSiblingContinuationRecipes() {
    const baseline = toScenarios('ws').find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
    const sibling = { ...baseline.receiver, recipeId: `${baseline.receiver.recipeId}-sibling` };
    const continuation = {
        role: 'sibling',
        gate: { role: 'receiver', commandId: 'receiver-p4-confirmed' },
        recipe: { ...sibling, recipeId: `${sibling.recipeId}-continuation` }
    } as const;
    const runIds: SiblingContinuationRunIds = {
        sender: `${baseline.sender.recipeId}-run`,
        receiver: `${baseline.receiver.recipeId}-run`,
        sibling: `${sibling.recipeId}-run`,
        continuation: `${continuation.recipe.recipeId}-run`
    };
    const recipes = new Map<AlmConformanceRole, typeof sibling>([
        ['sender', baseline.sender],
        ['receiver', baseline.receiver],
        ['sibling', sibling]
    ]);
    const connect = sibling.commands.find((command) => command.kind === 'rtc.connect')!.commandId!;
    return { recipes, continuation, runIds, connect };
}

/** The control snapshot `snapshot` states: the receiver's connect passed, and its gate once open. */
function toSiblingContinuationSnapshot(runId: string, connect: string, snapshot: SiblingContinuationSnapshot) {
    const toPassedEvent = (commandId: string) => ({
        kind: 'event' as const,
        protocolVersion: 1 as const,
        runId,
        agentId: 'receiver-agent',
        atEpochMs: 1,
        eventId: `event-receiver-agent-${commandId}`,
        commandId,
        payload: { kind: 'result', topic: 'rallar.bb.command.result', commandId, payload: { commandId, ok: true } }
    });
    return {
        runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        agents: [],
        commands: [],
        events: [toPassedEvent(connect), ...(snapshot.gateOpen ? [toPassedEvent('receiver-p4-confirmed')] : [])],
        stats: [],
        reports: [],
        heartbeats: [],
        results: snapshot.results.map(({ commandId, ok, error, cancelled }) => ({
            kind: 'result' as const,
            protocolVersion: 1 as const,
            runId,
            agentId: 'observed-agent',
            commandId,
            ok,
            ...(error === undefined ? {} : { error }),
            ...(cancelled === true
                ? {
                    result: {
                        commandId,
                        kind: 'recipe.run' as const,
                        status: 'cancelled' as const,
                        ok,
                        startedAtEpochMs: 1,
                        endedAtEpochMs: 1,
                        durationMs: 0
                    }
                }
                : {})
        }))
    };
}

/**
 * A three-agent cell whose sibling holds a continuation. The sibling copies the receiver's recipe, so one passed
 * connect releases both barriers; `read` states each snapshot.
 */
async function createSiblingContinuationFixture(runId: string, read: ReadSiblingContinuationSnapshot) {
    const { recipes, continuation, runIds, connect } = toSiblingContinuationRecipes();
    const control = await openRecordingControlRequest(runId);
    const posted = (): readonly string[] => control.posted.map(({ commandId }) => commandId);
    const run: AgentRecipeRun = {
        request: control.request,
        runId,
        agents: new Map([
            ['sender', { agentId: 'sender-agent' }],
            ['receiver', { agentId: 'receiver-agent' }],
            ['sibling', { agentId: 'sibling-agent' }]
        ]),
        startedRoots: [],
        readSnapshot: async () => toSiblingContinuationSnapshot(runId, connect, read(posted(), runIds))
    };
    return { control, posted, run, recipes, continuation, runIds };
}

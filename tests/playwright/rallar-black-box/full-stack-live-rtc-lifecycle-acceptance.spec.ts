import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { toError } from '@shared/resilience/to-error.ts';

import { MANUAL_TRIGGER_POLICY } from './create-group-formation-lifecycle-driver.ts';
import {
    apiBaseUrl,
    applicationId,
    CONTROL_BASE_URL,
    hasThreeAgentConfig,
    LIVE_RTC_SKIP_MESSAGE,
    liveRtcAgentConfig,
    openAgentTrio,
    roomSeed,
    workspaceId,
    type LiveRtcAgentTrio
} from './live-rtc-agent-environment.ts';
import { closeLiveRtcBrowserAgentContexts } from './live-rtc-browser-agents.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations } from './live-rtc-delivery-operations.ts';
import {
    createLiveRtcFormationOperations,
    type FormationDiagnosticEvent
} from './live-rtc-formation-operations.ts';

/**
 * The five acceptance scenarios of the group-activation product plan that only a real browser can
 * exercise. Every statement is read from the browser's own evidence: the formation summary the
 * agents report, the diagnostics they emit, and the dial events they record. Nothing here refreshes
 * a room on an observing agent, because a refresh would answer the question the pin is asking.
 */

const HOLD_MS = 5_000;
const STAGE_WAIT_MS = 45_000;
const PRESENCE_SETTLE_MS = 5_000;

const formationOperations = createLiveRtcFormationOperations();
const deliveryOperations = createLiveRtcDeliveryOperations({
    apiBaseUrl,
    applicationId,
    workspaceId,
    messagesRtcTypeId: 'manual.type',
    messagesRtcTopicId: 'manual.topic'
});

test.describe('live RTC lifecycle acceptance', () => {
    test.skip(!hasThreeAgentConfig, LIVE_RTC_SKIP_MESSAGE);

    test(
        'holds every dial while a managed lobby discovers itself, then dials on connect',
        async ({ browser, request }) => {
            test.setTimeout(300_000);
            const scenario = await openScenario(browser, request, 'discovery');
            try {
                const { control, runId, groupId, suffix, agents } = scenario;
                await setupMembership(scenario);
                for (const agent of agents) {
                    await connectPresence(scenario, agent);
                }

                await holdFor(agents[0], HOLD_MS);

                for (const agent of agents) {
                    const base = { control, runId, agent, groupId, suffix };
                    expect(await formationOperations.countPeerCreated(base)).toBe(0);
                    const health = await formationOperations.health(base);
                    expect(health.formation).toMatchObject({ stage: 'forming', dialing: 'none' });
                }

                await formationOperations.command({
                    ...agentInput(scenario, agents[0]),
                    input: { command: 'plan' }
                });
                await connectWhenPlanned(scenario, agents[0]);
                for (const agent of agents) {
                    await expectDialed(scenario, agent, 1);
                }
            }
            finally {
                await retire(scenario);
            }
        }
    );

    test('reports a monotonic readiness fraction to a member that reopens', async ({ browser, request }) => {
        test.setTimeout(300_000);
        const scenario = await openScenario(browser, request, 'progress');
        try {
            await activateGroup(scenario);
            const reopenedAt = Date.now();
            const reopened = await formationOperations.reopen({
                ...agentInput(scenario, scenario.agents[2]),
                browser,
                config: liveRtcAgentConfig(),
                transport: 'realtime'
            });
            scenario.agents = [scenario.agents[0], scenario.agents[1], reopened];
            await connectPresence(scenario, reopened);
            await settleSurvivors(scenario, reopened);
            await formationOperations.readiness(agentInput(scenario, reopened));

            const samples = await formationOperations.readFormationDiagnostics({
                ...agentInput(scenario, reopened),
                topic: 'rallar.browser.formation.room-status',
                sinceEpochMs: reopenedAt
            });

            expect(validateProgressSeries(samples)).toEqual([]);
        }
        finally {
            await retire(scenario);
        }
    });

    test('reports ready only after the accepted layout arrived', async ({ browser, request }) => {
        test.setTimeout(300_000);
        const scenario = await openScenario(browser, request, 'barrier');
        try {
            await activateGroup(scenario);
            const reopenedAt = Date.now();
            const reopened = await formationOperations.reopen({
                ...agentInput(scenario, scenario.agents[1]),
                browser,
                config: liveRtcAgentConfig(),
                transport: 'realtime'
            });
            scenario.agents = [scenario.agents[0], reopened, scenario.agents[2]];
            await connectPresence(scenario, reopened);
            await settleSurvivors(scenario, reopened);
            await expectRoomHeld(scenario, reopened);

            const readiness = await formationOperations.readiness(agentInput(scenario, reopened));
            const changes = await formationOperations.readFormationDiagnostics({
                ...agentInput(scenario, reopened),
                topic: 'rallar.browser.formation.changed',
                sinceEpochMs: reopenedAt
            });
            const accepted = changes.filter((event) => acceptedIdentityOf(event) !== undefined);

            expect(accepted.length).toBeGreaterThan(0);
            expect(readiness.readyAtEpochMs).toBeGreaterThanOrEqual(lastAtEpochMs(accepted));
            expect(readiness.formation.stage).toBe('active');
            expect(readiness.formation.accepted?.identity).toEqual(
                readiness.formation.room.acceptedLayoutIdentity
            );
        }
        finally {
            await retire(scenario);
        }
    });

    test('drops every lane on reset and dials again on the next series', async ({ browser, request }) => {
        test.setTimeout(300_000);
        const scenario = await openScenario(browser, request, 'reset');
        try {
            await activateGroup(scenario);
            const beforeReset = await Promise.all(
                scenario.agents.map(async (agent) =>
                    await formationOperations.countPeerCreated(agentInput(scenario, agent))
                )
            );
            const resetAt = Date.now();

            await formationOperations.command({
                ...agentInput(scenario, scenario.agents[0]),
                input: { command: 'reset' }
            });

            for (const agent of scenario.agents) {
                await formationOperations.waitForStage({
                    ...agentInput(scenario, agent),
                    stage: 'dormant',
                    timeoutMs: STAGE_WAIT_MS,
                    sinceEpochMs: resetAt
                });
                // The stage reaches `dormant` before the lanes finish closing, so the teardown is
                // awaited rather than sampled: what the pin claims is that they end empty, not that
                // they are empty the instant the stage changes.
                await expect
                    .poll(async () => {
                        const sampled = await formationOperations.health(agentInput(scenario, agent));
                        return [
                            ...sampled.rtcStatus.activePeerIds,
                            ...sampled.rtcStatus.knownPeerIds,
                            ...sampled.rtcStatus.readyPeerIds
                        ].length;
                    }, { timeout: 60_000, intervals: [1_000] })
                    .toBe(0);
                const health = await formationOperations.health(agentInput(scenario, agent));
                expect(health.formation.dialing).toBe('none');
                expect(health.formation.accepted).toBeUndefined();
                expect(health.formation.planned).toBeUndefined();
            }

            await holdFor(scenario.agents[0], HOLD_MS);
            for (const [index, agent] of scenario.agents.entries()) {
                expect(await formationOperations.countPeerCreated(agentInput(scenario, agent))).toBe(
                    beforeReset[index]
                );
            }

            for (const command of ['start', 'plan'] as const) {
                await formationOperations.command({ ...agentInput(scenario, scenario.agents[0]), input: { command } });
            }
            await connectWhenPlanned(scenario, scenario.agents[0]);
            for (const [index, agent] of scenario.agents.entries()) {
                await expectDialed(scenario, agent, beforeReset[index] + 1);
            }
        }
        finally {
            await retire(scenario);
        }
    });

    test('hydrates a dormant group without resurrecting its layouts', async ({ browser, request }) => {
        test.setTimeout(300_000);
        const scenario = await openScenario(browser, request, 'hydration');
        try {
            await activateGroup(scenario);
            const resetAt = Date.now();
            await formationOperations.command({
                ...agentInput(scenario, scenario.agents[0]),
                input: { command: 'reset' }
            });
            await formationOperations.waitForStage({
                ...agentInput(scenario, scenario.agents[0]),
                stage: 'dormant',
                timeoutMs: STAGE_WAIT_MS,
                sinceEpochMs: resetAt
            });

            const reopened = await formationOperations.reopen({
                ...agentInput(scenario, scenario.agents[2]),
                browser,
                config: liveRtcAgentConfig(),
                transport: 'realtime'
            });
            scenario.agents = [scenario.agents[0], scenario.agents[1], reopened];
            await connectPresence(scenario, reopened);

            const hydrated = await formationOperations.health(agentInput(scenario, reopened));
            expectDormantAndEmpty(hydrated);

            await reopened.refreshRoom({ timeoutMs: 15_000 });
            const refreshed = await formationOperations.health(agentInput(scenario, reopened));
            expectDormantAndEmpty(refreshed);
        }
        finally {
            await retire(scenario);
        }
    });
});

interface AcceptanceScenario {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly groupId: string;
    readonly suffix: string;
    agents: LiveRtcAgentTrio;
}

async function openScenario(
    browser: Browser,
    request: APIRequestContext,
    label: string
): Promise<AcceptanceScenario> {
    const control = new LiveRtcControlClient({
        request,
        baseUrl: CONTROL_BASE_URL,
        monotonicNow: () => performance.now(),
        epochNow: () => Date.now()
    });
    const suffix = `lifecycle-${Date.now()}-${crypto.randomUUID()}`;
    const runId = `rallar-lifecycle-acceptance-${suffix}`;
    const groupId = `${roomSeed}-${suffix}`;
    const agents = await openAgentTrio(browser, { runId, groupId, suffix, label });
    return { control, runId, groupId, suffix, agents };
}

/** The group every scenario runs on: managed, with the driver commanding each boundary itself. */
async function setupMembership(scenario: AcceptanceScenario): Promise<void> {
    await deliveryOperations.setupGroupMembership({
        control: scenario.control,
        runId: scenario.runId,
        owner: scenario.agents[0],
        members: scenario.agents,
        groupId: scenario.groupId,
        suffix: scenario.suffix,
        lifecyclePolicy: MANUAL_TRIGGER_POLICY
    });
}

/**
 * Presence without a readiness barrier: the browser connects, joins and hydrates on its own, which
 * is the entry every observing agent uses so nothing refreshes the room on its behalf.
 */
async function connectPresence(
    scenario: AcceptanceScenario,
    agent: LiveRtcControlClient.Agent
): Promise<void> {
    await scenario.control.executeOk({
        runId: scenario.runId,
        agentId: agent.agentId,
        commandId: `presence-${agent.prefix}-${scenario.suffix}`,
        command: {
            kind: 'rtc.connect',
            commandId: `presence-${agent.prefix}-${scenario.suffix}`,
            connection: agent.connection,
            actor: agent.actor,
            roomId: scenario.groupId,
            applicationId,
            workspaceId,
            roomRef: { applicationId, workspaceId, groupId: scenario.groupId },
            transport: 'realtime',
            rallar: {
                apiBaseUrl: apiBaseUrl ?? '',
                restoreSession: true,
                // Closing a page for a reopen must not end the session it is about to restore, nor
                // drop its membership: without these the returning page holds a token the server has
                // already logged out, and reports itself unconnected while its command reports ok.
                logoutOnClose: false,
                leaveRoomOnClose: false
            },
            timeoutMs: 45_000
        },
        timeoutMs: 90_000
    });
}

/** Drives the group to `active` through the four commands, then settles every agent's readiness. */
async function activateGroup(scenario: AcceptanceScenario): Promise<void> {
    await setupMembership(scenario);
    for (const agent of scenario.agents) {
        await connectPresence(scenario, agent);
    }
    // Presence is what the planner plans over, and it propagates asynchronously; planning before it
    // settles yields a cycle with nothing to publish, so the group never gains a planned layout.
    await holdFor(scenario.agents[0], PRESENCE_SETTLE_MS);
    // `readiness` is an after-activation instrument: the room's transport state is derived from the
    // ACCEPTED layout, which the promotion at `activate` creates, so before that it reads `idle` and
    // the barrier can never resolve. The dials are therefore awaited by their own evidence here, and
    // readiness is used only once the group is active.
    await formationOperations.command({
        control: scenario.control,
        runId: scenario.runId,
        agent: scenario.agents[0],
        groupId: scenario.groupId,
        suffix: scenario.suffix,
        input: { command: 'plan' }
    });
    await connectWhenPlanned(scenario, scenario.agents[0]);
    for (const agent of scenario.agents) {
        await expectDialed(scenario, agent, 1);
    }
    await formationOperations.command({
        control: scenario.control,
        runId: scenario.runId,
        agent: scenario.agents[0],
        groupId: scenario.groupId,
        suffix: scenario.suffix,
        input: { command: 'activate' }
    });
}

async function retire(scenario: AcceptanceScenario): Promise<void> {
    const errors = await closeLiveRtcBrowserAgentContexts(scenario.agents);
    for (const error of errors) {
        console.error('Failed to close a lifecycle acceptance agent', toError(error));
    }
}

function expectDormantAndEmpty(
    health: { formation: { stage: string; }; rtcStatus: { readyPeerIds: readonly string[]; }; }
): void {
    const formation = health.formation as unknown as Record<string, unknown>;
    expect(formation.stage).toBe('dormant');
    expect(formation.planned).toBeUndefined();
    expect(formation.accepted).toBeUndefined();
    expect(formation.coverageRate).toBeUndefined();
    expect(health.rtcStatus.readyPeerIds).toEqual([]);
}

function agentInput(scenario: AcceptanceScenario, agent: LiveRtcControlClient.Agent) {
    return {
        control: scenario.control,
        runId: scenario.runId,
        agent,
        groupId: scenario.groupId,
        suffix: scenario.suffix
    };
}

/**
 * A reopened page must hold the room before anything it reports means anything. The health decoder
 * fails with the whole block when the formation summary is missing, so a page that connected but
 * never took the room says so here rather than inside a readiness timeout.
 */
async function expectRoomHeld(
    scenario: AcceptanceScenario,
    agent: LiveRtcControlClient.Agent
): Promise<void> {
    let lastFailure = 'the room was never read';
    for (let attempt = 0; attempt < 15; attempt++) {
        try {
            await formationOperations.health(agentInput(scenario, agent));
            return;
        }
        catch (error) {
            lastFailure = error instanceof Error ? error.message : String(error);
        }
        await agent.page.waitForTimeout(2_000);
    }
    throw new Error(`Agent ${agent.prefix} reopened without taking the room. ${lastFailure}`);
}

/**
 * A member that reopens returns to a mesh whose surviving peers still hold the lane it left with, so
 * they are the ones that must look again before anything dials it. Only the survivors are refreshed:
 * the reopened agent is the observer, and refreshing it would answer the question its own barrier is
 * asking.
 */
async function settleSurvivors(
    scenario: AcceptanceScenario,
    reopened: LiveRtcControlClient.Agent
): Promise<void> {
    for (const agent of scenario.agents) {
        if (agent.agentId !== reopened.agentId) {
            await agent.refreshRoom({ timeoutMs: 20_000 });
        }
    }
}

/**
 * The planned layout is published by the topology worker, not by the `plan` receipt, so a `connect`
 * issued straight after `plan` can be refused for naming no planned layout. The browser's own cached
 * planned slot is not the gate either — it is delivered on its own schedule and a manager that never
 * subscribed may not hold it at all — so the connect is retried on exactly that refusal, which is
 * what the shipped quickstart tells an application to do.
 */
async function connectWhenPlanned(
    scenario: AcceptanceScenario,
    agent: LiveRtcControlClient.Agent
): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastError = 'the connect was never attempted';
    while (Date.now() < deadline) {
        const result = await formationOperations.tryCommand({
            ...agentInput(scenario, agent),
            input: { command: 'connect' }
        });
        if (result.ok) {
            return;
        }
        lastError = JSON.stringify(result.error);
        if (!lastError.includes('no planned layout')) {
            break;
        }
        await agent.page.waitForTimeout(500);
    }
    throw new Error(`The connect never found a published layout: ${lastError}`);
}

/** The dial witness the two positive controls assert: the agent's own recorded peer-created events. */
async function expectDialed(
    scenario: AcceptanceScenario,
    agent: LiveRtcControlClient.Agent,
    atLeast: number
): Promise<void> {
    await expect
        .poll(async () => await formationOperations.countPeerCreated(agentInput(scenario, agent)), {
            timeout: 90_000,
            intervals: [500]
        })
        .toBeGreaterThanOrEqual(atLeast);
}

async function holdFor(agent: LiveRtcControlClient.Agent, ms: number): Promise<void> {
    await agent.page.waitForTimeout(ms);
}

function lastAtEpochMs(events: readonly FormationDiagnosticEvent[]): number {
    return events.reduce((latest, event) => Math.max(latest, event.atEpochMs), 0);
}

function acceptedIdentityOf(event: FormationDiagnosticEvent): unknown {
    const accepted = event.data.accepted;
    return typeof accepted === 'object' && accepted !== null
        ? (accepted as Record<string, unknown>).identity
        : undefined;
}

interface ProgressSeriesIssue {
    readonly index: number;
    readonly reason: string;
}

/**
 * Decision 40's window, read as a pure function of the recorded samples: hydration delivers the
 * accepted layout first, then lanes open while no group write happens, so the fraction only rises,
 * it ends at one, and every sample after the first full desired set names the same layout and the
 * same group revision.
 */
export function validateProgressSeries(
    samples: readonly FormationDiagnosticEvent[]
): readonly ProgressSeriesIssue[] {
    const issues: ProgressSeriesIssue[] = [];
    let previousFraction: number | undefined;
    let identity: string | undefined;
    let groupRevision: unknown;
    let lastFraction: number | undefined;

    for (const [index, sample] of samples.entries()) {
        const room = sample.data.room;
        const desired = Array.isArray((room as Record<string, unknown>)?.desiredPeerIds)
            ? ((room as Record<string, unknown>).desiredPeerIds as readonly unknown[])
            : [];
        const ready = Array.isArray((room as Record<string, unknown>)?.readyPeerIds)
            ? ((room as Record<string, unknown>).readyPeerIds as readonly unknown[])
            : [];
        if (desired.length === 0) {
            continue;
        }

        const fraction = ready.length / desired.length;
        const sampleIdentity = JSON.stringify((room as Record<string, unknown>).acceptedLayoutIdentity);
        identity ??= sampleIdentity;
        groupRevision ??= sample.data.groupRevision;
        if (sampleIdentity !== identity) {
            issues.push({ index, reason: 'the accepted layout changed inside the window' });
        }
        if (sample.data.groupRevision !== groupRevision) {
            issues.push({ index, reason: 'the group revision moved inside the window' });
        }
        if (previousFraction !== undefined && fraction < previousFraction) {
            issues.push({ index, reason: `the ready fraction fell to ${fraction}` });
        }
        previousFraction = fraction;
        lastFraction = fraction;
    }

    if (lastFraction === undefined) {
        issues.push({ index: -1, reason: 'no sample carried a desired peer set' });
    }
    else if (lastFraction !== 1) {
        issues.push({ index: samples.length - 1, reason: `the window ended at ${lastFraction}` });
    }
    return issues;
}

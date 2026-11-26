import {
    expect,
    test,
    type APIRequestContext,
    type Browser
} from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { toError } from '@shared/resilience/to-error.ts';

import {
    computeLiveRtcLifecycleScenarioTimeoutMs,
    LIFECYCLE_HOLD_MS,
    LIFECYCLE_PROGRESS_DIAGNOSTICS_POLL_TIMEOUT_MS
} from './compute-live-rtc-lifecycle-scenario-timeout-ms.ts';
import {
    almDiagnostics,
    apiBaseUrl,
    applicationId,
    CONTROL_BASE_URL,
    hasThreeAgentConfig,
    LIVE_RTC_SKIP_MESSAGE,
    liveRtcAgentConfig,
    openAgentTrio,
    roomSeed,
    workspaceId
} from './live-rtc-agent-environment.ts';
import { closeLiveRtcBrowserAgentContexts } from './live-rtc-browser-agents.ts';
import { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations } from './live-rtc-delivery-operations.ts';
import { jsonRecord } from './live-rtc-evidence-json.ts';
import {
    createLiveRtcFormationOperations,
    type FormationDiagnosticEvent,
    type FormationHealth
} from './live-rtc-formation-operations.ts';
import { LiveRtcLifecycleOperations } from './live-rtc-lifecycle-operations.ts';
import { validateProgressSeries } from './live-rtc-readiness-progress.ts';

/**
 * The five acceptance scenarios of the group-activation product plan that only a real browser can
 * exercise. Evidence comes from browser formation summaries, diagnostics and dial events.
 * Presence restores the same session; readiness explicitly refreshes the current room before waiting.
 */

/** How long the reopened member's progress diagnostics poll pauses between its reads. */
const LIFECYCLE_PROGRESS_DIAGNOSTICS_POLL_INTERVAL_MS = 250;

const formationOperations = createLiveRtcFormationOperations();
const lifecycle = new LiveRtcLifecycleOperations({
    formation: formationOperations,
    delivery: createLiveRtcDeliveryOperations({
        apiBaseUrl,
        applicationId,
        workspaceId,
        messagesRtcTypeId: 'manual.type',
        messagesRtcTopicId: 'manual.topic',
        almDiagnostics,
        formation: formationOperations
    }),
    apiBaseUrl,
    applicationId,
    workspaceId
});

test.describe('live RTC lifecycle acceptance', () => {
    test.skip(!hasThreeAgentConfig, LIVE_RTC_SKIP_MESSAGE);

    test('holds every dial while a managed lobby discovers itself, then dials on connect', async ({ browser, request }) => {
        test.setTimeout(computeLiveRtcLifecycleScenarioTimeoutMs('discovery'));
        const scenario = await openScenario(browser, request, 'discovery');
        try {
            await lifecycle.connectTrioPresence(scenario);

            await scenario.agents[0].page.waitForTimeout(LIFECYCLE_HOLD_MS);

            for (const agent of scenario.agents) {
                const base = lifecycle.toAgentInput(scenario, agent);
                expect(await formationOperations.countPeerCreated(base)).toBe(0);
                const health = await formationOperations.health(base);
                expect(health.formation).toMatchObject({
                    stage: 'forming',
                    dialing: 'none'
                });
            }

            await formationOperations.command({
                ...lifecycle.toAgentInput(scenario, scenario.agents[0]),
                input: { command: 'plan' }
            });
            await lifecycle.connectWhenPlanned(scenario);
            for (const agent of scenario.agents) {
                await lifecycle.expectDialed(scenario, agent, 1);
            }
        }
        finally {
            await retire(scenario);
        }
    });

    test('reports a monotonic readiness fraction to a member that reopens', async ({ browser, request }, testInfo) => {
        test.setTimeout(computeLiveRtcLifecycleScenarioTimeoutMs('monotonic-readiness'));
        let scenario = await openScenario(browser, request, 'progress');
        try {
            await lifecycle.activateGroup(scenario);
            scenario = await lifecycle.reopen(scenario, { browser, config: liveRtcAgentConfig(), index: 2 });
            const reopened = scenario.agents[2];
            // The agent ID survives reopening; the old page can emit while its context closes.
            const reopenedAt = await reopened.page.evaluate(() => performance.timeOrigin);
            const recording = await scenario.control.executeOk({
                runId: scenario.runId,
                agentId: reopened.agentId,
                commandId: `progress-recording-${scenario.suffix}`,
                command: { kind: 'health' }
            });
            expect(
                jsonRecord(scenario.control.resultValue(recording))?.browserDiagnostics,
                'Readiness progression requires routine diagnostics enabled on the actual reopened page'
            )
                .toMatchObject({ routineBrowserDiagnostics: 'enabled', omittedRoutineBrowserDiagnostics: 0 });
            await lifecycle.connectPresence(scenario, reopened);
            await lifecycle.settleSurvivors(scenario, reopened);
            await formationOperations.readiness(lifecycle.toAgentInput(scenario, reopened));
            let samples: readonly FormationDiagnosticEvent[] = [];
            try {
                // Diagnostics reach the control server independently of the readiness command result.
                await expect.poll(async () => {
                    samples = await formationOperations.readFormationDiagnostics({
                        ...lifecycle.toAgentInput(scenario, reopened),
                        topic: 'rallar.browser.formation.room-status',
                        sinceEpochMs: reopenedAt
                    });
                    return validateProgressSeries(samples, 'successive-revisions');
                }, {
                    timeout: LIFECYCLE_PROGRESS_DIAGNOSTICS_POLL_TIMEOUT_MS,
                    intervals: [LIFECYCLE_PROGRESS_DIAGNOSTICS_POLL_INTERVAL_MS]
                }).toEqual([]);
            }
            finally {
                const evidencePath = testInfo.outputPath('reopening-readiness.json');
                await writeFile(evidencePath, JSON.stringify({ reopenedAt, samples }, null, 2));
                await testInfo.attach('reopening-readiness', { path: evidencePath, contentType: 'application/json' });
            }
        }
        finally {
            await retire(scenario);
        }
    });

    test('reports ready only after the accepted layout arrived', async ({ browser, request }) => {
        test.setTimeout(computeLiveRtcLifecycleScenarioTimeoutMs('accepted-layout-barrier'));
        let scenario = await openScenario(browser, request, 'barrier');
        try {
            await lifecycle.activateGroup(scenario);
            scenario = await lifecycle.reopen(scenario, { browser, config: liveRtcAgentConfig(), index: 1 });
            const reopened = scenario.agents[1];
            // The agent ID survives reopening; the old page can emit while its context closes.
            const reopenedAt = await reopened.page.evaluate(() => performance.timeOrigin);
            await lifecycle.connectPresence(scenario, reopened);
            await lifecycle.settleSurvivors(scenario, reopened);
            await lifecycle.expectRoomHeld(scenario, reopened);

            const readiness = await formationOperations.readiness(lifecycle.toAgentInput(scenario, reopened));
            const changes = await lifecycle.readFormationChanges(scenario, reopened, reopenedAt);
            const accepted = changes.filter(
                (event) => acceptedIdentityOf(event) !== undefined
            );

            expect(accepted.length).toBeGreaterThan(0);
            expect(readiness.readyAtEpochMs).toBeGreaterThanOrEqual(
                lastAtEpochMs(accepted)
            );
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
        test.setTimeout(computeLiveRtcLifecycleScenarioTimeoutMs('reset'));
        const scenario = await openScenario(browser, request, 'reset');
        try {
            await lifecycle.activateGroup(scenario);
            const beforeReset = await Promise.all(
                scenario.agents.map(
                    async (agent) => await formationOperations.countPeerCreated(lifecycle.toAgentInput(scenario, agent))
                )
            );

            for (const health of await lifecycle.resetTrioToDormant(scenario)) {
                expect(health.formation.dialing).toBe('none');
                expect(health.formation.accepted).toBeUndefined();
                expect(health.formation.planned).toBeUndefined();
            }

            await scenario.agents[0].page.waitForTimeout(LIFECYCLE_HOLD_MS);
            for (const [index, agent] of scenario.agents.entries()) {
                expect(await formationOperations.countPeerCreated(lifecycle.toAgentInput(scenario, agent))).toBe(
                    beforeReset[index]
                );
            }

            await lifecycle.redial(scenario, beforeReset);
        }
        finally {
            await retire(scenario);
        }
    });

    test('hydrates a dormant group without resurrecting its layouts', async ({ browser, request }) => {
        test.setTimeout(computeLiveRtcLifecycleScenarioTimeoutMs('hydration'));
        let scenario = await openScenario(browser, request, 'hydration');
        try {
            await lifecycle.activateGroup(scenario);
            await lifecycle.resetOwnerToDormant(scenario);

            scenario = await lifecycle.reopen(scenario, { browser, config: liveRtcAgentConfig(), index: 2 });
            const reopened = scenario.agents[2];
            await lifecycle.connectPresence(scenario, reopened);

            for (const health of await lifecycle.readHydratedHealths(scenario, reopened)) {
                expectDormantAndEmpty(health);
            }
        }
        finally {
            await retire(scenario);
        }
    });
});

async function openScenario(
    browser: Browser,
    request: APIRequestContext,
    label: string
): Promise<LiveRtcLifecycleOperations.Run> {
    const control = new LiveRtcControlClient({
        request,
        baseUrl: CONTROL_BASE_URL,
        monotonicNow: () => performance.now(),
        epochNow: () => Date.now()
    });
    const suffix = `lifecycle-${Date.now()}-${crypto.randomUUID()}`;
    const runId = `rallar-lifecycle-acceptance-${suffix}`;
    const groupId = `${roomSeed}-${suffix}`;
    const agents = await openAgentTrio(browser, {
        runId,
        groupId,
        suffix,
        label
    });
    return { control, runId, groupId, suffix, agents };
}

async function retire(scenario: LiveRtcLifecycleOperations.Run): Promise<void> {
    const errors = await closeLiveRtcBrowserAgentContexts(scenario.agents);
    for (const error of errors) {
        console.error(
            'Failed to close a lifecycle acceptance agent',
            toError(error)
        );
    }
}

function expectDormantAndEmpty(health: FormationHealth): void {
    expect(health.formation.stage).toBe('dormant');
    expect(health.formation.planned).toBeUndefined();
    expect(health.formation.accepted).toBeUndefined();
    expect(health.formation.coverageRate).toBeUndefined();
    expect(health.rtcStatus.readyPeerIds).toEqual([]);
}

function lastAtEpochMs(events: readonly FormationDiagnosticEvent[]): number {
    return events.reduce((latest, event) => Math.max(latest, event.atEpochMs), 0);
}

function acceptedIdentityOf(
    event: FormationDiagnosticEvent
): string | undefined {
    const accepted = jsonRecord(event.data.accepted);
    return accepted === null ? undefined : JSON.stringify(accepted.identity);
}

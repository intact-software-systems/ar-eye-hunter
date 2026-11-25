import { describe, expect, it } from 'vitest';

import { computeDistributedRunTerminalTimeoutSeconds } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    computeDistributedRunPassedWaitMs,
    computeDistributedRunToPassedWaitMs,
    DISTRIBUTED_STATE_POLL_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/distributed-recipes/distributed-control.ts';
import {
    computeLiveDistributedRecipesTestTimeoutMs,
    computeSimulatedAckTestTimeoutMs,
    createLiveDistributedRecipeRuns,
    createSimulatedAckManifest,
    SIMULATED_FAILURES_TEST_TIMEOUT_MS,
    toLiveDistributedRecipeManifests
} from '../../../tests/playwright/rallar-black-box/distributed-recipes/distributed-recipe-test-runs.ts';
import {
    createDistributedManifest,
    createPreprovisionedRealtimeRecipe,
    healthRecipe,
    rtcConnectRecipe
} from '../../../tests/playwright/rallar-black-box/distributed-recipes/recipe-manifests.ts';

const group: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'passed-wait-room'
};

function toManifest(recipe: RallarBlackBoxTestRecipe) {
    return createDistributedManifest({
        distributedRunId: `dist-${recipe.recipeId}`,
        controlRunId: 'passed-wait-run',
        group,
        recipes: [{ recipeId: recipe.recipeId, recipe, profile: 'live-rtc', variables: {} }],
        targetPolicy: { mode: 'all-online-group-members', expectedParticipantCount: 3 }
    });
}

describe('computeDistributedRunPassedWaitMs', () => {
    // runToPassed waited 45 s for passed while the connect recipe may take its 10 s ack, a 135 s room-joining connect
    // and the 30 s readiness after it.
    it('covers the RTC connect recipe by its ack, its connect and readiness, then the state poll', () => {
        expect(DISTRIBUTED_STATE_POLL_TIMEOUT_MS).toBe(45_000);
        expect(computeDistributedRunPassedWaitMs(toManifest(rtcConnectRecipe('connect', group))))
            .toBe(10_000 + 135_000 + 30_000 + 45_000);
    });

    it('covers the preprovisioned realtime recipe by the distributed terminal sum, then the state poll', () => {
        const recipe = createPreprovisionedRealtimeRecipe({
            recipeId: 'realtime',
            group,
            distributedRunId: 'dist-realtime',
            connection: 'realtime-connection'
        });
        const manifest = toManifest(recipe);

        const terminalTimeoutSeconds = computeDistributedRunTerminalTimeoutSeconds({
            recipes: [recipe],
            ackTimeoutMs: manifest.ackTimeoutMs,
            barrier: manifest.barrier
        });

        expect(computeDistributedRunPassedWaitMs(manifest)).toBe(terminalTimeoutSeconds * 1_000 + 45_000);
        expect(computeDistributedRunPassedWaitMs(manifest)).toBeGreaterThan(10_000 + 135_000 + 5_000 + 45_000);
    });

    // A recipe whose commands name no timeout keeps the state poll the harness always gave it, plus the ack.
    it('keeps a health recipe at its ack and the state poll', () => {
        expect(computeDistributedRunPassedWaitMs(toManifest(healthRecipe('health')))).toBe(10_000 + 45_000);
    });
});

describe('distributed recipe test timeouts', () => {
    const runs = createLiveDistributedRecipeRuns({
        suffix: 'timeouts',
        controlRunId: 'passed-wait-run',
        group,
        agentIds: ['agent-a', 'agent-b', 'agent-c']
    });
    const manifests = toLiveDistributedRecipeManifests(runs);
    const margin = 60_000;
    /** Every request a test sends outside a poll, a command's enqueue among them, waits at most 10 s. */
    const request = 10_000;
    /**
     * Each agent's 30 s Advanced tab and 30 s registration as it opens, then its configuration enqueued and polled 20 s,
     * then the 20 s poll for all of them in the group.
     */
    const threeAgents = 3 * (2 * 30_000 + request + 20_000) + 20_000;
    /** A live agent that signs in first waits 30 s for its login gate. */
    const threeSignedInAgents = threeAgents + 3 * 30_000;
    /** The owner creates the group and each of the three agents joins it, each enqueued, its 15 s, then a 30 s poll. */
    const membership = 4 * (request + 15_000 + 30_000);
    /**
     * The panel's assertions that name no limit wait 15 s each: the listed run, each warning diagnostic's group and two
     * pills, the composite count, each agent's card summary twice, its loop and its rows, the event stream, and the
     * received message's pill, topic, connection and transport.
     */
    const panelAssertions = (1 + 2 * 3 + 1 + 3 * 4 + 1 + 4) * 15_000;
    /** A control run read outside a poll sends up to three requests that fail in transport, 250 ms apart. */
    const controlRead = 3 * request + 2 * 250;
    /** A run's evidence reads the control run, then one distributed run resource. */
    const evidenceRead = controlRead + request;
    /** The test's cleanup closes its agents side by side, each enqueued, then waited up to 15 s. */
    const cleanup = request + 15_000;
    /** A run to passed is created and staged, becomes ready within 45 s, is started, then passes. */
    const toPassedRequests = 3 * request;

    // The run's create, stage and start requests went uncounted.
    it('creates and stages a run, waits for it to become ready, starts it, then waits for it to pass', () => {
        const manifest = toManifest(healthRecipe('health'));

        expect(computeDistributedRunToPassedWaitMs(manifest))
            .toBe(2 * request + 45_000 + request + computeDistributedRunPassedWaitMs(manifest));
    });

    it('runs the live test\'s six runs in order', () => {
        expect(manifests.map((manifest) => manifest.distributedRunId)).toEqual([
            'dist-live-ack-timeouts',
            'dist-live-ws-primer-timeouts',
            'dist-live-ws-send-timeouts',
            'dist-live-rtc-connect-timeouts',
            'dist-live-rtc-send-timeouts',
            'dist-live-rtc-realtime-timeouts'
        ]);
        expect(manifests.map(computeDistributedRunPassedWaitMs)).toEqual([55_000, 100_000, 100_000, 220_000, 115_000, 256_000]);
    });

    // The live test counted neither its agents' login gates, its membership requests' result polls nor its panel's
    // assertions under the default assertion limit.
    it('gives the live test its agents, six ready and passed waits, the message polls and the warning diagnostics', () => {
        const readyAndPassed = 6 * (toPassedRequests + 45_000) + 55_000 + 100_000 + 100_000 + 220_000 + 115_000 +
            256_000;

        // The WS, RTC and realtime evidence and the run summary each read the control run and a distributed resource.
        expect(computeLiveDistributedRecipesTestTimeoutMs(runs)).toBe(
            margin + threeSignedInAgents + membership + readyAndPassed + 2 * 75_000 + 75_000 + 30_000 +
                4 * evidenceRead + panelAssertions + cleanup
        );
    });

    // The simulated ACK test configures its three agents as the live test does; its panel's 'passed' went uncounted.
    it('gives the simulated ACK test its agents, its run, the 15 s panel wait and the panel\'s passed state', () => {
        const manifest = createSimulatedAckManifest({ suffix: 'timeouts', controlRunId: 'passed-wait-run', group });

        expect(computeDistributedRunPassedWaitMs(manifest)).toBe(57_000);
        // The run to passed, its artifact read, the panel's two waits, then the run summary's reads.
        expect(computeSimulatedAckTestTimeoutMs(manifest)).toBe(
            margin + threeAgents + toPassedRequests + 45_000 + 57_000 + request + 15_000 + 15_000 + evidenceRead
        );
    });

    // The test held a fixed 180 s, while its agents, scripted agents and state waits alone wait about 555 s.
    it('gives the simulated failure test its agents, scripted agents, state waits, disconnect poll and control read', () => {
        /** Each scripted agent's 10 s socket open, then the 20 s in-group poll. */
        const scriptedAgents = 2 * (10_000 + 20_000);
        /** The ACK run's 15 s timed-out wait, the failing run's ready and failed waits and the disconnect run's ready. */
        const stateWaits = 15_000 + 3 * 45_000;
        /** The closed agent's 10 s disconnect poll, then the disconnect run's 15 s running wait. */
        const disconnect = 10_000 + 15_000;
        /**
         * The refused manifest, the missing, ACK timeout, failing and disconnect runs' create and stage, the failing and
         * disconnect runs' starts and the disconnect run's cancel: one request each.
         */
        const runRequests = (1 + 4 * 2 + 2 + 1) * request;

        expect(SIMULATED_FAILURES_TEST_TIMEOUT_MS).toBe(
            margin + threeAgents + scriptedAgents + runRequests + stateWaits + disconnect + controlRead
        );
    });
});

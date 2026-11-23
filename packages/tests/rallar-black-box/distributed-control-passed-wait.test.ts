import { describe, expect, it } from 'vitest';

import { computeDistributedRunTerminalTimeoutSeconds } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import type { RallarBlackBoxDistributedGroupRef } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import {
    computeDistributedRunPassedWaitMs,
    computeDistributedRunsTestTimeoutMs,
    DISTRIBUTED_STATE_POLL_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/distributed-recipes/distributed-control.ts';
import {
    createLiveDistributedRecipeRuns,
    createSimulatedAckManifest,
    LIVE_RECIPES_STEPS_TIMEOUT_MS,
    SIMULATED_ACK_STEPS_TIMEOUT_MS,
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

describe('computeDistributedRunsTestTimeoutMs', () => {
    const runs = createLiveDistributedRecipeRuns({
        suffix: 'timeouts',
        controlRunId: 'passed-wait-run',
        group,
        agentIds: ['agent-a', 'agent-b', 'agent-c']
    });

    it('adds every run\'s passed wait to the test\'s other steps', () => {
        const manifests = toLiveDistributedRecipeManifests(runs);

        expect(manifests.map((manifest) => manifest.distributedRunId)).toEqual([
            'dist-live-ack-timeouts',
            'dist-live-ws-primer-timeouts',
            'dist-live-ws-send-timeouts',
            'dist-live-rtc-connect-timeouts',
            'dist-live-rtc-send-timeouts',
            'dist-live-rtc-realtime-timeouts'
        ]);
        expect(computeDistributedRunsTestTimeoutMs(1_000, manifests)).toBe(
            manifests.reduce((sum, manifest) => sum + computeDistributedRunPassedWaitMs(manifest), 1_000)
        );
    });

    // The live test's 420 s covered its six runs' former 45 s passed waits and the simulated ACK test's 120 s its one;
    // only what remained besides them is each test's allowance, so no passed wait is counted twice.
    it('gives the live and simulated ACK tests only what their former limits left besides their passed waits', () => {
        expect(LIVE_RECIPES_STEPS_TIMEOUT_MS).toBe(420_000 - 6 * 45_000);
        expect(SIMULATED_ACK_STEPS_TIMEOUT_MS).toBe(120_000 - 45_000);
        expect(createSimulatedAckManifest({ suffix: 'timeouts', controlRunId: 'passed-wait-run', group }).recipes)
            .toHaveLength(1);
    });
});

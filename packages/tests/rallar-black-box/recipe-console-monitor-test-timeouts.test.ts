import { describe, expect, it } from 'vitest';

import { computeDistributedRunPassedWaitMs } from '../../../tests/playwright/rallar-black-box/distributed-recipes/distributed-control.ts';
import { createDistributedManifest, rtcConnectRecipe } from '../../../tests/playwright/rallar-black-box/distributed-recipes/recipe-manifests.ts';
import {
    computeConsoleNativeTestTimeoutMs,
    CONSOLE_LIFECYCLE_TEST_TIMEOUT_MS,
    CONSOLE_NATIVE_SETUP_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/recipe-console-monitor-test-timeouts.ts';

const group = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'console-native-room' };

/** The full-stack configuration's default assertion limit. */
const E = 15_000;
/** Every request the test sends outside a poll waits at most 10 s. */
const REQUEST = 10_000;
/** A control run read outside a poll sends up to three requests that fail in transport, 250 ms apart. */
const CONTROL_READ = 3 * REQUEST + 2 * 250;
/** The API and control probes side by side, then the API's readiness read. */
const SERVICE_READINESS = REQUEST + REQUEST;
/** The operator's login gate, its 30 s run header, then its Rallar Server tab and panel. */
const SIGN_IN = E + 30_000 + 2 * E;
/** The agent setup and its run ID, the 30 s launched pages poll, then the 60 s ready and selected status. */
const LAUNCH = 2 * E + 30_000 + 60_000;
/** The 30 s poll for the launched agents in the control run. */
const AGENTS_POLL = 30_000;
/** The selected recipe's three checks, the 30 s target list, each target, then their match. */
function targets(agentCount: number): number {
    return 3 * E + 30_000 + agentCount * E + E;
}
/** Each agent page's cleanup clicks up to seven buttons, each for up to 2 s; the pages clean up side by side. */
const CLEANUP = 7 * 2_000;

describe('Console Native test timeout', () => {
    // The setup counted its probes at 5 s and its API readiness read not at all; earlier, none of its assertions under
    // the default 15 s limit.
    it('gives the setup its service readiness, sign-in, launched pages, their connection, targets and addresses', () => {
        expect(CONSOLE_NATIVE_SETUP_TIMEOUT_MS)
            .toBe(60_000 + SERVICE_READINESS + SIGN_IN + LAUNCH + AGENTS_POLL + targets(2) + E);
    });

    // The distributed run reads went uncounted and the control run reads were counted by their pauses alone; earlier,
    // the capture control's three states, the draft state, the Monitor's address twice, each agent's 30 s recorder read
    // and the pages' bounded cleanup clicks.
    it('adds the 60 s stage wait, the started run to passed, the run reads, the 30 s Monitor verdict and the cleanup', () => {
        const recipe = rtcConnectRecipe('console-native-connect', group);
        const manifest = createDistributedManifest({
            distributedRunId: 'dist-console-native',
            controlRunId: 'console-native-run',
            group,
            recipes: [{ recipeId: recipe.recipeId, recipe, profile: 'live-rtc', variables: {} }],
            targetPolicy: { mode: 'all-online-group-members', expectedParticipantCount: 2 }
        });

        const assertions = (1 + 1 + 2 + 1 + 2) * E;
        /** The control run before the draft, once staged and once passed. */
        const controlReads = 3 * CONTROL_READ;
        /** The distributed run once drafted, once staged and once passed. */
        const distributedReads = 3 * REQUEST;

        expect(computeConsoleNativeTestTimeoutMs(manifest)).toBe(
            440_000 + assertions + 60_000 + computeDistributedRunPassedWaitMs(manifest) + controlReads +
                distributedReads + 2 * 30_000 + 30_000 + CLEANUP
        );
    });

    // The probes were counted at 5 s and the API readiness read, the staged run's read and the reads after the cancel
    // proof by their pauses at most; earlier, the test held a fixed 240 s.
    it('gives the lifecycle test its sign-in, three agents, both runs, the cancel and its proof, and the cleanup', () => {
        /** Each run is drafted, then waits 60 s to show staged. */
        const draftAndStage = E + 60_000;
        /** The composite run passes within 90 s. */
        const passed = 90_000;
        /** Each Monitor visit checks its address twice, then waits 30 s for the verdict. */
        const monitor = 2 * E + 30_000;
        /** The operator's addresses: the Console, the Execute workspace, then the Console without the run. */
        const addresses = 3 * E;
        /** The cancel dialog shows, names the run and its state, then closes. */
        const cancelDialog = 4 * E;
        /** The second run's distributed read once staged. */
        const stagedRead = REQUEST;
        /** The cancelled verdict, then the 30 s cancel proof poll. */
        const cancel = 30_000 + 30_000;
        /** The distributed and control runs read side by side once the proof completes. */
        const proofReads = Math.max(REQUEST, CONTROL_READ);

        expect(CONSOLE_LIFECYCLE_TEST_TIMEOUT_MS).toBe(
            60_000 + SERVICE_READINESS + SIGN_IN + LAUNCH + AGENTS_POLL + 2 * (targets(3) + draftAndStage) + passed +
                2 * monitor + addresses + cancelDialog + stagedRead + cancel + proofReads + CLEANUP
        );
    });
});

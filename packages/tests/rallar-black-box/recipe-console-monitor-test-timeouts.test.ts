import { describe, expect, it } from 'vitest';

import { computeDistributedRunPassedWaitMs } from '../../../tests/playwright/rallar-black-box/distributed-recipes/distributed-control.ts';
import { createDistributedManifest, rtcConnectRecipe } from '../../../tests/playwright/rallar-black-box/distributed-recipes/recipe-manifests.ts';
import {
    computeConsoleNativeTestTimeoutMs,
    CONSOLE_NATIVE_SETUP_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/recipe-console-monitor-test-timeouts.ts';

const group = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'console-native-room' };

describe('Console Native test timeout', () => {
    // The setup counted none of its assertions under the default 15 s limit: the login gate, the tab and its panel, the
    // agent setup and its run ID, the selected recipe, its provider and prerequisite, each launched target and their
    // match, and each agent page's address.
    it('gives the setup its probes, sign-in, launched pages, their readiness, connection and targets', () => {
        const assertions = (1 + 2 + 2 + 3 + 2 + 1 + 1) * 15_000;

        expect(CONSOLE_NATIVE_SETUP_TIMEOUT_MS)
            .toBe(60_000 + 5_000 + 30_000 + 30_000 + 60_000 + 30_000 + 30_000 + assertions);
    });

    // The capture control's three states, the draft state, the Monitor's address twice, each agent's 30 s recorder read
    // and the pages' bounded cleanup clicks went uncounted.
    it('adds the 60 s stage wait, the started run to passed, the 30 s Monitor verdict and the cleanup', () => {
        const recipe = rtcConnectRecipe('console-native-connect', group);
        const manifest = createDistributedManifest({
            distributedRunId: 'dist-console-native',
            controlRunId: 'console-native-run',
            group,
            recipes: [{ recipeId: recipe.recipeId, recipe, profile: 'live-rtc', variables: {} }],
            targetPolicy: { mode: 'all-online-group-members', expectedParticipantCount: 2 }
        });

        const assertions = (1 + 1 + 2 + 1 + 2) * 15_000;
        const cleanup = 7 * 2_000;
        /** Three control run reads, each retrying a transport failure twice, 250 ms apart. */
        const controlReads = 3 * 2 * 250;

        expect(computeConsoleNativeTestTimeoutMs(manifest)).toBe(
            425_000 + assertions + 60_000 + computeDistributedRunPassedWaitMs(manifest) + controlReads + 2 * 30_000 +
                30_000 + cleanup
        );
    });
});

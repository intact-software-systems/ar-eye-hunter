import { describe, expect, it } from 'vitest';

import { computeDistributedRunPassedWaitMs } from '../../../tests/playwright/rallar-black-box/distributed-recipes/distributed-control.ts';
import { createDistributedManifest, rtcConnectRecipe } from '../../../tests/playwright/rallar-black-box/distributed-recipes/recipe-manifests.ts';
import {
    computeConsoleNativeTestTimeoutMs,
    CONSOLE_NATIVE_SETUP_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/recipe-console-monitor-test-timeouts.ts';

const group = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'console-native-room' };

describe('Console Native test timeout', () => {
    // The 150 s besides the started run held less than the setup's 185 s of waits, the stage wait and the Monitor's.
    it('gives the setup its probes, sign-in, launched pages, their readiness, connection and targets', () => {
        expect(CONSOLE_NATIVE_SETUP_TIMEOUT_MS).toBe(60_000 + 5_000 + 30_000 + 30_000 + 60_000 + 30_000 + 30_000);
    });

    it('adds the 60 s stage wait, the started run to passed and the 30 s Monitor verdict', () => {
        const recipe = rtcConnectRecipe('console-native-connect', group);
        const manifest = createDistributedManifest({
            distributedRunId: 'dist-console-native',
            controlRunId: 'console-native-run',
            group,
            recipes: [{ recipeId: recipe.recipeId, recipe, profile: 'live-rtc', variables: {} }],
            targetPolicy: { mode: 'all-online-group-members', expectedParticipantCount: 2 }
        });

        expect(computeConsoleNativeTestTimeoutMs(manifest))
            .toBe(245_000 + 60_000 + computeDistributedRunPassedWaitMs(manifest) + 30_000);
    });
});

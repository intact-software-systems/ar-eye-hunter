import { describe, expect, it } from 'vitest';

import { createViewPushManifestEntry } from '../../../apps/rallar-black-box/src/hetzner/create-view-push-manifest-entry.ts';
import { computeViewPushTestDeadlines } from '../../../tests/playwright/rallar-black-box/compute-view-push-test-deadlines.ts';

describe('view push test deadlines', () => {
    // The spec waited 90 s for manifest 24 to reach a terminal state while the manifest recommends 175 s.
    it('waits for the view push run its manifest\'s recommended terminal timeout and covers both waits', () => {
        expect(computeViewPushTestDeadlines(createViewPushManifestEntry().manifest)).toEqual({
            readinessTimeoutMs: 90_000,
            terminalTimeoutMs: 175_000,
            testTimeoutMs: 60_000 + 2 * (3 * 30_000 + 30_000) + 90_000 + 175_000
        });
    });

    // The 180 s besides the run's waits was a former total; the agents' own waits run to 240 s.
    it('gives each agent its login gate, tab and registration waits and its connection poll', () => {
        expect(computeViewPushTestDeadlines(createViewPushManifestEntry().manifest).testTimeoutMs).toBe(565_000);
    });
});

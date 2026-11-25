import { describe, expect, it } from 'vitest';

import { createViewPushManifestEntry } from '../../../apps/rallar-black-box/src/hetzner/create-view-push-manifest-entry.ts';
import { computeViewPushTestDeadlines } from '../../../tests/playwright/rallar-black-box/compute-view-push-test-deadlines.ts';

describe('view push test deadlines', () => {
    // The spec waited 90 s for manifest 24 to reach a terminal state while the manifest recommends 175 s.
    it('waits for the view push run its manifest\'s recommended terminal timeout', () => {
        expect(computeViewPushTestDeadlines(createViewPushManifestEntry().manifest)).toMatchObject({
            readinessTimeoutMs: 90_000,
            terminalTimeoutMs: 175_000
        });
    });

    // The operator's control requests went untimed and uncounted: the target resolution, create, stage and start, the
    // artifact bundle and the four native artifacts outside its state waits, and each state wait's last read.
    it('gives each agent its waits, then counts the operator\'s every control request and each state wait\'s overrun', () => {
        expect(computeViewPushTestDeadlines(createViewPushManifestEntry().manifest).testTimeoutMs).toBe(
            60_000 + 2 * (3 * 30_000 + 30_000) + 9 * 10_000 + (90_000 + 10_000 + 250) + (175_000 + 10_000 + 250)
        );
    });
});

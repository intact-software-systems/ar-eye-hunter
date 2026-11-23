import { describe, expect, it } from 'vitest';

import { DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS } from '../../../tests/playwright/rallar-black-box/director-orchestration-test-timeouts.ts';

describe('director orchestration test timeout', () => {
    // The 420 s gave the steps besides the connects 240 s while the agents' openings alone wait up to 270 s.
    it('gives the director scenario every bounded wait it runs and the harness margin', () => {
        const openings = 3 * 3 * 30_000;
        const connects = 135_000 + 45_000;
        const readiness = 60_000;
        const intents = 2 * 30_000;
        const events = 2 * 60_000;

        expect(DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS)
            .toBe(60_000 + openings + connects + readiness + intents + events + 1_900);
    });
});

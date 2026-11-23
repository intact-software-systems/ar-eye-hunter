import { describe, expect, it } from 'vitest';

import {
    computeLiveRtcLifecycleScenarioTimeoutMs,
    PRESENCE_CONNECT_RESULT_WAIT_MS,
    REOPENING_SCENARIO_PRESENCE_CONNECTS,
    TRIO_PRESENCE_CONNECTS
} from '../../../tests/playwright/rallar-black-box/compute-live-rtc-lifecycle-scenario-timeout-ms.ts';

describe('live RTC lifecycle scenario timeouts', () => {
    it('waits for each presence connect its 135 s command timeout and the 45 s result poll', () => {
        expect(PRESENCE_CONNECT_RESULT_WAIT_MS).toBe(135_000 + 45_000);
    });

    // A scenario's 300 s covered the trio's three presence connects at their former 90 s waits; only the 30 s besides
    // them remains for its other steps, so the derived connect waits are not counted twice.
    it('adds each presence connect\'s derived wait to the 30 s the scenario\'s other steps had', () => {
        expect(computeLiveRtcLifecycleScenarioTimeoutMs(TRIO_PRESENCE_CONNECTS)).toBe(30_000 + 3 * 180_000);
        expect(computeLiveRtcLifecycleScenarioTimeoutMs(REOPENING_SCENARIO_PRESENCE_CONNECTS)).toBe(30_000 + 4 * 180_000);
    });
});

import { describe, expect, it } from 'vitest';

import {
    FORMATION_CONNECT_RESULT_WAIT_MS,
    FORMATION_RUN_CONNECT_RESULT_WAIT_MS
} from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import {
    LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS,
    LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS,
    LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS,
    RETENTION_RECONNECT_CYCLES
} from '../../../tests/playwright/rallar-black-box/live-rtc-matrix-test-timeouts.ts';

describe('live RTC three-browser matrix test timeouts', () => {
    it('waits for each formation connect its 135 s command timeout and the 45 s result poll', () => {
        expect(FORMATION_CONNECT_RESULT_WAIT_MS).toBe(180_000);
        expect(FORMATION_RUN_CONNECT_RESULT_WAIT_MS).toBe(3 * 180_000);
    });

    // The proof's 360 s went entirely to its six formation connects at their former 60 s waits, leaving nothing for its
    // other steps, so it stays as its steps' allowance.
    it('keeps the proof matrix\'s 360 s for its other steps beside two formation runs', () => {
        expect(LIVE_RTC_MATRIX_PROOF_TEST_TIMEOUT_MS).toBe(360_000 + 2 * 540_000);
    });

    // The 720 s covered two formation runs and the reconnect at 60 s each; 300 s remain for the other steps.
    it('gives every-scenario run the 300 s its 720 s left besides its seven connects', () => {
        expect(LIVE_RTC_ALL_SCENARIOS_TEST_TIMEOUT_MS).toBe(300_000 + 2 * 540_000 + 180_000);
    });

    // The soak's derived 1,800 s + one formation run + a reconnect per cycle is 20,340 s, longer than the B06 job that
    // runs it; each reconnect is already bounded by its own wait, so the soak is capped at three hours.
    it('caps the retention soak at its three-hour operational bound below its derived sum', () => {
        expect(1_800_000 + 540_000 + RETENTION_RECONNECT_CYCLES * 180_000).toBe(20_340_000);
        expect(LIVE_RTC_RETENTION_SOAK_TEST_TIMEOUT_MS).toBe(3 * 60 * 60_000);
    });
});

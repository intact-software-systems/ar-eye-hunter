import { describe, expect, it } from 'vitest';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin.ts';
import {
    computeLiveRtcLifecycleScenarioTimeoutMs,
    PRESENCE_CONNECT_RESULT_WAIT_MS
} from '../../../tests/playwright/rallar-black-box/compute-live-rtc-lifecycle-scenario-timeout-ms.ts';

const CONNECT = 180_000;
const MARGIN = 60_000;
/** Presence settles 5 s, the connect after planning retries for 60 s, and each of the trio's dials is polled 90 s. */
const ACTIVATION = 3 * CONNECT + 5_000 + 60_000 + 3 * 90_000;
/** The reopened member connects again and the two survivors refresh their rooms for 20 s each. */
const REOPENING = CONNECT + 2 * 20_000;

describe('live RTC lifecycle scenario timeouts', () => {
    it('waits for each presence connect its 135 s command timeout and the 45 s result poll', () => {
        expect(PRESENCE_CONNECT_RESULT_WAIT_MS).toBe(135_000 + 45_000);
        expect(BROWSER_TEST_HARNESS_MARGIN_MS).toBe(MARGIN);
    });

    // The scenarios had 30 s besides their connects while their own waits ran to 335 s (discovery) through 985 s (reset).
    it('gives each scenario every bounded wait it runs and the harness margin', () => {
        expect({
            discovery: computeLiveRtcLifecycleScenarioTimeoutMs('discovery'),
            monotonicReadiness: computeLiveRtcLifecycleScenarioTimeoutMs('monotonic-readiness'),
            acceptedLayoutBarrier: computeLiveRtcLifecycleScenarioTimeoutMs('accepted-layout-barrier'),
            reset: computeLiveRtcLifecycleScenarioTimeoutMs('reset'),
            hydration: computeLiveRtcLifecycleScenarioTimeoutMs('hydration')
        }).toEqual({
            // The trio connects, holds 5 s undialed, then the plan's connect dials every member.
            discovery: MARGIN + 3 * CONNECT + 5_000 + 60_000 + 3 * 90_000,
            // The reopened member's 60 s readiness, then its 15 s diagnostics poll.
            monotonicReadiness: MARGIN + ACTIVATION + REOPENING + 60_000 + 15_000,
            // The reopened member reads its health up to 15 times 2 s apart, then waits 60 s for readiness.
            acceptedLayoutBarrier: MARGIN + ACTIVATION + REOPENING + 15 * 2_000 + 60_000,
            // Each member's 45 s dormant stage and 60 s lane teardown, a 5 s hold, then the next series dials again.
            reset: MARGIN + ACTIVATION + 3 * (45_000 + 60_000) + 5_000 + 60_000 + 3 * 90_000,
            // The owner's 45 s dormant stage, the reopened member's presence and its 15 s room refresh.
            hydration: MARGIN + ACTIVATION + 45_000 + CONNECT + 15_000
        });
    });
});

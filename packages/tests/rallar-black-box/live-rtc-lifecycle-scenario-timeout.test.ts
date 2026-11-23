import { describe, expect, it } from 'vitest';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import {
    computeLiveRtcLifecycleScenarioTimeoutMs,
    PRESENCE_CONNECT_RESULT_WAIT_MS
} from '../../../tests/playwright/rallar-black-box/compute-live-rtc-lifecycle-scenario-timeout-ms.ts';

const CONNECT = 180_000;
const MARGIN = 60_000;
/** Each of the trio's agents waits 30 s for its registration as it opens, one after another. */
const TRIO_OPEN = 3 * 30_000;
/** The owner creates the group and the two other members join it, each request under its own 10 s. */
const MEMBERSHIP = 3 * 10_000;
/** The connect after planning retries for 60 s, and its last attempt may then wait its full 45 s result poll. */
const CONNECT_WHEN_PLANNED = 60_000 + 45_000;
/** The connect after planning, then each of the trio's dials polled 90 s. */
const DIALS = CONNECT_WHEN_PLANNED + 3 * 90_000;
/** Membership, the trio's presence connects, the 5 s presence settle, then the dials. */
const ACTIVATION = MEMBERSHIP + 3 * CONNECT + 5_000 + DIALS;
/** The reopened member waits 30 s for its registration and connects again. */
const REOPENED_PRESENCE = 30_000 + CONNECT;
/** The reopened member's presence, then the two survivors refresh their rooms for 20 s each. */
const REOPENING = REOPENED_PRESENCE + 2 * 20_000;

describe('live RTC lifecycle scenario timeouts', () => {
    it('waits for each presence connect its 135 s command timeout and the 45 s result poll', () => {
        expect(PRESENCE_CONNECT_RESULT_WAIT_MS).toBe(135_000 + 45_000);
        expect(BROWSER_TEST_HARNESS_MARGIN_MS).toBe(MARGIN);
    });

    // The scenarios counted neither their agents' registration waits, their membership requests nor the result poll the
    // last connect after planning may take past its deadline.
    it('gives each scenario every bounded wait it runs and the harness margin', () => {
        expect({
            discovery: computeLiveRtcLifecycleScenarioTimeoutMs('discovery'),
            monotonicReadiness: computeLiveRtcLifecycleScenarioTimeoutMs('monotonic-readiness'),
            acceptedLayoutBarrier: computeLiveRtcLifecycleScenarioTimeoutMs('accepted-layout-barrier'),
            reset: computeLiveRtcLifecycleScenarioTimeoutMs('reset'),
            hydration: computeLiveRtcLifecycleScenarioTimeoutMs('hydration')
        }).toEqual({
            // Membership and the trio's connects, a 5 s hold undialed, then the plan's connect dials every member.
            discovery: MARGIN + TRIO_OPEN + MEMBERSHIP + 3 * CONNECT + 5_000 + DIALS,
            // The reopened member's 60 s readiness, then its 15 s diagnostics poll.
            monotonicReadiness: MARGIN + TRIO_OPEN + ACTIVATION + REOPENING + 60_000 + 15_000,
            // The reopened member reads its health up to 15 times 2 s apart, then waits 60 s for readiness.
            acceptedLayoutBarrier: MARGIN + TRIO_OPEN + ACTIVATION + REOPENING + 15 * 2_000 + 60_000,
            // Each member's 45 s dormant stage and 60 s lane teardown, a 5 s hold, then the next series dials again.
            reset: MARGIN + TRIO_OPEN + ACTIVATION + 3 * (45_000 + 60_000) + 5_000 + DIALS,
            // The owner's 45 s dormant stage, the reopened member's presence and its 15 s room refresh.
            hydration: MARGIN + TRIO_OPEN + ACTIVATION + 45_000 + REOPENED_PRESENCE + 15_000
        });
    });
});

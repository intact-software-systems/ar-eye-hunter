import { describe, expect, it } from 'vitest';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import {
    computeLiveRtcLifecycleScenarioTimeoutMs,
    PRESENCE_CONNECT_RESULT_WAIT_MS
} from '../../../tests/playwright/rallar-black-box/compute-live-rtc-lifecycle-scenario-timeout-ms.ts';

const CONNECT = 180_000;
const MARGIN = 60_000;
/** A command that names no budget of its own is polled for its result for 45 s. */
const POLL = 45_000;
/** Each agent signs in under 30 s, selects its workbench tab (15 s for the tab, 15 s for its panel), then registers. */
const AGENT_OPEN = 30_000 + 2 * 15_000 + 30_000;
/** The trio's agents open one after another. */
const TRIO_OPEN = 3 * AGENT_OPEN;
/** The owner creates the group and the two other members join it, each request its 10 s budget and then the poll. */
const MEMBERSHIP = 3 * (10_000 + POLL);
/** The connect after planning retries for 60 s; its last attempt may then wait the poll and its 500 ms retry interval. */
const CONNECT_WHEN_PLANNED = 60_000 + POLL + 500;
/** The connect after planning, then each of the trio's dials polled 90 s. */
const DIALS = CONNECT_WHEN_PLANNED + 3 * 90_000;
/** Membership, the trio's presence connects, the 5 s presence settle, the plan, the dials, then the activation. */
const ACTIVATION = MEMBERSHIP + 3 * CONNECT + 5_000 + POLL + DIALS + POLL;
/** A restored member selects its workbench tab and registers again, then connects its presence. */
const REOPENED_PRESENCE = 2 * 15_000 + 30_000 + CONNECT;
/** The reopened member's presence, then the two survivors refresh their rooms for 20 s each. */
const REOPENING = REOPENED_PRESENCE + 2 * 20_000;
/** A readiness waits 60 s; its last read may start before the deadline and then wait the poll. */
const READINESS = 60_000 + POLL;
/** A stage wait is a command whose 45 s budget is followed by the poll. */
const STAGE = 45_000 + POLL;

describe('live RTC lifecycle scenario timeouts', () => {
    it('waits for each presence connect its 135 s command timeout and the 45 s result poll', () => {
        expect(PRESENCE_CONNECT_RESULT_WAIT_MS).toBe(135_000 + 45_000);
        expect(BROWSER_TEST_HARNESS_MARGIN_MS).toBe(MARGIN);
    });

    // The scenarios counted neither the commands polled under the default result poll, the opening screens waited
    // under the default assertion limit, the membership requests' result polls, the readiness's and the stage wait's
    // result polls, nor the reopened member's health reads.
    it('gives each scenario every bounded wait it runs and the harness margin', () => {
        expect({
            discovery: computeLiveRtcLifecycleScenarioTimeoutMs('discovery'),
            monotonicReadiness: computeLiveRtcLifecycleScenarioTimeoutMs('monotonic-readiness'),
            acceptedLayoutBarrier: computeLiveRtcLifecycleScenarioTimeoutMs('accepted-layout-barrier'),
            reset: computeLiveRtcLifecycleScenarioTimeoutMs('reset'),
            hydration: computeLiveRtcLifecycleScenarioTimeoutMs('hydration')
        }).toEqual({
            // Membership and the trio's connects, a 5 s hold undialed, each member's health, the plan, then the dials.
            discovery: MARGIN + TRIO_OPEN + MEMBERSHIP + 3 * CONNECT + 5_000 + 3 * POLL + POLL + DIALS,
            // The reopened member's recording health, its readiness, then its 15 s diagnostics poll.
            monotonicReadiness: MARGIN + TRIO_OPEN + ACTIVATION + REOPENING + POLL + READINESS + 15_000,
            // The reopened member reads its health up to 15 times 2 s apart, then waits for readiness.
            acceptedLayoutBarrier: MARGIN + TRIO_OPEN + ACTIVATION + REOPENING + 15 * (POLL + 2_000) + READINESS,
            // The reset, each member's dormant stage, 60 s lane teardown and health, a 5 s hold, start, plan, the dials.
            reset: MARGIN + TRIO_OPEN + ACTIVATION + POLL + 3 * (STAGE + 60_000 + POLL) + 5_000 + 2 * POLL + DIALS,
            // The reset, the owner's dormant stage, the reopened member's presence, its health, its 15 s room refresh
            // and its health again.
            hydration: MARGIN + TRIO_OPEN + ACTIVATION + POLL + STAGE + REOPENED_PRESENCE + POLL + 15_000 + POLL
        });
    });
});

import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin.ts';
import { computeCommandResultWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-agent-opening-timeout-ms.ts';
import {
    FORMATION_READINESS_TIMEOUT_MS,
    GROUP_MEMBERSHIP_BOUNDED_WAITS_MS,
    LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS,
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-wait-budgets.ts';

/** A presence connect joins the room under the establishment SDK timeout and waits for no readiness. */
export const PRESENCE_CONNECT_TIMING: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
};

export const PRESENCE_CONNECT_RESULT_WAIT_MS = computeCommandResultWaitMs(
    PRESENCE_CONNECT_TIMING,
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS
);

/** How long a scenario holds to show that nothing dials. */
export const LIFECYCLE_HOLD_MS = 5_000;

/** How long activation waits for the trio's presence to reach the planner before planning. */
export const LIFECYCLE_PRESENCE_SETTLE_MS = 5_000;

/** How long the owner retries a connect the topology worker has not yet published a layout for. */
export const LIFECYCLE_CONNECT_WHEN_PLANNED_TIMEOUT_MS = 60_000;

/** How long an agent's recorded dials are polled for after a connect. */
export const LIFECYCLE_DIAL_POLL_TIMEOUT_MS = 90_000;

/** How long an agent waits for the group to report a lifecycle stage. */
export const LIFECYCLE_STAGE_WAIT_MS = 45_000;

/** How long a reset agent's lanes are polled until they have all closed. */
export const LIFECYCLE_LANE_TEARDOWN_POLL_TIMEOUT_MS = 60_000;

/** How long each surviving member refreshes its room after a member reopens. */
export const LIFECYCLE_SURVIVOR_REFRESH_TIMEOUT_MS = 20_000;

/** How long the reopened member's readiness diagnostics are polled for a valid progress series. */
export const LIFECYCLE_PROGRESS_DIAGNOSTICS_POLL_TIMEOUT_MS = 15_000;

/** How many times, and how far apart, a reopened member's health is read until it holds the room. */
export const LIFECYCLE_ROOM_HELD_ATTEMPTS = 15;
export const LIFECYCLE_ROOM_HELD_INTERVAL_MS = 2_000;

/** How long the reopened member of a dormant group refreshes its room. */
export const LIFECYCLE_HYDRATION_REFRESH_TIMEOUT_MS = 15_000;

/** The trio's members, each of which connects its presence, one after another. */
const TRIO_SIZE = 3;

/**
 * The connect after planning retries until its deadline; its last attempt may start just before the deadline and then
 * wait its full result poll, since the formation command names no budget of its own.
 */
const CONNECT_WHEN_PLANNED_BOUNDED_WAITS_MS = LIFECYCLE_CONNECT_WHEN_PLANNED_TIMEOUT_MS +
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS;

/** The connect after planning, then each member's dial poll. */
const DIAL_BOUNDED_WAITS_MS = CONNECT_WHEN_PLANNED_BOUNDED_WAITS_MS + TRIO_SIZE * LIFECYCLE_DIAL_POLL_TIMEOUT_MS;

/** The trio's membership and presence connects, then the presence settle and the plan's connect dialing every member. */
const ACTIVATION_BOUNDED_WAITS_MS = GROUP_MEMBERSHIP_BOUNDED_WAITS_MS + TRIO_SIZE * PRESENCE_CONNECT_RESULT_WAIT_MS +
    LIFECYCLE_PRESENCE_SETTLE_MS + DIAL_BOUNDED_WAITS_MS;

/** A member reopens until it registers again, then connects its presence. */
const REOPENED_PRESENCE_BOUNDED_WAITS_MS = CONTROL_AGENT_OPENING_TIMEOUT_MS + PRESENCE_CONNECT_RESULT_WAIT_MS;

/** A member's reopened presence, then the two survivors refresh their rooms in turn. */
const REOPENING_BOUNDED_WAITS_MS = REOPENED_PRESENCE_BOUNDED_WAITS_MS + 2 * LIFECYCLE_SURVIVOR_REFRESH_TIMEOUT_MS;

export type LiveRtcLifecycleScenario =
    | 'discovery'
    | 'monotonic-readiness'
    | 'accepted-layout-barrier'
    | 'reset'
    | 'hydration';

/** The bounded waits each scenario runs in order once its trio has opened. */
const SCENARIO_BOUNDED_WAITS_MS: Readonly<Record<LiveRtcLifecycleScenario, number>> = {
    /** The trio's membership and connects, a hold undialed, then the plan's connect dials every member. */
    discovery: GROUP_MEMBERSHIP_BOUNDED_WAITS_MS + TRIO_SIZE * PRESENCE_CONNECT_RESULT_WAIT_MS + LIFECYCLE_HOLD_MS +
        DIAL_BOUNDED_WAITS_MS,
    /** Activation, a reopening, the reopened member's readiness and its progress diagnostics. */
    'monotonic-readiness': ACTIVATION_BOUNDED_WAITS_MS + REOPENING_BOUNDED_WAITS_MS + FORMATION_READINESS_TIMEOUT_MS +
        LIFECYCLE_PROGRESS_DIAGNOSTICS_POLL_TIMEOUT_MS,
    /** Activation, a reopening, the reopened member taking the room, then its readiness. */
    'accepted-layout-barrier': ACTIVATION_BOUNDED_WAITS_MS + REOPENING_BOUNDED_WAITS_MS +
        LIFECYCLE_ROOM_HELD_ATTEMPTS * LIFECYCLE_ROOM_HELD_INTERVAL_MS + FORMATION_READINESS_TIMEOUT_MS,
    /** Activation, every member's dormant stage and lane teardown, a hold, then the next series dials again. */
    reset: ACTIVATION_BOUNDED_WAITS_MS +
        TRIO_SIZE * (LIFECYCLE_STAGE_WAIT_MS + LIFECYCLE_LANE_TEARDOWN_POLL_TIMEOUT_MS) +
        LIFECYCLE_HOLD_MS + DIAL_BOUNDED_WAITS_MS,
    /** Activation, the owner's dormant stage, a reopening member's presence and its room refresh. */
    hydration: ACTIVATION_BOUNDED_WAITS_MS + LIFECYCLE_STAGE_WAIT_MS + REOPENED_PRESENCE_BOUNDED_WAITS_MS +
        LIFECYCLE_HYDRATION_REFRESH_TIMEOUT_MS
};

/** A scenario's timeout: its trio opening, the bounded waits it then runs in order, and the harness margin. */
export function computeLiveRtcLifecycleScenarioTimeoutMs(scenario: LiveRtcLifecycleScenario): number {
    return BROWSER_TEST_HARNESS_MARGIN_MS + LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS +
        SCENARIO_BOUNDED_WAITS_MS[scenario];
}

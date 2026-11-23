import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { computeCommandResultWaitMs } from './compute-command-result-wait-ms.ts';
import { LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS } from './live-rtc-control-client.ts';

/** A presence connect joins the room under the establishment SDK timeout and waits for no readiness. */
export const PRESENCE_CONNECT_TIMING: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
};

export const PRESENCE_CONNECT_RESULT_WAIT_MS = computeCommandResultWaitMs(
    PRESENCE_CONNECT_TIMING,
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS
);

/** A scenario's steps besides its presence connects. */
const SCENARIO_STEPS_TIMEOUT_MS = 30_000;

/** Every agent of the trio connects its presence, one after another. */
export const TRIO_PRESENCE_CONNECTS = 3;

/** The trio connects, then the member the scenario reopens connects again. */
export const REOPENING_SCENARIO_PRESENCE_CONNECTS = TRIO_PRESENCE_CONNECTS + 1;

/** A scenario's presence connects run one after another, so each adds its whole wait to the scenario's steps. */
export function computeLiveRtcLifecycleScenarioTimeoutMs(presenceConnects: number): number {
    return SCENARIO_STEPS_TIMEOUT_MS + presenceConnects * PRESENCE_CONNECT_RESULT_WAIT_MS;
}

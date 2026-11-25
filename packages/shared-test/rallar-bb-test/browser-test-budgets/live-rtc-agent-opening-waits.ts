import { CONTROL_AGENT_OPENING_TIMEOUT_MS } from './control-agent-opening-timeout-ms.ts';
import {
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS,
    LIVE_RTC_TRIO_SIZE
} from './live-rtc-control-waits.ts';
import { FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS } from './playwright-expect-timeouts.ts';

/** A restored agent selects its workbench tab, then registers with the control server. */
export const LIVE_RTC_AGENT_REOPEN_BOUNDED_WAITS_MS = FULL_STACK_TAB_OPEN_BOUNDED_WAITS_MS +
    CONTROL_AGENT_OPENING_TIMEOUT_MS;

/** An agent that signs in first waits for the login gate, then opens as a restored agent does. */
export const LIVE_RTC_AGENT_OPEN_BOUNDED_WAITS_MS = CONTROL_AGENT_OPENING_TIMEOUT_MS +
    LIVE_RTC_AGENT_REOPEN_BOUNDED_WAITS_MS;

/** A trio opens its agents one after another. */
export const LIVE_RTC_AGENT_TRIO_OPEN_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE * LIVE_RTC_AGENT_OPEN_BOUNDED_WAITS_MS;

/** Browser recording admission reads each of the trio's agents' health in turn, a command that names no budget. */
export const LIVE_RTC_RECORDING_ADMISSION_BOUNDED_WAITS_MS = LIVE_RTC_TRIO_SIZE *
    LIVE_RTC_CONTROL_RESULT_POLL_TIMEOUT_MS;

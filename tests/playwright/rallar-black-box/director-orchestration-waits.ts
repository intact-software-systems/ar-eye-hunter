import { RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/fixtures/live-rtc-setup.ts';
import type { RallarBlackBoxTestRtcConnectCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** The scenario's agents: A, which it appoints director, and its clients B and C. */
export const DIRECTOR_AGENT_PREFIXES = ['A', 'B', 'C'] as const;

/** Each agent joins the room under the establishment SDK timeout and waits for no readiness. */
export const DIRECTOR_CONNECT_TIMING: RallarBlackBoxTestRtcConnectCommand = {
    kind: 'rtc.connect',
    timeoutMs: RALLAR_BLACK_BOX_RTC_ROOM_CONNECT_TIMEOUT_MS
};

/** Each group creation or membership request's own budget. */
export const DIRECTOR_GROUP_REQUEST_TIMEOUT_MS = 10_000;

/** How long one health read of the peer readiness poll is polled for its result; the readiness poll bounds it. */
export const DIRECTOR_HEALTH_RESULT_POLL_TIMEOUT_MS = 15_000;

/** How long an agent's health is polled until it reports its expected peers ready. */
export const DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS = 60_000;

/** The appointment's own budget. */
export const DIRECTOR_APPOINT_TIMEOUT_MS = 20_000;

/** Each relay start's own budget. */
export const DIRECTOR_RELAY_START_TIMEOUT_MS = 20_000;

/** How long a relayed intent is polled for the director's receipt once the intent is enqueued. */
export const DIRECTOR_INTENT_RESULT_POLL_TIMEOUT_MS = 30_000;

/** How long the control run is polled for an agent's director event. */
export const DIRECTOR_EVENT_POLL_TIMEOUT_MS = 60_000;

/** How long the clients wait, once the director's relay stops, for its heartbeat to expire. */
export const DIRECTOR_STALE_HOLD_MS = 1_900;

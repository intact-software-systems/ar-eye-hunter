import { BROWSER_TEST_HARNESS_MARGIN_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/browser-test-harness-margin-ms.ts';
import {
    computeCommandResultWaitMs,
    computeEnqueuedCommandWaitMs
} from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';

import { DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS } from './director-orchestration-operations.ts';
import {
    DIRECTOR_AGENT_PREFIXES,
    DIRECTOR_APPOINT_TIMEOUT_MS,
    DIRECTOR_CONNECT_TIMING,
    DIRECTOR_EVENT_POLL_TIMEOUT_MS,
    DIRECTOR_GROUP_REQUEST_TIMEOUT_MS,
    DIRECTOR_INTENT_RESULT_POLL_TIMEOUT_MS,
    DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS,
    DIRECTOR_RELAY_START_TIMEOUT_MS,
    DIRECTOR_STALE_HOLD_MS
} from './director-orchestration-waits.ts';
import {
    BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS,
    RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS
} from './full-stack-helpers.ts';
import { CONTROL_GET_BOUNDED_WAITS_MS } from './read-control-get-response.ts';

/** The director's clients: every agent but A. */
const DIRECTOR_CLIENT_COUNT = DIRECTOR_AGENT_PREFIXES.length - 1;

/** A command that names no budget of its own waits its enqueue request, then the whole result poll. */
const DIRECTOR_UNBUDGETED_COMMAND_WAIT_MS = computeEnqueuedCommandWaitMs(DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS);

/** The owner creates the group, then each agent joins it, each request its enqueue, its budget and the result poll. */
const MEMBERSHIP_BOUNDED_WAITS_MS = (1 + DIRECTOR_AGENT_PREFIXES.length) *
    computeEnqueuedCommandWaitMs(DIRECTOR_GROUP_REQUEST_TIMEOUT_MS + DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS);

/** The agents connect side by side, then poll their peer readiness side by side. */
const CONNECTS_BOUNDED_WAITS_MS = computeCommandResultWaitMs(
    DIRECTOR_CONNECT_TIMING,
    DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS
) + DIRECTOR_PEER_READINESS_POLL_TIMEOUT_MS;

/** A appoints itself under its budget, then each agent reads its status, a command that names no budget. */
const APPOINTMENT_BOUNDED_WAITS_MS = computeEnqueuedCommandWaitMs(
    DIRECTOR_APPOINT_TIMEOUT_MS + DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS
) + DIRECTOR_AGENT_PREFIXES.length * DIRECTOR_UNBUDGETED_COMMAND_WAIT_MS;

/** Each agent starts its relay under its budget, in turn. */
const RELAYS_BOUNDED_WAITS_MS = DIRECTOR_AGENT_PREFIXES.length *
    computeEnqueuedCommandWaitMs(DIRECTOR_RELAY_START_TIMEOUT_MS + DIRECTOR_COMMAND_RESULT_POLL_TIMEOUT_MS);

/** Each client relays its intent in turn, then the intent and output events arrive side by side. */
const INTENTS_BOUNDED_WAITS_MS =
    DIRECTOR_CLIENT_COUNT * computeEnqueuedCommandWaitMs(DIRECTOR_INTENT_RESULT_POLL_TIMEOUT_MS) +
    DIRECTOR_EVENT_POLL_TIMEOUT_MS;

/** Each client requests a sync in turn, then their snapshots arrive side by side. */
const SYNCS_BOUNDED_WAITS_MS = DIRECTOR_CLIENT_COUNT * DIRECTOR_UNBUDGETED_COMMAND_WAIT_MS +
    DIRECTOR_EVENT_POLL_TIMEOUT_MS;

/** A's relay stops, the stale hold, each client's status read, then each client's relay stops. */
const STALE_BOUNDED_WAITS_MS = DIRECTOR_UNBUDGETED_COMMAND_WAIT_MS + DIRECTOR_STALE_HOLD_MS +
    2 * DIRECTOR_CLIENT_COUNT * DIRECTOR_UNBUDGETED_COMMAND_WAIT_MS;

/** What `runDirectorOrchestration` waits: the membership, connects, appointment, relays, intents, syncs and staleness. */
export const DIRECTOR_SCENARIO_BOUNDED_WAITS_MS = MEMBERSHIP_BOUNDED_WAITS_MS + CONNECTS_BOUNDED_WAITS_MS +
    APPOINTMENT_BOUNDED_WAITS_MS + RELAYS_BOUNDED_WAITS_MS + INTENTS_BOUNDED_WAITS_MS + SYNCS_BOUNDED_WAITS_MS +
    STALE_BOUNDED_WAITS_MS;

/**
 * The agents opened in turn, the scenario, the run and its artifacts read (spec lines after the scenario), and the
 * pages' cleanup side by side.
 */
export const DIRECTOR_ORCHESTRATION_TEST_TIMEOUT_MS = BROWSER_TEST_HARNESS_MARGIN_MS +
    DIRECTOR_AGENT_PREFIXES.length * BROWSER_CONTROL_AGENT_OPEN_BOUNDED_WAITS_MS +
    DIRECTOR_SCENARIO_BOUNDED_WAITS_MS +
    2 * CONTROL_GET_BOUNDED_WAITS_MS +
    RALLAR_PAGE_CLEANUP_BOUNDED_WAITS_MS;

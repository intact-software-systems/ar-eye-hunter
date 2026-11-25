import { describe, expect, it } from 'vitest';

import {
    TWO_AGENT_CONNECT_STAGE_WAIT_MS,
    TWO_AGENT_DELIVERY_SMOKE_TEST_TIMEOUT_MS,
    TWO_AGENT_DISCONNECT_SMOKE_TEST_TIMEOUT_MS,
    TWO_AGENT_RELOAD_SMOKE_TEST_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/two-agent-smoke-test-timeouts.ts';

const MARGIN = 60_000;
/** A command that names no budget of its own is polled for its result for 45 s. */
const POLL = 45_000;
const CONNECT_STAGE = 135_000 + 30_000 + POLL;
/** Each agent opens through its login gate, its workbench and its registration, each under the 30 s opening limit. */
const AGENTS = 2 * 3 * 30_000;
/** The owner creates the group and both agents join it, each request its 5 s budget and then the poll. */
const MEMBERSHIP = 3 * (5_000 + POLL);
/** A delivery's send under its budget and then the poll, the 45 s message poll, and the 10 s visible inbox. */
function delivery(sendTimeoutMs: number, visibleInbox: boolean): number {
    return sendTimeoutMs + POLL + 45_000 + (visibleInbox ? 10_000 : 0);
}
/** Each agent's health, stats, report recipe, close and reset, the agents side by side, then the 20 s evidence poll. */
const FINALIZE = 5 * POLL + 20_000;

describe('two-agent smoke test timeouts', () => {
    it('waits for a connect stage its 135 s connect, its 30 s readiness and the 45 s result poll', () => {
        expect(TWO_AGENT_CONNECT_STAGE_WAIT_MS).toBe(CONNECT_STAGE);
    });

    // The smokes counted neither their agents' opening screens, their membership requests, their sends' result
    // polls, their visible inboxes, their health reads nor their agents' finalization.
    it('gives the delivery smoke its agents, membership, connects, two deliveries and the finalization', () => {
        expect(TWO_AGENT_DELIVERY_SMOKE_TEST_TIMEOUT_MS).toBe(
            MARGIN + AGENTS + MEMBERSHIP + CONNECT_STAGE + 2 * delivery(30_000, true) + FINALIZE
        );
    });

    it('gives the reload smoke both connect stages, three deliveries, its health reads, the reload and the finalization', () => {
        expect(TWO_AGENT_RELOAD_SMOKE_TEST_TIMEOUT_MS).toBe(
            MARGIN + AGENTS + MEMBERSHIP + CONNECT_STAGE + delivery(30_000, false) + 2 * POLL + 2 * 30_000 + POLL +
                CONNECT_STAGE + POLL + 2 * delivery(45_000, true) + 2 * POLL + FINALIZE
        );
    });

    // The disconnect smoke added its two connect stages to the configuration's 30 s.
    it('gives the disconnect smoke its connects, two deliveries, the close and its 1 s settle, and the finalization', () => {
        expect(TWO_AGENT_DISCONNECT_SMOKE_TEST_TIMEOUT_MS).toBe(
            MARGIN + AGENTS + MEMBERSHIP + CONNECT_STAGE + delivery(30_000, false) + POLL + POLL + 1_000 + POLL +
                CONNECT_STAGE + delivery(30_000, false) + POLL + FINALIZE
        );
    });
});

import { describe, expect, it } from 'vitest';

import {
    computeWorkerHostCaptureTestTimeoutMs,
    WORKER_HOST_REFUSAL_TEST_TIMEOUT_MS
} from '../../../tests/playwright/rallar-black-box/worker-host-capture-test-timeouts.ts';

const MARGIN = 60_000;
/** A command that names no budget of its own is polled for its result for 45 s. */
const POLL = 45_000;
/** Each of the two workers' agents registers with the control server within 45 s. */
const REGISTRATIONS = 2 * 45_000;
/** The first agent creates the group, then each agent joins it, each request its 45 s budget and then the poll. */
const MEMBERSHIP = 3 * (45_000 + POLL);
/** Each agent's issued session is read once it authenticated and again once it connected. */
const SESSION_READS = 2 * 2 * POLL;
/** A recipe of one connect: its 135 s connect and 10 s readiness, then the poll; the agents connect side by side. */
const CONNECT = 135_000 + 10_000 + POLL;
/** Under Native capture each agent's acquisition is read from the recorder for up to 30 s. */
const NATIVE_READS = 2 * 30_000;
/** A recipe of one send: its 60 s budget, then the poll. */
const SEND = 60_000 + POLL;
/** The receiver waits 60 s for the message. */
const RECEIVE = 60_000;
/** The worker is given 10 s to release its browser after SIGTERM. */
const STOP = 10_000;

describe('worker HOST capture test timeouts', () => {
    // The configuration's 90 s covered the registrations, the memberships, the session reads, the receive and the
    // retirement, which wait about 600 s once each membership waits its 45 s budget and then the result poll.
    it.each([
        { mode: 'native' as const, nativeReads: NATIVE_READS },
        { mode: 'off' as const, nativeReads: 0 }
    ])('gives the $mode capture its registrations, memberships, connects, reads, send, receive and stop', ({ mode, nativeReads }) => {
        expect(computeWorkerHostCaptureTestTimeoutMs(mode)).toBe(
            MARGIN + REGISTRATIONS + MEMBERSHIP + SESSION_READS + CONNECT + nativeReads + SEND + RECEIVE + STOP
        );
    });

    it('gives the malformed HOST test its 10 s refusal and the worker\'s stop', () => {
        expect(WORKER_HOST_REFUSAL_TEST_TIMEOUT_MS).toBe(MARGIN + 10_000 + STOP);
    });
});

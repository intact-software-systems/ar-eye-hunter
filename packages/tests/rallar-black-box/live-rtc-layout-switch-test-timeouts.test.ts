import { describe, expect, it } from 'vitest';

import { LIVE_RTC_LAYOUT_SWITCH_TEST_TIMEOUT_MS } from '../../../tests/playwright/rallar-black-box/live-rtc-layout-switch-test-timeouts.ts';

const MARGIN = 60_000;
/** Every command's enqueue request, and every control run read outside a poll, waits at most 10 s. */
const REQUEST = 10_000;
/** A command that names no budget of its own is enqueued, then polled for its result for 45 s. */
const POLL = REQUEST + 45_000;
/** Each of the trio's agents signs in (30 s), selects its workbench tab (two 15 s waits) and registers (30 s). */
const TRIO_OPEN = 3 * (30_000 + 2 * 15_000 + 30_000);
/** Browser recording admission reads each agent's health. */
const ADMISSION = 3 * POLL;
/** The owner creates the group and the two other members join it, each request its 10 s budget and then the poll. */
const MEMBERSHIP = 3 * (10_000 + POLL);
/** The formation run, as the matrix tests count it. */
const FORMATION = 3 * (REQUEST + 180_000 + 30_000) +
    2 * (10_000 + POLL + REQUEST + 15_000 + 30_000 + 3 * POLL + 60_000 + POLL) + 60_000;
/** The `/api/config` read and each topology write: a 10 s budget, then the poll. */
const OWNER_REQUEST = 10_000 + POLL;
/** Every browser's health, read in turn. */
const COMMON_LAYOUT_READ = 3 * POLL;
/** A stream, enqueued, then its 65 s of frames and its two 5 s drains, the caller's own wait. */
const STREAM = REQUEST + 3_000 + 2 * (15_000 + 16_000) + 2 * 5_000;
/**
 * The 3 s lead, switch 1's write and 15 s promotion poll, the 16 s hold, the tree's layout read, the two leaves'
 * health, then switch 2's write and promotion poll.
 */
const SWITCHES = 3_000 + OWNER_REQUEST + 15_000 + 16_000 + COMMON_LAYOUT_READ + 2 * POLL + OWNER_REQUEST + 15_000;
/** The receivers drain for at most as long as the streams ran, their last read of the run starting just before. */
const DRAIN = 3_000 + 2 * (15_000 + 16_000) + REQUEST;
/** The diagnostics capture reads each agent, each read enqueued and then waited up to 30 s. */
const DIAGNOSTICS = 3 * (REQUEST + 30_000);
/** The run summary's read once the diagnostics are captured. */
const RUN_SUMMARY = REQUEST;

describe('live RTC layout switch test timeout', () => {
    // No command's enqueue request and no control run read outside a poll was counted. Earlier, the test gave its steps a fixed 360 s beside the formation's connects, while its counted waits alone ran to
    // about 1,940 s once each budgeted command waited its budget and then the result poll.
    it('gives each switch test its trio, formation, layout reads, switches beside the streams, drain and diagnostics', () => {
        expect(LIVE_RTC_LAYOUT_SWITCH_TEST_TIMEOUT_MS).toBe(
            MARGIN + TRIO_OPEN + ADMISSION + MEMBERSHIP + FORMATION + OWNER_REQUEST + COMMON_LAYOUT_READ +
                Math.max(STREAM, SWITCHES) + DRAIN + DIAGNOSTICS + RUN_SUMMARY
        );
    });
});

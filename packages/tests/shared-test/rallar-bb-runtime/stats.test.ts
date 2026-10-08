import { describe, expect, it } from 'vitest';

import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionReport
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import {
    createRallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxTestRecord,
    type RallarBlackBoxTestStatsSnapshot
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { createBrowserRallarRequiredMethodsTestDouble } from '../browser-rallar-required-methods-test-double.ts';
import { createDeterministicRuntime } from './create-deterministic-runtime.ts';

const FIRST_REPORT: ALVolatileSessionReport = {
    usage: { admissions: 3, bytes: 912, oldestAgeMs: 1_250, tracks: 2 },
    limits: AL_VOLATILE_SESSION_LIMITS,
    overloaded: false
};
const SECOND_REPORT: ALVolatileSessionReport = {
    usage: { admissions: 1_000, bytes: 40_000, oldestAgeMs: 29_000, tracks: 64 },
    limits: AL_VOLATILE_SESSION_LIMITS,
    overloaded: true
};

/** A page that answers each ledger read with the next value, holding the last one. */
function createPageRuntime(
    readings: readonly (ALVolatileSessionReport | RallarBlackBoxTestRecord | undefined)[]
): RallarBlackBoxBrowserTestRuntime {
    let index = 0;
    return createRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async () => ({ connected: true }),
            send: async () => ({ sent: true }),
            readAlmUsage: async () => readings[Math.min(index++, readings.length - 1)],
            refreshRoom: async () => undefined,
            close: async () => ({ closed: true }),
            health: async () => ({ connected: true })
        }
    });
}

async function readStats(runtime: RallarBlackBoxBrowserTestRuntime, commandId: string): Promise<RallarBlackBoxTestStatsSnapshot> {
    const result = await runtime.execute({ kind: 'stats', commandId });
    expect(result.ok).toBe(true);
    return result.value as RallarBlackBoxTestStatsSnapshot;
}

describe('the stats result rallar.alm block', () => {
    it('reads the page session ledger afresh at every stats command, into its result, its event and the latest stats', async () => {
        const runtime = createPageRuntime([FIRST_REPORT, SECOND_REPORT]);

        const first = await readStats(runtime, 'stats-1');
        const second = await readStats(runtime, 'stats-2');

        expect(first.rallar?.alm).toEqual(FIRST_REPORT);
        expect(second.rallar?.alm).toEqual(SECOND_REPORT);
        expect(runtime.state().latestStats?.rallar?.alm).toEqual(SECOND_REPORT);
        const statsEvents = runtime.state().events.filter((event) => event.topic === 'rallar.bb.stats');
        expect(statsEvents.map((event) => (event.payload as RallarBlackBoxTestStatsSnapshot).rallar?.alm)).toEqual([
            FIRST_REPORT,
            SECOND_REPORT
        ]);
    });

    it('carries the ledger in the stats of a health result too', async () => {
        const runtime = createPageRuntime([FIRST_REPORT]);

        const result = await runtime.execute({ kind: 'health', commandId: 'health-1' });

        expect(result.ok).toBe(true);
        expect((result.value as { stats: RallarBlackBoxTestStatsSnapshot; }).stats.rallar?.alm).toEqual(FIRST_REPORT);
    });

    it('leaves the block absent while the page has not connected', async () => {
        const stats = await readStats(createPageRuntime([undefined]), 'stats-1');

        expect(stats.rallar).toBeDefined();
        expect(stats.rallar).not.toHaveProperty('alm');
    });

    it('drops the block once the page disconnects mid-run, carrying no earlier reading forward', async () => {
        const runtime = createPageRuntime([FIRST_REPORT, undefined]);

        const connected = await readStats(runtime, 'stats-1');
        const disconnected = await readStats(runtime, 'stats-2');

        expect(connected.rallar?.alm).toEqual(FIRST_REPORT);
        expect(disconnected.rallar).not.toHaveProperty('alm');
        expect(runtime.state().latestStats?.rallar).not.toHaveProperty('alm');
    });

    it('leaves the block absent on a runtime that drives no Rallar page', async () => {
        const browserStats = await readStats(createRallarBlackBoxBrowserTestRuntime(), 'stats-1');
        const result = await createDeterministicRuntime().execute({ kind: 'stats', commandId: 'stats-2' });

        expect(browserStats.rallar).not.toHaveProperty('alm');
        expect((result.value as RallarBlackBoxTestStatsSnapshot).rallar).not.toHaveProperty('alm');
    });

    it('fails the stats command when the page answers with something that is not a ledger report, naming each bad field', async () => {
        const runtime = createPageRuntime([{ usage: { admissions: -1, bytes: 0, oldestAgeMs: 0 }, limits: AL_VOLATILE_SESSION_LIMITS, overloaded: 'no' }]);

        const result = await runtime.execute({ kind: 'stats', commandId: 'stats-1' });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toBe(
            'The page\'s session ledger report is not valid: usage.admissions is not a count; ' +
                'usage.tracks is not a count; overloaded is not a boolean'
        );
    });
});

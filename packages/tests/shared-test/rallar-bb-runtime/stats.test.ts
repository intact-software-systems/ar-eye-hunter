import {
    describe,
    expect,
    it
} from 'vitest';

import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionReport
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { RallarBlackBoxBrowserRallarRuntime } from '../../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import {
    createDefaultRallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxTestRecord,
    type RallarBlackBoxTestResult
} from '../../../shared-test/rallar-bb-test/mod.ts';
import { decodeRecord } from '../../../shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
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

function createDefaultPageRuntime(
    readAlmUsage: RallarBlackBoxBrowserRallarRuntime['readAlmUsage']
): RallarBlackBoxBrowserTestRuntime {
    return createPageRuntime(readAlmUsage, async () => ({ connected: true }));
}

function createPageRuntime(
    readAlmUsage: RallarBlackBoxBrowserRallarRuntime['readAlmUsage'],
    health: RallarBlackBoxBrowserRallarRuntime['health']
): RallarBlackBoxBrowserTestRuntime {
    return createDefaultRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async () => ({ connected: true }),
            send: async () => ({ sent: true }),
            readAlmUsage,
            refreshRoom: async () => undefined,
            close: async () => ({ closed: true }),
            health
        }
    });
}

/** A connected page whose counters answer the next reading, holding the last. */
function createCongestionPageRuntime(
    readings: readonly (ALCongestionCounters | RallarBlackBoxTestRecord | undefined)[]
): RallarBlackBoxBrowserTestRuntime {
    let index = 0;
    return createDefaultRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async () => ({ connected: true }),
            send: async () => ({ sent: true }),
            readAlmUsage: async () => FIRST_REPORT,
            readCongestionCounters: async () => readings[Math.min(index++, readings.length - 1)],
            refreshRoom: async () => undefined,
            close: async () => ({ closed: true }),
            health: async () => ({ connected: true })
        }
    });
}

async function readStats(runtime: RallarBlackBoxBrowserTestRuntime, commandId: string): Promise<RallarBlackBoxTestResult> {
    const result = await runtime.execute({ kind: 'stats', commandId });
    expect(result.ok).toBe(true);
    return result;
}

describe('the stats result rallar.alm block', () => {
    it.each(
        [
            { settlement: 'resolve', reassigned: true },
            { settlement: 'reject', reassigned: true },
            { settlement: 'resolve', reassigned: false },
            { settlement: 'reject', reassigned: false }
        ] as const
    )('settling held page Health $settlement retains caller observation; reassigned=$reassigned', async ({ settlement, reassigned }) => {
        const entered = Promise.withResolvers<void>();
        const held = Promise.withResolvers<{ readonly page: string; }>();
        const ledgerReads: string[] = [];
        const runtime = createPageRuntime(async () => {
            ledgerReads.push('page-ledger-read');
            return reassigned ? SECOND_REPORT : FIRST_REPORT;
        }, async () => {
            entered.resolve();
            return await held.promise;
        });
        const original = { runId: 'health-A', agentId: 'agent-A' };
        const current = reassigned ? { runId: 'health-B', agentId: 'agent-B' } : original;
        expect((await runtime.execute({ kind: 'configure', commandId: 'A-config', config: original }, original)).ok).toBe(true);
        const originalFailure = new Error('original page Health failed');
        const pending = runtime.execute({ kind: 'health', commandId: 'A-health' }, original);
        await entered.promise;
        try {
            if (reassigned) {
                expect((await runtime.execute({ kind: 'configure', commandId: 'B-config', config: { ...current, defaults: { connection: 'B' } } }, current)).ok)
                    .toBe(true);
                expect(
                    (await runtime.execute({
                        kind: 'recipe.load',
                        commandId: 'B-load',
                        recipe: { schemaVersion: 1, recipeId: 'B-body', commands: [{ kind: 'health', commandId: 'B-child' }] }
                    }, current)).ok
                ).toBe(true);
                expect((await runtime.execute({ kind: 'stats', commandId: 'B-stats' }, current)).ok).toBe(true);
                runtime.recordEvent({ kind: 'event', topic: 'B-health-independent-observation' });
            }
            const before = runtime.state();
            const beforeLedgerReads = [...ledgerReads];
            if (settlement === 'resolve') {
                held.resolve({ page: 'A' });
            }
            else {
                held.reject(originalFailure);
            }
            const result = await pending;
            expect(result.ok).toBe(settlement === 'resolve');
            if (settlement === 'resolve') {
                expect(result.value).toMatchObject({ rallar: { page: 'A' }, stats: { ...original, lastCommandId: 'A-config', counters: { commands: 1 } } });
                const stats = decodeRecord(decodeRecord(result.value).stats);
                if (reassigned) {
                    expect(stats.rallar).not.toHaveProperty('alm');
                }
                else {
                    expect(stats.rallar).toMatchObject({ alm: FIRST_REPORT });
                    expect(runtime.state().latestStats?.rallar?.alm).toEqual(FIRST_REPORT);
                    expect(runtime.state().events.find((event) => event.topic === 'rallar.bb.stats')?.control).toEqual({
                        ...original,
                        rootCommandId: 'A-health'
                    });
                }
            }
            else {
                expect(result.error?.message).toBe(originalFailure.message);
            }
            if (reassigned) {
                expect(runtime.state()).toEqual(before);
                expect(ledgerReads).toEqual(beforeLedgerReads);
                const replay = await runtime.execute({ kind: 'stats', commandId: 'B-stats' }, current);
                expect(replay.replayed).toBe(true);
                expect(replay.value).toEqual(before.resultCache['B-stats'].value);
            }
            else {
                expect(runtime.state().resultCache['A-health']).toEqual(result);
                expect(ledgerReads).toEqual(settlement === 'resolve' ? ['page-ledger-read'] : []);
            }
        }
        finally {
            held.resolve({ page: 'A' });
            await pending;
        }
    });

    it.each(
        ([
            { kind: 'stats', settlement: 'resolve', reassigned: true },
            { kind: 'stats', settlement: 'reject', reassigned: true },
            { kind: 'health', settlement: 'resolve', reassigned: true },
            { kind: 'health', settlement: 'reject', reassigned: true },
            { kind: 'stats', settlement: 'resolve', reassigned: false },
            { kind: 'stats', settlement: 'reject', reassigned: false },
            { kind: 'health', settlement: 'resolve', reassigned: false },
            { kind: 'health', settlement: 'reject', reassigned: false }
        ] as const).flatMap((cell) => (['ledger', 'congestion'] as const).map((source) => ({ ...cell, source })))
    )('settling held $kind $source $settlement retains assignment ownership; reassigned=$reassigned', async ({ kind, settlement, reassigned, source }) => {
        const entered = Promise.withResolvers<void>();
        const held = Promise.withResolvers<ALVolatileSessionReport | ALCongestionCounters>();
        const firstCongestion = { dropped: 0, deferred: 3, handedOver: 0 };
        const secondCongestion = { dropped: 1, deferred: 3, handedOver: 1 };
        let reading = 0;
        const readHeldPageValue = async () => {
            if (reading++ === 0) {
                entered.resolve();
                return await held.promise;
            }
            return source === 'ledger' ? SECOND_REPORT : secondCongestion;
        };
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                readAlmUsage: source === 'ledger' ? readHeldPageValue : async () => reading === 0 ? FIRST_REPORT : SECOND_REPORT,
                readCongestionCounters: source === 'congestion' ? readHeldPageValue : async () => firstCongestion,
                health: async () => ({ connected: true })
            }
        });
        const original = { runId: 'ledger-A', agentId: 'agent-A' };
        const current = reassigned ? { runId: 'ledger-B', agentId: 'agent-B' } : original;
        const originalFailure = new Error(`original page ${source} read failed`);
        expect((await runtime.execute({ kind: 'configure', commandId: 'A-config', config: original }, original)).ok)
            .toBe(true);
        const pending = runtime.execute({ kind, commandId: 'A-read' }, original);
        await entered.promise;
        try {
            if (reassigned) {
                expect((await runtime.execute({ kind: 'configure', commandId: 'B-config', config: { ...current, defaults: { connection: 'B' } } }, current)).ok)
                    .toBe(true);
                expect(
                    (await runtime.execute({
                        kind: 'recipe.load',
                        commandId: 'B-load',
                        recipe: { schemaVersion: 1, recipeId: 'B-body', commands: [{ kind: 'health', commandId: 'B-child' }] }
                    }, current)).ok
                ).toBe(true);
                expect((await runtime.execute({ kind: 'stats', commandId: 'B-stats' }, current)).ok).toBe(true);
                runtime.recordEvent({ kind: 'event', topic: 'B-independent-observation' });
            }
            const before = runtime.state();
            if (settlement === 'resolve') {
                held.resolve(source === 'ledger' ? FIRST_REPORT : firstCongestion);
            }
            else {
                held.reject(originalFailure);
            }
            const result = await pending;
            expect(result.ok).toBe(settlement === 'resolve');
            if (settlement === 'resolve') {
                const stats = kind === 'health' ? decodeRecord(result.value).stats : result.value;
                expect(stats).toMatchObject({ ...original, rallar: { alm: FIRST_REPORT, congestion: firstCongestion } });
            }
            if (settlement === 'reject') {
                expect(result.error?.message).toBe(originalFailure.message);
            }
            if (reassigned) {
                expect.soft(runtime.state().latestStats).toEqual(before.latestStats);
                expect.soft(runtime.state().events).toEqual(before.events);
                expect.soft(runtime.state().commandHistory).toEqual(before.commandHistory);
                expect.soft(runtime.state().resultCache).toEqual(before.resultCache);
                expect.soft(runtime.state().currentConfig).toEqual(before.currentConfig);
                expect.soft(runtime.state().loadedRecipe).toEqual(before.loadedRecipe);
                expect.soft(runtime.state().status).toBe(before.status);
                const replay = await runtime.execute({ kind: 'stats', commandId: 'B-stats' }, current);
                expect(replay.replayed).toBe(true);
                expect(replay.value).toEqual(before.resultCache['B-stats'].value);
                const fresh = await runtime.execute({ kind: 'stats', commandId: 'B-fresh-stats' }, current);
                expect(fresh.ok).toBe(true);
                expect(fresh.value).toMatchObject({
                    ...current,
                    rallar: { alm: SECOND_REPORT, congestion: source === 'congestion' ? secondCongestion : firstCongestion }
                });
            }
            else if (settlement === 'resolve') {
                expect(runtime.state().latestStats?.rallar?.alm).toEqual(FIRST_REPORT);
                expect(runtime.state().events.find((event) => event.topic === 'rallar.bb.stats')?.control).toEqual({ ...original, rootCommandId: 'A-read' });
                expect(runtime.state().resultCache['A-read']).toEqual(result);
            }
        }
        finally {
            held.resolve(source === 'ledger' ? FIRST_REPORT : firstCongestion);
            await pending;
        }
    });

    it('reads the page session ledger afresh at every stats command, into its result, its event and the latest stats', async () => {
        let reading = 0;
        const runtime = createDefaultPageRuntime(async () => reading++ === 0 ? FIRST_REPORT : SECOND_REPORT);

        const first = await readStats(runtime, 'stats-1');
        const second = await readStats(runtime, 'stats-2');

        expect(first.value).toMatchObject({ rallar: { alm: FIRST_REPORT } });
        expect(second.value).toMatchObject({ rallar: { alm: SECOND_REPORT } });
        expect(runtime.state().latestStats?.rallar?.alm).toEqual(SECOND_REPORT);
        const statsEvents = runtime.state().events.filter((event) => event.topic === 'rallar.bb.stats');
        expect(statsEvents.map((event) => decodeRecord(decodeRecord(event.payload).rallar).alm)).toEqual([
            FIRST_REPORT,
            SECOND_REPORT
        ]);
    });

    it('carries the ledger in the stats of a health result too', async () => {
        const runtime = createDefaultPageRuntime(async () => FIRST_REPORT);

        const result = await runtime.execute({ kind: 'health', commandId: 'health-1' });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ stats: { rallar: { alm: FIRST_REPORT } } });
    });

    it('leaves the block absent while the page has not connected', async () => {
        const stats = await readStats(createDefaultPageRuntime(async () => undefined), 'stats-1');

        expect(stats.value).toHaveProperty('rallar');
        expect(decodeRecord(stats.value).rallar).not.toHaveProperty('alm');
    });

    it('drops the block once the page disconnects mid-run, carrying no earlier reading forward', async () => {
        let reading = 0;
        const runtime = createDefaultPageRuntime(async () => reading++ === 0 ? FIRST_REPORT : undefined);

        const connected = await readStats(runtime, 'stats-1');
        const disconnected = await readStats(runtime, 'stats-2');

        expect(connected.value).toMatchObject({ rallar: { alm: FIRST_REPORT } });
        expect(decodeRecord(disconnected.value).rallar).not.toHaveProperty('alm');
        expect(runtime.state().latestStats?.rallar).not.toHaveProperty('alm');
    });

    it('leaves the block absent on a runtime that drives no Rallar page', async () => {
        const browserStats = await readStats(createDefaultRallarBlackBoxBrowserTestRuntime(), 'stats-1');
        const result = await createDeterministicRuntime().execute({ kind: 'stats', commandId: 'stats-2' });

        expect(decodeRecord(browserStats.value).rallar).not.toHaveProperty('alm');
        expect(decodeRecord(result.value).rallar).not.toHaveProperty('alm');
    });

    it('fails the stats command when the page answers with something that is not a ledger report, naming each bad field', async () => {
        const runtime = createDefaultPageRuntime(async () => ({
            usage: { admissions: -1, bytes: 0, oldestAgeMs: 0 },
            limits: AL_VOLATILE_SESSION_LIMITS,
            overloaded: 'no'
        }));

        const result = await runtime.execute({ kind: 'stats', commandId: 'stats-1' });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toBe(
            'The page\'s session ledger report is not valid: usage.admissions is not a count; ' +
                'usage.tracks is not a count; overloaded is not a boolean'
        );
    });
});

describe('the stats result rallar.congestion block', () => {
    const DEFERRED: ALCongestionCounters = { dropped: 0, deferred: 3, handedOver: 0 };
    const HANDED_OVER: ALCongestionCounters = { dropped: 1, deferred: 3, handedOver: 1 };

    it('reads the page congestion counters afresh at every stats command, beside the ledger', async () => {
        const runtime = createCongestionPageRuntime([DEFERRED, HANDED_OVER]);

        const first = await readStats(runtime, 'stats-1');
        const second = await readStats(runtime, 'stats-2');

        expect(decodeRecord(first.value).rallar).toMatchObject({ alm: FIRST_REPORT, congestion: DEFERRED });
        expect(decodeRecord(decodeRecord(second.value).rallar).congestion).toEqual(HANDED_OVER);
        expect(runtime.state().latestStats?.rallar?.congestion).toEqual(HANDED_OVER);
        const statsEvents = runtime.state().events.filter((event) => event.topic === 'rallar.bb.stats');
        expect(statsEvents.map((event) => decodeRecord(decodeRecord(event.payload).rallar).congestion)).toEqual([
            DEFERRED,
            HANDED_OVER
        ]);
    });

    it('leaves the block absent while the page has not connected, and on a runtime that drives no Rallar page', async () => {
        const unconnected = await readStats(createCongestionPageRuntime([undefined]), 'stats-1');
        const pageless = await readStats(createDefaultRallarBlackBoxBrowserTestRuntime(), 'stats-2');

        expect(decodeRecord(unconnected.value).rallar).not.toHaveProperty('congestion');
        expect(decodeRecord(pageless.value).rallar).not.toHaveProperty('congestion');
    });

    it('fails the stats command when the page answers counters that are not counts, naming each bad field', async () => {
        const runtime = createCongestionPageRuntime([{ dropped: -1, deferred: 2.5, handedOver: 0 }]);

        const result = await runtime.execute({ kind: 'stats', commandId: 'stats-1' });

        expect(result.ok).toBe(false);
        expect(result.error?.message).toBe(
            'The page\'s congestion counters are not valid: dropped is not a count; deferred is not a count'
        );
    });
});

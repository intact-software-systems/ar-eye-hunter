import { describe, expect, it } from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { AL_PUBLICATION_STAGE_LIMITS } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import { AL_VOLATILE_SESSION_LIMITS, ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

interface CapacitySetupFixture {
    readonly runtime: RallarBlackBoxTestRuntime;
    readonly budget: ALVolatileSessionBudget;
    now(): number;
}

function createCapacitySetup(continuous: boolean): CapacitySetupFixture {
    let now = 0;
    const budget = new ALVolatileSessionBudget({ ...AL_VOLATILE_SESSION_LIMITS, maxBytes: 36_000 });
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: () => now,
        sleep: async (ms) => {
            const previous = now;
            now += ms;
            for (const arrival of [3_000, 4_000]) {
                if (previous < arrival && now >= arrival) {
                    budget.record({ msgId: `state-${arrival}`, bytes: 5_100, nowMs: arrival, deadlineAtMs: arrival + 60_000, trackKey: undefined });
                }
            }
        },
        readAlmUsage: async () => {
            if (continuous) {
                budget.record({ msgId: `state-${now}`, bytes: 20_000, nowMs: now, deadlineAtMs: now + 60_000, trackKey: undefined });
            }
            return {
                ...budget.readReport(now),
                orderingTracks: 0,
                deliveredMarkers: 0,
                repliesHeld: 0,
                replyWaitsOpen: 0,
                publication: {
                    lanes: 0,
                    streams: 0,
                    staged: 0,
                    stagedBytes: 0,
                    limits: AL_PUBLICATION_STAGE_LIMITS,
                    counters: { staged: 0, superseded: 0, expired: 0, refused: 0, cancelled: 0, admitted: 0, deferred: 0 }
                }
            };
        }
    });
    return { runtime, budget, now: () => now };
}

describe('capacity fixture available headroom', () => {
    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)(
        'waits for late platform admissions before measuring two admitted %s sends and a refused third',
        async (carrier) => {
            const fixture = createCapacitySetup(false);
            const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
                .find((candidate) => candidate.scenarioId === 'capacity')!;
            const reconnect = scenario.sender.commands.findIndex((command) =>
                command.kind === 'rtc.connect' && command.rallar?.almVolatileLimits !== undefined
            );
            const firstSend = scenario.sender.commands.findIndex((command) => command.kind === 'messages.send');
            for (const command of scenario.sender.commands.slice(reconnect + 1, firstSend)) {
                expect((await fixture.runtime.execute(command)).ok).toBe(true);
            }
            expect(fixture.now()).toBeGreaterThanOrEqual(33_000);
            const admissions = [1, 2, 3].map((index) =>
                fixture.budget.tryAdmit({
                    msgId: `send-${index}`,
                    bytes: 13_410,
                    nowMs: fixture.now(),
                    deadlineAtMs: fixture.now() + 30_000,
                    trackKey: undefined
                })
            );
            expect(admissions.map((admission) => admission.right !== undefined)).toEqual([true, true, false]);
            expect(admissions[2].left?.limit).toBe('bytes');
        }
    );

    it('fails setup within its bound when platform traffic never leaves enough headroom', async () => {
        const fixture = createCapacitySetup(true);
        const scenario = createAlmConformanceRecipes(toConformanceInput('ws'))
            .find((candidate) => candidate.scenarioId === 'capacity')!;
        const reconnect = scenario.sender.commands.findIndex((command) => command.kind === 'rtc.connect' && command.rallar?.almVolatileLimits !== undefined);
        const firstSend = scenario.sender.commands.findIndex((command) => command.kind === 'messages.send');
        const results = [];
        for (const command of scenario.sender.commands.slice(reconnect + 1, firstSend)) {
            results.push(await fixture.runtime.execute(command));
        }
        expect(results.some((result) => !result.ok)).toBe(true);
        expect(fixture.now()).toBeLessThanOrEqual(62_000);
    });
});

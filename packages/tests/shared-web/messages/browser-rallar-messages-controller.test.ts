import { beforeEach, describe, expect, it } from 'vitest';

import {
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime
} from './rallar-facade-test-runtime.ts';

const LIMITS: ALVolatileSessionLimits = { maxAdmissions: 2, maxBytes: 1_024, maxAgeMs: 300_000, maxTracks: 4 };
const NOT_CONNECTED = 'Rallar is not connected. Call rallar.connect() first.';

const mocks = getRallarFacadeMocks();

installFakeBroadcastChannelPerTest();

// The facade reads the ledger at the wall clock, so each admission is placed relative to it.
describe('rallar.messages.readUsage', () => {
    let budget: ALVolatileSessionBudget;

    beforeEach(() => {
        resetRallarFacadeTestRuntime();
        budget = new ALVolatileSessionBudget(LIMITS);
        mocks.apiMiddleware = createDefaultApiMiddlewareTestDouble({ middleware: { volatileBudget: budget } });
    });

    it('throws the not-connected error before the session connects, and again after it disconnects', async () => {
        const facade = createRallarTestFacade();

        expect(() => facade.messages.readUsage()).toThrow(NOT_CONNECTED);

        await facade.connect();
        await facade.disconnect();

        expect(() => facade.messages.readUsage()).toThrow(NOT_CONNECTED);
    });

    it('reads the connected session ledger: what it holds, its four bounds, and not overloaded below them', async () => {
        const facade = createRallarTestFacade();
        await facade.connect();
        const nowMs = Date.now();
        budget.tryAdmit({ msgId: 'ordered-1', bytes: 100, deadlineAtMs: nowMs + 30_000, nowMs: nowMs - 1_000, trackKey: 'track-a' });

        const report = facade.messages.readUsage();

        expect(report).toEqual({
            usage: { admissions: 1, bytes: 100, oldestAgeMs: expect.any(Number), tracks: 1 },
            own: { admissions: 1, bytes: 100 },
            inbound: { admissions: 0, bytes: 0 },
            limits: LIMITS,
            overloaded: false
        });
        expect(report.usage.oldestAgeMs).toBeGreaterThanOrEqual(1_000);
        expect(report.usage.oldestAgeMs).toBeLessThan(31_000);
    });

    it('reads overloaded once the session holds its admission bound', async () => {
        const facade = createRallarTestFacade();
        await facade.connect();
        const nowMs = Date.now();
        budget.tryAdmit({ msgId: 'unordered-1', bytes: 10, deadlineAtMs: nowMs + 30_000, nowMs, trackKey: undefined });
        budget.tryAdmit({ msgId: 'unordered-2', bytes: 10, deadlineAtMs: nowMs + 30_000, nowMs, trackKey: undefined });

        expect(facade.messages.readUsage()).toMatchObject({ usage: { admissions: 2, bytes: 20, tracks: 0 }, overloaded: true });
    });

    it('reads the session\'s own sends and its arrivals as two pools, not overloaded while arrivals alone hold the bound (D189)', async () => {
        const facade = createRallarTestFacade();
        await facade.connect();
        const nowMs = Date.now();
        budget.record({ msgId: 'received-1', bytes: 40, deadlineAtMs: nowMs + 30_000, nowMs, trackKey: undefined });
        budget.record({ msgId: 'received-2', bytes: 60, deadlineAtMs: nowMs + 30_000, nowMs, trackKey: undefined });

        expect(facade.messages.readUsage()).toMatchObject({
            usage: { admissions: 2, bytes: 100 },
            own: { admissions: 0, bytes: 0 },
            inbound: { admissions: 2, bytes: 100 },
            overloaded: false
        });
        budget.tryAdmit({ msgId: 'sent-1', bytes: 10, deadlineAtMs: nowMs + 30_000, nowMs, trackKey: undefined });
        expect(facade.messages.readUsage()).toMatchObject({
            usage: { admissions: 3, bytes: 110 },
            own: { admissions: 1, bytes: 10 },
            overloaded: true
        });
    });

    it('reads an admission whose deadline has passed as released', async () => {
        const facade = createRallarTestFacade();
        await facade.connect();
        const nowMs = Date.now();
        budget.tryAdmit({ msgId: 'ordered-2', bytes: 10, deadlineAtMs: nowMs - 5_000, nowMs: nowMs - 10_000, trackKey: 'track-b' });

        expect(facade.messages.readUsage()).toEqual({
            usage: { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 },
            own: { admissions: 0, bytes: 0 },
            inbound: { admissions: 0, bytes: 0 },
            limits: LIMITS,
            overloaded: false
        });
    });
});

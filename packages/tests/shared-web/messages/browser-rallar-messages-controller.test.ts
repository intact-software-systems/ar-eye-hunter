import { beforeEach, describe, expect, it } from 'vitest';

import type { ALPublicationStageLimits } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import {
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime
} from './rallar-facade-test-runtime.ts';

const LIMITS: ALVolatileSessionLimits = { maxAdmissions: 2, maxBytes: 1_024, maxAgeMs: 300_000, maxTracks: 4 };
const STAGE_LIMITS: ALPublicationStageLimits = { maxStreams: 4, maxStagedValues: 8, maxStagedBytes: 65_536 };
const NO_PUBLICATION_COUNTERS = { staged: 0, superseded: 0, expired: 0, refused: 0, cancelled: 0, admitted: 0, deferred: 0 };
const NOT_CONNECTED = 'Rallar is not connected. Call rallar.connect() first.';

const mocks = getRallarFacadeMocks();

installFakeBroadcastChannelPerTest();

// The facade reads the ledger at the wall clock, so each admission is placed relative to it.
describe('rallar.messages.readUsage', () => {
    let budget: ALVolatileSessionBudget;

    beforeEach(() => {
        resetRallarFacadeTestRuntime();
        budget = new ALVolatileSessionBudget(LIMITS);
        mocks.apiMiddleware = createDefaultApiMiddlewareTestDouble({
            middleware: {
                volatileBudget: budget,
                publicationStageLimits: STAGE_LIMITS,
                // Never started: a staged value waits for an engine pass no test runs.
                qboxEngine: new InboxOutboxEngine({ nowEpochMs: Date.now, random: () => 0.5, reportTaskFailure: () => undefined })
            }
        });
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
            overloaded: false,
            repliesHeld: 0,
            replyWaitsOpen: 0,
            publication: expect.any(Object)
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
            overloaded: false,
            repliesHeld: 0,
            replyWaitsOpen: 0,
            publication: expect.any(Object)
        });
    });

    it('reads the replies this page holds and its reply waits in flight beside the ledger', async () => {
        const facade = createRallarTestFacade();
        await facade.connect();
        const handle = await facade.messages.ws.send({ scope: 'world', topicId: 'app.ask', typeId: 'app.ask.v1', payload: {} });
        const stop = new AbortController();
        const pending = handle.awaitReply({ timeoutMs: 60_000, signal: stop.signal });

        expect(facade.messages.readUsage()).toMatchObject({ repliesHeld: 0, replyWaitsOpen: 1 });

        stop.abort();
        expect((await pending).status).toBe('aborted');
        expect(facade.messages.readUsage()).toMatchObject({ repliesHeld: 0, replyWaitsOpen: 0 });
    });

    it('reads the publication stage beside the ledger: nothing with the connect\'s limits before a live send, then what it staged', async () => {
        const facade = createRallarTestFacade();
        await facade.connect();

        expect(facade.messages.readUsage().publication).toEqual({
            lanes: 0,
            streams: 0,
            staged: 0,
            stagedBytes: 0,
            limits: STAGE_LIMITS,
            counters: NO_PUBLICATION_COUNTERS
        });

        const channel = facade.messages.channel<{ readonly x: number; }>({
            topicId: 'app.pose',
            typeId: 'app.pose.v1',
            purpose: 'live',
            publication: { cadenceMs: 60_000, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } }
        });
        await channel.sendWs({ x: 1 }, { scope: 'world', resourceId: 'entity-1', ttlMs: 60_000 });

        const staged = facade.messages.readUsage().publication;
        expect(staged).toMatchObject({
            lanes: 1,
            streams: 1,
            staged: 1,
            limits: STAGE_LIMITS,
            counters: { ...NO_PUBLICATION_COUNTERS, staged: 1 }
        });
        expect(staged.stagedBytes).toBeGreaterThan(0);
    });
});

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import {
    createVolatileALInboundRuntimeStores,
    createVolatileALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS } from '@shared/alm/ALStoreRetention.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { toALOutboundVersionKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    AL_VOLATILE_SESSION_MAX_AGE_MS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    readInboundTestDecisionSurface,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    drainEngine,
    runOutboundWorkTask
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

const SESSION_START_MS = Date.UTC(2026, 9, 8, 12);
const SIMULATED_STEPS = 100;
/** A hundred steps of 36 s: one simulated hour. */
const STEP_MS = 36_000;
const SENDS_PER_STEP = 5;
const ORDERED_TRACKS = 200;
/** Past the age budget and every volatile message row's own expiry, its deadline plus the receipt grace. */
const AFTER_LAST_STEP_MS = AL_VOLATILE_SESSION_MAX_AGE_MS + AL_RECEIPT_DEADLINE_GRACE_MS + 1;
const EMPTY_LEDGER_USAGE = { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 };
const DRAIN_ROUND_LIMIT = 50;
/** An inbound track's two rows: its ordering snapshot and its delivered marker. */
const TRACK_ROW_KEY = /:(ordering|delivered):track-\d+:/;

describe('a volatile session over a simulated hour', () => {
    it('returns the outbound memory pair, the ledger and the send controls to their baseline', async () => {
        useFakeDate();
        const endedMsgIds = new Set<string>();
        const repositories = captureRepositoriesAcceptingEndedIds(endedMsgIds);
        const budget = new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS);
        const volatileStores = createVolatileALOutboundRuntimeStores(
            { namespace: 'long-run', decodePrepared: decodeOutboundTestPayload },
            budget
        );
        const backend = captureEvictingBackend(volatileStores.evictExpired);
        const runtime = createDefaultOutboundTestRuntime({
            stores: createDefaultOutboundTestStores(),
            volatileStores,
            carrier: 'rtc',
            planOutgoingMessage: planOrderedVolatileSend,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        for (let step = 0; step < SIMULATED_STEPS; step += 1) {
            vi.setSystemTime(SESSION_START_MS + step * STEP_MS);
            const sends = Array.from({ length: SENDS_PER_STEP }, (_, index) => createOrderedSend(step, index));
            for (const message of sends) {
                expect((await runtime.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
            }
            await runOutboundWorkTask(runtime);
            for (const message of sends) {
                endedMsgIds.add(message.id.msgId);
                await runtime.handOver(message.id.msgId);
            }
            endedMsgIds.add(`never-sent-${step}`);
            runtime.cancel(`never-sent-${step}`);
        }
        // The sends of the step before left at their 30 s deadline; each of the last step's opens a counted track.
        expect(budget.readReport(Date.now()).usage).toMatchObject({
            admissions: SENDS_PER_STEP,
            tracks: SENDS_PER_STEP
        });
        expect(backend.peekKeys().length).toBeGreaterThan(0);

        const lastStepAtMs = Date.now();
        vi.setSystemTime(lastStepAtMs + AFTER_LAST_STEP_MS);
        volatileStores.evictExpired();

        expect(budget.readReport(Date.now()).usage).toEqual(EMPTY_LEDGER_USAGE);
        // One row per commit origin, not per message or track: it fences that origin's commits for the hour.
        expect(backend.peekKeys()).toEqual([
            toALOutboundVersionKey(volatileStores.admissionStore.namespace, 'self')
        ]);
        expect(backend.workQueue.peekKeys()).toEqual([]);
        // Every hand-over and every cancel is still held: the row retention outlasts the age budget.
        expect(repositories.map((repository) => repository.size())).toEqual([
            SIMULATED_STEPS * SENDS_PER_STEP,
            SIMULATED_STEPS
        ]);

        vi.setSystemTime(lastStepAtMs + DEFAULT_AL_REPOSITORY_TTL_MS + 1);
        volatileStores.evictExpired();
        endedMsgIds.add('after-the-hour');
        await runtime.handOver('after-the-hour');
        endedMsgIds.add('after-the-hour-cancelled');
        runtime.cancel('after-the-hour-cancelled');

        expect(backend.peekKeys()).toEqual([]);
        // The ended ids, kept for the row retention: each repository holds only the id the last call added.
        expect(repositories.map((repository) => repository.size())).toEqual([1, 1]);
    });

    it('keeps only its tracks past the age budget and returns to its baseline an hour after the last arrival', async () => {
        useFakeDate();
        const budget = new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS);
        const volatileStores = createVolatileALInboundRuntimeStores({ namespace: 'long-run' }, budget);
        const backend = captureEvictingBackend(volatileStores.evictExpired);
        const fixture = createInboundTestRuntime({
            carrier: 'ws',
            stores: createInboundTestStores({
                namespace: 'long-run-durable',
                storage: 'memory',
                observer: createPassThroughIndexedDbOperationObserver()
            }),
            volatileStores,
            effectWorkerId: 'al-inbound:long-run'
        });
        await fixture.runtime.ready();

        let arrivalCount = 0;
        for (let step = 0; step < SIMULATED_STEPS; step += 1) {
            vi.setSystemTime(SESSION_START_MS + step * STEP_MS);
            const arrivals = createStepArrivals(step);
            for (const message of arrivals) {
                // A sequence that arrives while its predecessor's delivery is still claimed is retained and replayed.
                expect((await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right?.kind)
                    .toMatch(/^(admitted|pending-admission)$/);
            }
            arrivalCount += arrivals.length;
            await drainUntilDelivered(fixture, arrivalCount);
        }
        // Every arrival was delivered: each track's two sequences, the last step's tracks only their first, and the
        // step's unordered message.
        expect(fixture.delivered).toHaveLength(2 * SIMULATED_STEPS + 2 * (SIMULATED_STEPS - 1) + SIMULATED_STEPS);
        expect(budget.readReport(Date.now()).usage.admissions).toBeGreaterThan(0);
        expect(backend.peekKeys().length).toBeGreaterThan(0);

        const lastArrivalAtMs = Date.now();
        vi.setSystemTime(lastArrivalAtMs + AFTER_LAST_STEP_MS);
        volatileStores.evictExpired();

        expect(budget.readReport(Date.now()).usage).toEqual(EMPTY_LEDGER_USAGE);
        expect(backend.workQueue.peekKeys()).toEqual([]);
        // Only the tracks are left, two rows each, and none of them grows with the messages it carried; the
        // tracks whose last arrival is older than the repository hour are already gone.
        expect(backend.peekKeys().filter((key) => !TRACK_ROW_KEY.test(key))).toEqual([]);
        expect(backend.peekKeys()).toHaveLength(2 * computeTrackCountWithinTheHour(Date.now()));

        vi.setSystemTime(lastArrivalAtMs + DEFAULT_AL_REPOSITORY_TTL_MS + 1);
        volatileStores.evictExpired();

        expect(backend.peekKeys()).toEqual([]);
    });
});

describe('the volatile inbound pair\'s ordering track', () => {
    // The receiver's snapshot TTL is the longest pause an ordered sender may take: past it the next sequence is a gap.
    it('remembers an idle track for the repository hour and forgets it after', async () => {
        useFakeDate();
        const volatileStores = createVolatileALInboundRuntimeStores({ namespace: 'track-ttl' }, undefined);
        const fixture = createInboundTestRuntime({
            carrier: 'ws',
            stores: createInboundTestStores({
                namespace: 'track-ttl-durable',
                storage: 'memory',
                observer: createPassThroughIndexedDbOperationObserver()
            }),
            volatileStores,
            effectWorkerId: 'al-inbound:track-ttl'
        });
        await fixture.runtime.ready();
        const first = createInboundTestMessage({ msgId: 'track-ttl-1', seq: 1 });
        expect((await fixture.runtime.admitIncomingMessage(first, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        const next = createInboundTestMessage({ msgId: 'track-ttl-2', seq: 2 });

        expect(await readOrderingStatus(volatileStores.admissionStore, next, SESSION_START_MS + DEFAULT_AL_REPOSITORY_TTL_MS - 1))
            .toBe('in-order');
        expect(await readOrderingStatus(volatileStores.admissionStore, next, SESSION_START_MS + DEFAULT_AL_REPOSITORY_TTL_MS))
            .toBe('gap');
    });
});

function useFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SESSION_START_MS);
    onTestFinished(() => {
        vi.useRealTimers();
    });
}

/** Every repository that accepts an id the test has ended, in the order of its first such acceptance. */
function captureRepositoriesAcceptingEndedIds(
    endedMsgIds: ReadonlySet<string>
): readonly LatestRepository<string, true>[] {
    const repositories: LatestRepository<string, true>[] = [];
    const acceptAt = LatestRepository.prototype.acceptAt;
    vi.spyOn(LatestRepository.prototype, 'acceptAt').mockImplementation(function (
        this: LatestRepository<string, true>,
        input
    ) {
        if (endedMsgIds.has(input.key) && !repositories.includes(this)) {
            repositories.push(this);
        }
        return acceptAt.call(this, input);
    });
    onTestFinished(() => {
        vi.restoreAllMocks();
    });
    return repositories;
}

/**
 * The session's worker keeps running between arrivals; here the test runs the engine, a bounded number of rounds,
 * until it delivered every arrival so far: one round does not reach every delivery its arrivals made due, and a
 * delivery left for the next step would pass its deadline there.
 */
async function drainUntilDelivered(fixture: InboundTestRuntime, arrivalCount: number): Promise<void> {
    for (let round = 0; round < DRAIN_ROUND_LIMIT && fixture.delivered.length < arrivalCount; round += 1) {
        await drainEngine(fixture.queueEngine);
    }
}

/** The memory pair's own backend: the one its `evictExpired` sweeps, read back by its keys. */
function captureEvictingBackend(evictExpired: () => void): InMemoryAdmissionBackend {
    const backends: InMemoryAdmissionBackend[] = [];
    const sweep = vi.spyOn(InMemoryAdmissionBackend.prototype, 'evictExpired').mockImplementation(function (
        this: InMemoryAdmissionBackend
    ) {
        backends.push(this);
    });
    evictExpired();
    sweep.mockRestore();
    const [backend] = backends;
    if (backend === undefined) {
        throw new Error('Expected the memory pair to sweep its own backend');
    }
    return backend;
}

function planOrderedVolatileSend(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
    return { msg, dropReasonCode: undefined, lane: 'volatile', preparedMessages: [{ kind: 'send' }] };
}

/** The step's sends, each the next sequence the application numbers on the next of the session's ordered tracks. */
function createOrderedSend(step: number, index: number): ALMessage {
    const sendIndex = step * SENDS_PER_STEP + index;
    const message = createOutboundMessage(`send-${sendIndex}`);
    const seq = Math.floor(sendIndex / ORDERED_TRACKS) + 1;
    return { ...message, ordering: { orderingKey: `track-${sendIndex % ORDERED_TRACKS}`, seq } };
}

/**
 * Two new ordered tracks per step, the two tracks the step before opened at their second sequence, and one
 * unordered message: two hundred tracks, each idle after its second message.
 */
function createStepArrivals(step: number): readonly ALMessage[] {
    const opened = [2 * step, 2 * step + 1].map((track) => createTrackArrival(track, 1));
    const continued = step === 0 ? [] : [2 * step - 2, 2 * step - 1].map((track) => createTrackArrival(track, 2));
    return [...opened, ...continued, createInboundTestMessage({ msgId: `unordered-${step}` })];
}

/** The tracks whose last arrival lies within the repository hour before `nowMs`. */
function computeTrackCountWithinTheHour(nowMs: number): number {
    return Array.from({ length: ORDERED_TRACKS }, (_, track) => track)
        .filter((track) => computeLastTrackArrivalAtMs(track) + DEFAULT_AL_REPOSITORY_TTL_MS > nowMs)
        .length;
}

/** A track's second sequence arrives the step after it opened; the last step's tracks never get one. */
function computeLastTrackArrivalAtMs(track: number): number {
    const lastStep = Math.min(Math.floor(track / 2) + 1, SIMULATED_STEPS - 1);
    return SESSION_START_MS + lastStep * STEP_MS;
}

function createTrackArrival(track: number, seq: number): ALMessage {
    const message = createInboundTestMessage({ msgId: `track-${track}-${seq}`, seq });
    return { ...message, ordering: { orderingKey: `track-${track}`, seq } };
}

async function readOrderingStatus(
    admissionStore: ALInboundAdmissionStore,
    message: ALMessage,
    nowMs: number
): Promise<string | undefined> {
    const read = await readInboundTestDecisionSurface(admissionStore, message, nowMs);
    return computeALInboundPlanningObservations(read).orderingObservation?.status;
}

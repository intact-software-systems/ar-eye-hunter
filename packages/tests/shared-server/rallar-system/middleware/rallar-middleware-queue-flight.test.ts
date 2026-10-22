import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerApplicationQueueReaderTasks } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type {
    ResourceInboxReservationObservationRequest,
    ResourceInboxReservationObservationResult,
    ResourceInboxReservationRequest
} from '@shared/queuebox/queue-box-types.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createQueueResilience } from '../../../shared/app-inbox/fair-service-fixture.ts';

const TYPE = 'test.queue-flight';
/** The first pass claims twice, its two heads and then an empty claim that ends its lane, so the second pass's is the third. */
const SECOND_PASS_CLAIM_ORDINAL = 3;

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface QueueFlightHarness {
    readonly engine: InboxOutboxEngine;
    readonly queue: ProbeCountingQueueBox;
    readonly reader: InboxQueueReader;
    /** The row ids whose handler started, with the fake time each started at. */
    readonly started: { rowId: string; atMs: number; }[];
    /** Every failure the engine reported, as `task: message`. */
    readonly reportedFailures: string[];
    finish(rowId: string): void;
}

class ProbeCountingQueueBox extends InMemoryQueueBox {
    probes = 0;
    claims = 0;
    /** Runs after a claim statement has selected its rows, before its pass sees them; told the claim's ordinal. */
    afterClaim: ((ordinal: number, claimed: number) => Promise<void>) | undefined;
    /** The row whose next release rejects, as a release that lost its reservation does. */
    failReleaseOf: string | undefined;

    constructor() {
        super(new Map(), () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
    }

    override async readWorkAdvertisement(
        ...input: Parameters<InMemoryQueueBox['readWorkAdvertisement']>
    ): ReturnType<InMemoryQueueBox['readWorkAdvertisement']> {
        this.probes += 1;
        return await super.readWorkAdvertisement(...input);
    }

    override async releaseEntries(
        ...input: Parameters<InMemoryQueueBox['releaseEntries']>
    ): ReturnType<InMemoryQueueBox['releaseEntries']> {
        const [releases] = input;
        if (releases.some((release) => release.entry.key.resourceId === this.failReleaseOf)) {
            this.failReleaseOf = undefined;
            throw new Error('release lost its reservation');
        }
        return await super.releaseEntries(...input);
    }

    override reserveEntries(request: ResourceInboxReservationObservationRequest): Promise<ResourceInboxReservationObservationResult>;
    override reserveEntries(request: ResourceInboxReservationRequest): Promise<Map<Key, ResourceEntry>>;
    override async reserveEntries(
        request: ResourceInboxReservationRequest | ResourceInboxReservationObservationRequest
    ): Promise<Map<Key, ResourceEntry> | ResourceInboxReservationObservationResult> {
        if ('reservationObservation' in request) {
            const observed = await super.reserveEntries(request);
            await this.recordClaim(observed.entries.size);
            return observed;
        }
        const claimed = await super.reserveEntries(request);
        await this.recordClaim(claimed.size);
        return claimed;
    }

    private async recordClaim(claimedCount: number): Promise<void> {
        this.claims += 1;
        await this.afterClaim?.(this.claims, claimedCount);
    }
}

describe('registered AppInbox queue task with a standing flight', () => {
    it('probes nothing while the flight holds its bound and tops it up as soon as a row settles', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const harness = createQueueFlightHarness({ newLaneConcurrency: 1, newLaneHeldRows: 2 });
        await enqueue(harness.reader, 4);

        harness.engine.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.started.map(({ rowId }) => rowId)).toEqual(['row-0']);
        const probesWhileFull = harness.queue.probes;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.queue.probes).toBe(probesWhileFull);

        const settledAtMs = Date.now();
        harness.finish('row-0');
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.started.map(({ rowId }) => rowId)).toEqual(['row-0', 'row-1']);
        // The settled row woke the engine at once, and that pass claimed the freed place: row-2 waits in flight.
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.reader.isAwaitingFlightSettlement()).toBe(true);
        expect(harness.started.at(-1)!.atMs).toBe(settledAtMs);

        for (const rowId of ['row-1', 'row-2', 'row-3']) {
            harness.finish(rowId);
            await vi.advanceTimersByTimeAsync(0);
        }
        await stopEngine(harness.engine);
        expect(harness.started.map(({ rowId }) => rowId)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
    });

    it('claims a row another writer announced while the flight waits on its in-flight contexts, before any row settles', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const harness = createQueueFlightHarness({ newLaneConcurrency: 2, newLaneHeldRows: 4, keyedPrefix: 'keyed-' });
        await enqueueRow(harness.reader, 'context-a', 'keyed-1');
        await enqueueRow(harness.reader, 'context-b', 'keyed-2');
        await enqueueRow(harness.reader, 'context-a', 'row-a2');

        harness.engine.start();
        await vi.advanceTimersByTimeAsync(1_000);
        // The chain's head computes and its successor waits; context-a's next row is not claimable while its head runs.
        expect(harness.started.map(({ rowId }) => rowId)).toEqual(['keyed-1']);
        expect(harness.reader.isAwaitingFlightSettlement()).toBe(true);

        await enqueueRow(harness.reader, 'context-c', 'row-c');
        harness.engine.wakeAfterExternalWrite(new Set(['APP_INBOX']));
        await vi.advanceTimersByTimeAsync(0);

        expect(harness.started.map(({ rowId }) => rowId)).toEqual(['keyed-1', 'row-c']);
        for (const rowId of ['keyed-1', 'keyed-2', 'row-c', 'row-a2']) {
            await vi.waitFor(() => expect(harness.started.map((started) => started.rowId)).toContain(rowId));
            harness.finish(rowId);
            await vi.advanceTimersByTimeAsync(0);
        }
        await stopEngine(harness.engine);
    });

    it('probes again after a pass that claimed nothing while another writer announced a row during its claim', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const harness = createQueueFlightHarness({ newLaneConcurrency: 2, newLaneHeldRows: 4, keyedPrefix: 'keyed-' });
        await enqueueRow(harness.reader, 'context-a', 'keyed-1');
        await enqueueRow(harness.reader, 'context-b', 'keyed-2');
        await enqueueRow(harness.reader, 'context-a', 'row-a2');
        const announced: number[] = [];
        harness.queue.afterClaim = async (ordinal, claimed) => {
            // The second pass's claim finds only context-a's next row, which its head in flight excludes.
            if (ordinal === SECOND_PASS_CLAIM_ORDINAL && claimed === 0) {
                await enqueueRow(harness.reader, 'context-c', 'row-c');
                harness.engine.wakeAfterExternalWrite(new Set(['APP_INBOX']));
                announced.push(ordinal);
            }
        };

        harness.engine.start();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(announced).toEqual([SECOND_PASS_CLAIM_ORDINAL]);
        expect(harness.started.map(({ rowId }) => rowId)).toEqual(['keyed-1', 'row-c']);
        for (const rowId of ['keyed-1', 'keyed-2', 'row-c', 'row-a2']) {
            await vi.waitFor(() => expect(harness.started.map((started) => started.rowId)).toContain(rowId));
            harness.finish(rowId);
            await vi.advanceTimersByTimeAsync(0);
        }
        await stopEngine(harness.engine);
    });

    it('probes again when a wait on its in-flight contexts runs out, though no row settled and no writer announced one', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const harness = createQueueFlightHarness({ newLaneConcurrency: 2, newLaneHeldRows: 4, keyedPrefix: 'keyed-' });
        await enqueueRow(harness.reader, 'context-a', 'keyed-1');
        await enqueueRow(harness.reader, 'context-b', 'keyed-2');
        await enqueueRow(harness.reader, 'context-a', 'row-a2');

        harness.engine.start();
        await vi.advanceTimersByTimeAsync(1_000);
        const waitEndMs = harness.reader.getFlightSettlementWaitEndMs();
        expect(waitEndMs).toBeDefined();
        const probesWhileWaiting = harness.queue.probes;

        await vi.advanceTimersByTimeAsync(waitEndMs! - 1 - Date.now());
        expect(harness.queue.probes).toBe(probesWhileWaiting);
        await vi.advanceTimersByTimeAsync(1);
        // A retry coming due or a peer's lease running out settles nothing here, so the wait ends at the idle ceiling.
        expect(harness.queue.probes).toBeGreaterThan(probesWhileWaiting);

        for (const rowId of ['keyed-1', 'keyed-2', 'row-a2']) {
            await vi.waitFor(() => expect(harness.started.map((started) => started.rowId)).toContain(rowId));
            harness.finish(rowId);
            await vi.advanceTimersByTimeAsync(0);
        }
        await stopEngine(harness.engine);
    });

    it('reports a row\'s release error once, through the pass that rethrows it', async () => {
        vi.useFakeTimers({ now: 10_000 });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const harness = createQueueFlightHarness({ newLaneConcurrency: 1, newLaneHeldRows: 2 });
        await enqueue(harness.reader, 3);
        harness.queue.failReleaseOf = 'row-0';

        harness.engine.start();
        await vi.advanceTimersByTimeAsync(0);
        harness.finish('row-0');
        // The failed release frees a place, so the pass that rethrows the error is followed by one that claims row-2.
        for (const rowId of ['row-1', 'row-2']) {
            await vi.waitFor(async () => {
                await vi.advanceTimersByTimeAsync(100);
                expect(harness.started.map((started) => started.rowId)).toContain(rowId);
            });
            harness.finish(rowId);
        }
        await stopEngine(harness.engine);

        expect(harness.reportedFailures).toEqual([`${InboxQueueReader.INBOX_ENQUEUE_TYPE}: release lost its reservation`]);
    });

    it('rejects stop with a release error no pass is left to rethrow, and reports it once', async () => {
        vi.useFakeTimers({ now: 10_000 });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const harness = createQueueFlightHarness({ newLaneConcurrency: 1, newLaneHeldRows: 2 });
        await enqueue(harness.reader, 1);
        harness.queue.failReleaseOf = 'row-0';
        harness.engine.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.started.map(({ rowId }) => rowId)).toEqual(['row-0']);

        // The engine stops before the row settles, so no later pass rethrows its release error.
        const stopping = harness.engine.stop();
        const rejection = expect(stopping).rejects.toMatchObject({ errors: [{ message: 'release lost its reservation' }] });
        harness.finish('row-0');
        await vi.advanceTimersByTimeAsync(0);
        await rejection;

        await expect(stopping).rejects.toBeInstanceOf(AggregateError);
        expect(harness.reportedFailures).toEqual([`${InboxQueueReader.INBOX_ENQUEUE_TYPE}: release lost its reservation`]);
    });

    it('stops only after the rows its passes left in flight have settled', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const harness = createQueueFlightHarness({ newLaneConcurrency: 2, newLaneHeldRows: 2 });
        await enqueue(harness.reader, 2);
        harness.engine.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.started).toHaveLength(2);

        let stopped = false;
        const stopping = harness.engine.stop().then(() => {
            stopped = true;
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(stopped).toBe(false);
        harness.finish('row-0');
        harness.finish('row-1');
        await vi.advanceTimersByTimeAsync(0);
        await stopping;

        expect(stopped).toBe(true);
    });

    it('backs its probes off when the flight is empty and nothing is claimable', async () => {
        vi.useFakeTimers({ now: 10_000 });
        const harness = createQueueFlightHarness({ newLaneConcurrency: 2, newLaneHeldRows: 4 });

        harness.engine.start();
        await vi.advanceTimersByTimeAsync(10_000);

        // Idle passes double their delay from 100 ms to the 3 s ceiling, so ten seconds hold a handful of probes.
        expect(harness.queue.probes).toBeGreaterThan(0);
        expect(harness.queue.probes).toBeLessThanOrEqual(8);
        await stopEngine(harness.engine);
    });
});

function createQueueFlightHarness(
    input: Readonly<{ newLaneConcurrency: number; newLaneHeldRows: number; keyedPrefix?: string; }>
): QueueFlightHarness {
    const queue = new ProbeCountingQueueBox();
    const reportedFailures: string[] = [];
    const engine = new InboxOutboxEngine({
        nowEpochMs: () => Date.now(),
        random: () => 0.5,
        reportTaskFailure: (taskId, error) => {
            reportedFailures.push(`${taskId}: ${error.message}`);
        }
    });
    const reader = new InboxQueueReader(queue, {
        newLaneConcurrency: input.newLaneConcurrency,
        newLaneHeldRows: input.newLaneHeldRows,
        flightEntryListener: (settlement) => engine.retainSettlingWork(InboxQueueReader.INBOX_ENQUEUE_TYPE, settlement),
        nowEpochMs: () => Date.now(),
        toComputeExclusionKey: (key) => input.keyedPrefix !== undefined && key.resourceId.startsWith(input.keyedPrefix) ? 'app:group' : undefined
    });
    const started: QueueFlightHarness['started'] = [];
    const gates = new Map<string, () => void>();
    reader.onInboxMessageDo(TYPE, {
        onMessage: async (_message, entry) => {
            started.push({ rowId: entry.key.resourceId, atMs: Date.now() });
            await new Promise<void>((resolve) => gates.set(entry.key.resourceId, resolve));
        }
    });
    registerApplicationQueueReaderTasks({
        engine,
        nowEpochMs: () => Date.now(),
        inboxQueueReader: reader,
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        appInboxResilience: createQueueResilience(),
        appOutboxResilience: createQueueResilience()
    });
    return { engine, queue, reader, started, reportedFailures, finish: (rowId) => gates.get(rowId)!() };
}

async function enqueue(reader: InboxQueueReader, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        await enqueueRow(reader, `context-${index}`, `row-${index}`);
    }
}

async function enqueueRow(reader: InboxQueueReader, contextId: string, rowId: string): Promise<void> {
    await reader.enqueueIfAbsent(newALUntargetedMessage(
        'api-v1',
        newALRoute('app-inbox.queue-flight', contextId, rowId),
        TYPE,
        { rowId },
        { ttlMs: 300_000 }
    ));
}

async function stopEngine(engine: InboxOutboxEngine): Promise<void> {
    const stopped = engine.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopped;
}

import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { ResourceInboxHandlerRetryableConflict } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createPSqlAdmissionTestStorage } from '../../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import { recordResourceInboxStatements } from '../../shared-server/queuebox/resource-inbox-test-storage.ts';

const TYPE = 'app-inbox.context-heads.v1';
const K = 4;

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface HeldHandlers {
    readonly started: ALMessage[];
    readonly inFlightByContext: Map<string, number>;
    maxInFlight: number;
    release(): void;
}

/** Every handler waits until the test releases them all, so a pass's concurrency is observable. */
function holdHandlers(reader: InboxQueueReader): HeldHandlers {
    const released = Promise.withResolvers<void>();
    let inFlight = 0;
    const held: HeldHandlers = {
        started: [],
        inFlightByContext: new Map(),
        maxInFlight: 0,
        release: () => released.resolve()
    };
    reader.onInboxMessageDo(TYPE, {
        onMessage: async (message) => {
            const context = message.route.contextId;
            held.started.push(message);
            inFlight += 1;
            held.maxInFlight = Math.max(held.maxInFlight, inFlight);
            held.inFlightByContext.set(context, (held.inFlightByContext.get(context) ?? 0) + 1);
            expect(held.inFlightByContext.get(context)).toBe(1);
            await released.promise;
            held.inFlightByContext.set(context, (held.inFlightByContext.get(context) ?? 1) - 1);
            inFlight -= 1;
        }
    });
    return held;
}

describe('the AppInbox NEW lane with concurrent context heads', () => {
    it('reserves K distinct-context heads in one statement and runs them together', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const statements: string[] = [];
        const queue = new PSqlQueueBox(
            createPSqlResourceInboxRepository(recordResourceInboxStatements(sql, statements), () => new Date()),
            Temporal.Now.instant
        );
        const reader = createReader(queue);
        const held = holdHandlers(reader);
        await enqueue(reader, contexts(8));
        statements.length = 0;

        const pass = reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await vi.waitFor(() => expect(held.started).toHaveLength(K));
        expect(statements.filter(isReservation)).toHaveLength(1);
        held.release();

        // Before step 2g a pass reserved one head per round: eight reservations, one handler in flight.
        expect(await pass).toBe(8);
        expect(held.maxInFlight).toBe(K);
        expect(statements.filter(isReservation)).toHaveLength(2);
    });

    it('finishes N rows of distinct contexts in ceil(N / K) handler delays', async () => {
        vi.useFakeTimers({ now: 1_000 });
        const queue = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
        const reader = createReader(queue);
        const finishedAtMs: number[] = [];
        reader.onInboxMessageDo(TYPE, {
            onMessage: async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
                finishedAtMs.push(Date.now());
            }
        });
        await enqueue(reader, contexts(8));

        const pass = reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await vi.advanceTimersByTimeAsync(200);

        expect(await pass).toBe(8);
        expect(Math.max(...finishedAtMs) - 1_000).toBe(200);
    });

    it('never runs two rows of one context together: the second waits for the next pass', async () => {
        const queue = new InMemoryQueueBox();
        const reader = createReader(queue);
        const held = holdHandlers(reader);
        await enqueue(reader, ['shared', 'shared', 'other-1', 'other-2']);

        const pass = reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await vi.waitFor(() => expect(held.started).toHaveLength(3));
        held.release();

        expect(await pass).toBe(3);
        expect(await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience())).toBe(1);
        expect(held.started.map((message) => message.route.contextId)).toEqual(['shared', 'other-1', 'other-2', 'shared']);
    });

    it('rejects the release of a row whose lease another owner took while its round ran, and releases the rest at once', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
        const reader = createReader(queue);
        const held = holdHandlers(reader);
        const [stolen] = await enqueue(reader, contexts(K));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const pass = reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await vi.waitFor(() => expect(held.started).toHaveLength(K));
        // The lease timed out and another owner claimed the row again: its attempt columns moved.
        await sql`update resource_inbox set ri_attempts = ri_attempts + 1 where ri_resource_id = ${stolen!.key.resourceId}`;
        held.release();

        // The round's one release transaction conflicts, so each row releases alone: the other owner keeps its
        // claim and the round's other rows complete now, not after their leases.
        await expect(pass).rejects.toThrow(/reservation/i);
        const rows = await Promise.all(contexts(K).map((_context, index) => queue.getItem(toKey(stolen!, index))));
        expect(rows[0]).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 2 } });
        expect(rows.slice(1).map((row) => row?.status)).toEqual(Array(K - 1).fill(EntityStatus.COMPLETED));
    });

    it('starts no new round once a round tripped the breaker', async () => {
        const queue = new InMemoryQueueBox();
        const reader = createReader(queue);
        const handled: string[] = [];
        reader.onInboxMessageDo(TYPE, {
            onMessage: async (message) => {
                handled.push(message.route.contextId);
                throw new Error('storage unavailable');
            }
        });
        await enqueue(reader, contexts(8));
        // One breaker verdict per released round: after one earlier failure, this pass's first failed round opens it.
        const resilience = createResilience(1);
        resilience.failure();
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);

        expect(resilience.isNotAllowedThroughToDequeue()).toBe(true);
        expect(handled).toHaveLength(K);
    });

    it('retries the conflicts of K heads that race one shared row until every row converges', async () => {
        const queue = new InMemoryQueueBox();
        const reader = createReader(queue);
        let sharedVersion = 0;
        let conflicts = 0;
        reader.onInboxMessageDo(TYPE, {
            onMessage: async (_message, entry) => {
                const observed = sharedVersion;
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (sharedVersion !== observed) {
                    conflicts += 1;
                    return new ResourceInboxHandlerRetryableConflict(entry, 'shared-row-changed', new Error('conflict'));
                }
                sharedVersion += 1;
                return undefined;
            }
        });
        const entries = await enqueue(reader, contexts(8));

        for (let pass = 0; pass < 40 && sharedVersion < 8; pass += 1) {
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(sharedVersion).toBe(8);
        expect((await Promise.all(entries.map((entry) => queue.getItem(entry.key)))).map((row) => row?.status))
            .toEqual(Array(8).fill(EntityStatus.COMPLETED));
        // Each of the two NEW rounds of K racing heads commits one and returns K - 1 conflicts to the RETRY lane,
        // which serves them in turn, so no retry conflicts again.
        expect(conflicts).toBe(2 * (K - 1));
    });

    // Before step 2g D301, joins to one group from different callers ran as concurrent heads and all but one
    // conflicted on the group revision (27 of 50 joins on the hosted 50 at K = 4).
    it('computes the heads of one exclusion key one after another while heads of other keys run concurrently', async () => {
        const queue = new InMemoryQueueBox();
        const sharedGroupRows = new Set(Array.from({ length: 8 }, (_value, index) => `row-${2 * index}`));
        const reader = new InboxQueueReader(queue, {
            laneBudgetPolicy: 'fixed-retry-two',
            newLaneConcurrency: K,
            toComputeExclusionKey: (entry) => sharedGroupRows.has(entry.key.resourceId) ? 'group-shared' : `group-${entry.key.resourceId}`
        });
        const revisionByGroup = new Map<string, number>();
        let conflicts = 0;
        let inFlight = 0;
        let maxInFlight = 0;
        reader.onInboxMessageDo(TYPE, {
            onMessage: async (_message, entry) => {
                const group = sharedGroupRows.has(entry.key.resourceId) ? 'group-shared' : entry.key.resourceId;
                const observed = revisionByGroup.get(group) ?? 0;
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight -= 1;
                if ((revisionByGroup.get(group) ?? 0) !== observed) {
                    conflicts += 1;
                    return new ResourceInboxHandlerRetryableConflict(entry, 'group-revision-changed', new Error('conflict'));
                }
                revisionByGroup.set(group, observed + 1);
                return undefined;
            }
        });
        // The shared group's eight joins interleave with eight rows of eight other groups, each from its own context.
        const entries = await enqueue(reader, contexts(16));

        for (let pass = 0; pass < 10 && (revisionByGroup.get('group-shared') ?? 0) < 8; pass += 1) {
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        }

        expect(conflicts).toBe(0);
        expect(revisionByGroup.get('group-shared')).toBe(8);
        expect(maxInFlight).toBeGreaterThan(1);
        expect((await Promise.all(entries.map((entry) => queue.getItem(entry.key)))).map((row) => row?.status))
            .toEqual(Array(16).fill(EntityStatus.COMPLETED));
    });
});

function createReader(queue: QueueBoxResourceEntryRepository): InboxQueueReader {
    return new InboxQueueReader(queue, { laneBudgetPolicy: 'fixed-retry-two', newLaneConcurrency: K });
}

function contexts(count: number): string[] {
    return Array.from({ length: count }, (_value, index) => `context-${index}`);
}

async function enqueue(reader: InboxQueueReader, contextIds: readonly string[]): Promise<ResourceEntry[]> {
    const entries: ResourceEntry[] = [];
    for (const [index, contextId] of contextIds.entries()) {
        entries.push(
            await reader.enqueueIfAbsent(newALUntargetedMessage(
                'api-v1',
                newALRoute('app-inbox.context-heads', contextId, `row-${index}`),
                TYPE,
                { index },
                { ttlMs: 300_000 }
            ))
        );
    }
    return entries;
}

function toKey(first: ResourceEntry, index: number): ResourceEntry['key'] {
    return { ...first.key, resourceId: `row-${index}`, contextId: `context-${index}` };
}

function isReservation(statement: string): boolean {
    return statement.startsWith('update resource_inbox set ri_status') && statement.includes('distinct on');
}

function createResilience(failureThreshold = 10): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(failureThreshold, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        retryPolicy: DEFAULT_RESOURCE_INBOX_RETRY_POLICY
    });
}

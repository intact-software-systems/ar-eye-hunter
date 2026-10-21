import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { GroupStateRepositoryReads } from '@shared-server/rallar-system/group-state/persistence/group-state-repository-reads.ts';
import * as GroupNamespaces from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import {
    GROUP_PRESENCE_SUMMARY_CONFLICT_RETRY_DELAY_MS,
    GroupPresenceSummaryWork
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { APP_OUTBOX_RTC_TOPOLOGY_TOPIC } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { toCoalescedGroupRevisionKey } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupPresenceSummary, GroupRef } from '@shared/api/group-types.ts';
import {
    computeGroupPresenceSummaryEntry,
    decodeCanonicalGroupPresenceSummaryEntry
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { ResourceInboxHandlerRetryableConflict } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createPSqlAdmissionTestStorage } from '../../../al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService } from './group-presence-test-runtime.ts';

/** Enough connects of one group that their merged first delta outgrows one AL payload. */
const LARGE_PAGE_CONNECTS = 120;

describe('group presence summary coalescing', () => {
    it('observes every committed delta with its own command and persisted outbox key', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        let observedAtWake = 0;
        const fixture = await createCoalescingFixture(timingEvents, () => {
            observedAtWake = timingEvents.filter((event) => event.operation === 'committed-output-observed').length;
        });
        const seeded = await fixture.seedConnectedGroup('timed-coalesced-room', 3);
        const pending = await fixture.enqueue(seeded.entries);

        await fixture.process(pending[0]!);

        const committed = await fixture.readCommittedOutbox(seeded.ref);
        const observed = timingEvents.filter((event) => event.operation === 'committed-output-observed');
        const accepted = pending.map((entry) => decodeCanonicalGroupPresenceSummaryEntry(entry).acceptedCausalRevision);
        expect(observed).toHaveLength(3);
        expect(observedAtWake).toBe(3);
        expect(observed.map((event) => event.requestId)).toEqual(
            seeded.principalIds.map((principalId) => `connect-timed-coalesced-room-${principalId}`)
        );
        expect(observed.map((event) => event.details)).toEqual(committed.map((entry, index) =>
            expect.objectContaining({
                topicId: entry.key.topicId,
                resourceId: entry.key.resourceId,
                contextId: entry.key.contextId,
                outcome: 'written',
                acceptedGroupRevision: accepted[index]!.groupRevision,
                acceptedPresenceRevision: accepted[index]!.presenceRevision
            })
        ));
    });

    it('expands ten pending connects of one group with one read and one delta per event in causal order', async () => {
        const fixture = await createCoalescingFixture();
        const reference = await fixture.seedConnectedGroup('reference-room', 10);
        let referenceCalls: readonly string[] = [];
        for (const entry of reference.entries) {
            referenceCalls = await fixture.processAlone(entry);
        }
        const coalesced = await fixture.seedConnectedGroup('coalesced-room', 10);
        const pending = await fixture.enqueue(coalesced.entries);
        const summaryBefore = await fixture.readSummary(coalesced.ref);
        fixture.repositoryCalls.length = 0;

        await fixture.process(pending[0]!);

        expect(fixture.repositoryCalls).toEqual(referenceCalls);
        for (const entry of pending) {
            expect((await fixture.resources.entries.findByKey(entry.key))?.status, entry.key.resourceId).toBe(
                EntityStatus.COMPLETED
            );
        }
        const envelopes = await fixture.readCommittedDeltas(coalesced.ref);
        expect(envelopes.map((envelope) => envelope.event.requestId)).toEqual(
            coalesced.principalIds.map((principalId) => `connect-coalesced-room-${principalId}`)
        );
        const summaryAfter = await fixture.readSummary(coalesced.ref);
        for (const envelope of envelopes) {
            expect(envelope.predecessorCausalRevision).toEqual(summaryBefore.causalRevision);
            expect(envelope.resultingCausalRevision).toEqual(summaryAfter.causalRevision);
            expect(envelope.audienceSessionIds).toHaveLength(10);
        }
        expect(envelopes.map((envelope) => envelope.sessions.map((session) => session.principalId))).toEqual([
            coalesced.principalIds,
            ...coalesced.principalIds.slice(1).map((principalId) => [principalId])
        ]);
        const referenceSummary = await fixture.readSummary(reference.ref);
        expect(summaryAfter).toMatchObject({
            causalRevision: referenceSummary.causalRevision,
            activePrincipalIds: referenceSummary.activePrincipalIds,
            activePrincipalCount: referenceSummary.activePrincipalCount,
            activeSessionCount: referenceSummary.activeSessionCount
        });
        expect(await fixture.readCommittedDeltas(reference.ref)).toHaveLength(10);
    });

    it('leaves another group\'s pending connects untouched', async () => {
        const fixture = await createCoalescingFixture();
        const first = await fixture.seedConnectedGroup('first-room', 3);
        const second = await fixture.seedConnectedGroup('second-room', 2);
        const firstPending = await fixture.enqueue(first.entries);
        const secondPending = await fixture.enqueue(second.entries);

        await fixture.process(firstPending[1]!);

        for (const entry of firstPending) {
            expect((await fixture.resources.entries.findByKey(entry.key))?.status, entry.key.resourceId).toBe(
                EntityStatus.COMPLETED
            );
        }
        for (const entry of secondPending) {
            expect((await fixture.resources.entries.findByKey(entry.key))?.status, entry.key.resourceId).toBe(
                EntityStatus.NEW
            );
        }
        expect(await fixture.readCommittedDeltas(first.ref)).toHaveLength(3);
        expect(await fixture.readCommittedDeltas(second.ref)).toHaveLength(0);
    });

    it('completes a summary whose replan successor at the same causal revision is already queued behind a reserved head', async () => {
        const fixture = await createCoalescingFixture();
        const seeded = await fixture.seedConnectedGroup('queued-successor-room', 3);
        await fixture.processAlone(seeded.entries[0]!);
        await fixture.reserveTopologyHead(seeded.ref);
        await fixture.processAlone(seeded.entries[1]!);
        const queuedSuccessor = (await fixture.readTopologyRows(seeded.ref))[1]!;
        const [third] = await fixture.enqueue([seeded.entries[2]!]);

        await expect(fixture.process(third!)).resolves.toBeUndefined();

        expect((await fixture.resources.entries.findByKey(third!.key))?.status).toBe(EntityStatus.COMPLETED);
        const topology = await fixture.readTopologyRows(seeded.ref);
        expect(topology.map((row) => row.status)).toEqual([EntityStatus.RESERVED, queuedSuccessor.status]);
        expect(topology[1]!.key.resourceId).toBe(queuedSuccessor.key.resourceId);
        expect(topology[1]!.resource).toBe(queuedSuccessor.resource);
    });

    it('still fails a summary as corruption when the row under its successor key is not that replan request', async () => {
        const fixture = await createCoalescingFixture();
        const seeded = await fixture.seedConnectedGroup('foreign-successor-room', 3);
        await fixture.processAlone(seeded.entries[0]!);
        await fixture.reserveTopologyHead(seeded.ref);
        await fixture.processAlone(seeded.entries[1]!);
        const queuedSuccessor = (await fixture.readTopologyRows(seeded.ref))[1]!;
        await fixture.replaceStoredResource(queuedSuccessor.key, '{"foreign":true}');
        const [third] = await fixture.enqueue([seeded.entries[2]!]);

        await expect(fixture.process(third!)).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);

        expect((await fixture.readTopologyRows(seeded.ref))[1]!.resource).toBe('{"foreign":true}');
    });

    it('answers a short typed conflict when another writer queued the replan head after this summary read none', async () => {
        const fixture = await createCoalescingFixture(undefined, undefined, { blind: true });
        const seeded = await fixture.seedConnectedGroup('lost-head-room', 2);
        await fixture.processAlone(seeded.entries[0]!);
        const [second] = await fixture.enqueue([seeded.entries[1]!]);

        const outcome = await fixture.process(second!);

        expect(outcome).toBeInstanceOf(ResourceInboxHandlerRetryableConflict);
        expect(outcome?.code).toBe('group-presence-summary-replan-changed');
        expect(outcome?.retryDelayMs).toBe(GROUP_PRESENCE_SUMMARY_CONFLICT_RETRY_DELAY_MS);
        expect(await fixture.readCommittedDeltas(seeded.ref)).toHaveLength(1);
    });

    it('coalesces the due siblings a failed page released together with the next row it claims', async () => {
        const headRead = { blind: true };
        const fixture = await createCoalescingFixture(undefined, undefined, headRead);
        const seeded = await fixture.seedConnectedGroup('released-siblings-room', 4);
        await fixture.processAlone(seeded.entries[0]!);
        const pending = await fixture.enqueue(seeded.entries.slice(1));
        expect(await fixture.process(pending[0]!)).toBeInstanceOf(ResourceInboxHandlerRetryableConflict);
        const released = await Promise.all(pending.slice(1).map(async (entry) => await fixture.resources.entries.findByKey(entry.key)));
        expect(released.map((entry) => entry?.status)).toEqual([EntityStatus.RETRY, EntityStatus.RETRY]);
        headRead.blind = false;
        await new Promise((resolve) => setTimeout(resolve, 5));

        await expect(fixture.process(released[0]!)).resolves.toBeUndefined();

        for (const entry of released) {
            expect((await fixture.resources.entries.findByKey(entry!.key))?.status, entry!.key.resourceId).toBe(
                EntityStatus.COMPLETED
            );
        }
    });

    it('bounds a coalesced page by the AL payload limit and completes the rest from the rows it released', async () => {
        const fixture = await createCoalescingFixture();
        const seeded = await fixture.seedConnectedGroup('payload-bounded-room', LARGE_PAGE_CONNECTS);
        const pending = await fixture.enqueue(seeded.entries);

        await expect(fixture.process(pending[0]!)).resolves.toBeUndefined();

        const afterFirstPage = await Promise.all(pending.map(async (entry) => (await fixture.resources.entries.findByKey(entry.key))!));
        const completed = afterFirstPage.filter((entry) => entry.status === EntityStatus.COMPLETED);
        const released = afterFirstPage.filter((entry) => entry.status === EntityStatus.RETRY);
        expect(completed.length).toBeGreaterThan(1);
        expect(released.length).toBe(LARGE_PAGE_CONNECTS - completed.length);
        expect(released.length).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 5));

        await expect(fixture.process(released[0]!)).resolves.toBeUndefined();

        for (const entry of pending) {
            expect((await fixture.resources.entries.findByKey(entry.key))?.status, entry.key.resourceId).toBe(
                EntityStatus.COMPLETED
            );
        }
        const committed = await fixture.readCommittedOutbox(seeded.ref);
        expect(committed).toHaveLength(LARGE_PAGE_CONNECTS);
        for (const entry of committed) {
            const payload = decodePersistedALMessage(entry.resource).payload.resource;
            expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(AL_MESSAGE_RESOURCE_LIMITS.payloadBytes);
        }
        expect((await fixture.readSummary(seeded.ref)).activePrincipalCount).toBe(LARGE_PAGE_CONNECTS);
    });
});

interface SeededConnectedGroup {
    readonly ref: GroupRef;
    readonly principalIds: readonly string[];
    readonly entries: readonly ResourceEntry[];
}

interface CoalescingFixture {
    readonly resources: PSqlResourceInboxRepository;
    readonly repositoryCalls: string[];
    /** Seeds the group's state and returns its summary work rows without queueing them. */
    seedConnectedGroup(groupId: string, connectCount: number): Promise<SeededConnectedGroup>;
    /** Queues rows and returns them as stored, which is what a reservation observes. */
    enqueue(entries: readonly ResourceEntry[]): Promise<readonly ResourceEntry[]>;
    /** Reserves the row from its stored status, NEW or due RETRY, and hands it to the worker; resolves with its outcome. */
    process(entry: ResourceEntry): Promise<ResourceInboxHandlerRetryableConflict | undefined>;
    /** Queues and expands one row while no sibling is pending; returns the repository calls the expansion made. */
    processAlone(entry: ResourceEntry): Promise<readonly string[]>;
    readSummary(ref: GroupRef): Promise<GroupPresenceSummary>;
    readCommittedDeltas(ref: GroupRef): Promise<readonly GroupStateDeltaEnvelope[]>;
    readCommittedOutbox(ref: GroupRef): Promise<readonly ResourceEntry[]>;
    /** The group's coalesced replan rows, head first, in insertion order. */
    readTopologyRows(ref: GroupRef): Promise<readonly ResourceEntry[]>;
    /** Marks the group's replan head as claimed by a topology worker, as a recompute in flight leaves it. */
    reserveTopologyHead(ref: GroupRef): Promise<void>;
    /** Overwrites a stored row's resource, as a row of another request under the same key would read. */
    replaceStoredResource(key: Key, resource: string): Promise<void>;
}

/** Reads no replan head, as a summary whose read ran before another writer queued it. */
class HeadBlindQueueBox extends PSqlQueueBox {
    private readonly headRead: Readonly<{ blind: boolean; }>;

    constructor(resources: PSqlResourceInboxRepository, headRead: Readonly<{ blind: boolean; }>) {
        super(resources, Temporal.Now.instant);
        this.headRead = headRead;
    }

    override async getItem(key: Key): Promise<ResourceEntry | undefined> {
        return this.headRead.blind && key.topicId === APP_OUTBOX_RTC_TOPOLOGY_TOPIC ? undefined : await super.getItem(key);
    }
}

async function createCoalescingFixture(
    timingEvents?: RallarTimingEvent[],
    wakeQueue?: () => void,
    /** Present, the worker's replan-head reads see no head while it says so. */
    headRead?: Readonly<{ blind: boolean; }>
): Promise<CoalescingFixture> {
    const { sql } = await createPSqlAdmissionTestStorage();
    const now = Date.now();
    const repository = new RecordingRuntimeStateRepository(sql);
    const repositoryCalls = repository.calls;
    const resources = createPSqlResourceInboxRepository(sql, () => new Date(now));
    const queue = headRead === undefined
        ? new PSqlQueueBox(resources, Temporal.Now.instant)
        : new HeadBlindQueueBox(resources, headRead);
    const worker = new GroupPresenceSummaryWork({
        database: sql,
        runtimeRepository: repository,
        outboxQueueReader: new OutboxQueueReader(queue),
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0,
        serviceId: 'coalescing-api',
        now: () => now,
        timing: timingEvents === undefined ? undefined : (event) => timingEvents.push(event),
        wakeQueue
    });
    const process = createReservedSummaryProcessor(queue, worker);
    const enqueue = async (entries: readonly ResourceEntry[]): Promise<readonly ResourceEntry[]> => {
        const stored: ResourceEntry[] = [];
        for (const entry of entries) {
            stored.push(await resources.entries.write(entry));
        }
        return stored;
    };
    return {
        resources,
        repositoryCalls,
        seedConnectedGroup: async (groupId, connectCount) => await seedConnectedGroup({ repository, groupId, connectCount, now }),
        enqueue,
        process,
        processAlone: async (entry) => {
            const [stored] = await enqueue([entry]);
            repositoryCalls.length = 0;
            await process(stored!);
            return [...repositoryCalls];
        },
        readSummary: async (ref) => {
            const summary = await new GroupStateRepositoryReads(repository).findPresenceSummaryEntry(ref);
            if (summary === undefined) {
                throw new Error(`Missing presence summary: ${ref.groupId}`);
            }
            return summary.value;
        },
        readCommittedDeltas: async (ref) => await readCommittedDeltas(sql, ref),
        readCommittedOutbox: async (ref) => await readCommittedOutbox(sql, ref),
        readTopologyRows: async (ref) => await readTopologyRows(sql, ref),
        replaceStoredResource: async (key, resource) => {
            await sql`update resource_inbox set ri_resource = ${resource}
                where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId}
                  and fk_ext_bank_id = ${key.contextId}`;
        },
        reserveTopologyHead: async (ref) => {
            const head = toCoalescedGroupRevisionKey(ref);
            await sql`update resource_inbox
                set ri_status = ${EntityStatus.RESERVED}, ri_attempts = ri_attempts + 1,
                    start_ts = now() at time zone 'UTC', next_ts = null
                where ri_topic_id = ${head.topicId} and ri_resource_id = ${head.resourceId}
                  and fk_ext_bank_id = ${head.contextId}`;
        }
    };
}

/** Runs the fixture through the real reservation-to-worker handoff. */
function createReservedSummaryProcessor(
    queue: PSqlQueueBox,
    worker: GroupPresenceSummaryWork
): CoalescingFixture['process'] {
    return async (entry) => {
        const reserved = [...(await queue.reserveEntries({
            typeIds: new Set([EnqueuedType.APP_OUTBOX]),
            statusIds: new Set([entry.status]),
            reservationInput: 1,
            observedEntries: [entry]
        })).values()][0];
        if (reserved === undefined) {
            throw new Error(`Expected to reserve ${entry.key.resourceId}`);
        }
        return await worker.processReservedEntry(decodePersistedALMessage(reserved.resource), reserved);
    };
}

interface SeedConnectedGroupInput {
    readonly repository: PSqlRuntimeStateRepository;
    readonly groupId: string;
    readonly connectCount: number;
    readonly now: number;
}

async function seedConnectedGroup(
    { repository, groupId, connectCount, now }: SeedConnectedGroupInput
): Promise<SeededConnectedGroup> {
    const runtime = new GroupBarrierRepository();
    const service = createService(runtime, now);
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers: connectCount + 1,
        createdByPrincipalId: 'owner',
        requestId: `create-${groupId}`
    });
    const principalIds = Array.from({ length: connectCount }, (_, index) => `member-${index}`);
    for (const principalId of principalIds) {
        await service.upsertMember(SCOPE, groupId, principalId, {
            status: 'active',
            actorPrincipalId: 'owner',
            requestId: `activate-${groupId}-${principalId}`
        });
        await service.connectPresenceSession(SCOPE, groupId, `${groupId}-${principalId}-session`, {
            principalId,
            generationId: `${groupId}-${principalId}-generation`,
            connectionGenerationId: `${groupId}-${principalId}-ws-generation`,
            actorPrincipalId: principalId,
            expiresAtEpochMs: now + 60_000,
            requestId: `connect-${groupId}-${principalId}`
        });
    }
    for (const namespace of Object.values(GroupNamespaces)) {
        for (const entry of await runtime.findAllEntries(namespace)) {
            await repository.upsert(namespace, entry.key, entry.value, entry.expireAtTimestamp);
        }
    }
    const ref = groupRef(groupId);
    const entries = runtime.groupStateEventStore.events
        .filter((event) => event.groupId === groupId && event.eventType === 'session-connected')
        .map((event) =>
            computeGroupPresenceSummaryEntry({
                effectKind: 'group-presence-summary',
                aggregateRef: ref,
                commandId: event.requestId!,
                createdAtEpochMs: event.occurredAtEpochMs,
                expireAtEpochMs: now + 60_000,
                acceptedCausalRevision: event.causalRevision,
                event
            }, 'coalescing-api')
        );
    return { ref, principalIds, entries };
}

/** Records each read the worker makes at the runtime-state port, in call order. */
class RecordingRuntimeStateRepository extends PSqlRuntimeStateRepository {
    readonly calls: string[] = [];

    override findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        this.calls.push('findEntry');
        return super.findEntry(namespace, key);
    }

    override findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        this.calls.push('findAllEntries');
        return super.findAllEntries(namespace);
    }

    override readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.calls.push('readRuntimeStateBatch');
        return super.readRuntimeStateBatch(selectors);
    }

    override findEntriesByPrefix(namespace: string, keyPrefix: string): Promise<readonly RuntimeStateEntry[]> {
        this.calls.push('findEntriesByPrefix');
        return super.findEntriesByPrefix(namespace, keyPrefix);
    }

    override findEntriesByKeys(namespace: string, keys: readonly string[]): Promise<readonly RuntimeStateEntry[]> {
        this.calls.push('findEntriesByKeys');
        return super.findEntriesByKeys(namespace, keys);
    }

    override findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: Readonly<{ afterKey?: string; limit: number; }>
    ): Promise<readonly RuntimeStateEntry[]> {
        this.calls.push('findEntriesByPrefixPage');
        return super.findEntriesByPrefixPage(namespace, keyPrefix, options);
    }
}

async function readCommittedDeltas(sql: PSqlSql, ref: GroupRef): Promise<readonly GroupStateDeltaEnvelope[]> {
    const rows = await readCommittedOutbox(sql, ref);
    return rows.map((entry) => decodeGroupStateDeltaEnvelope(JSON.parse(decodePersistedALMessage(entry.resource).payload.resource)));
}

async function readCommittedOutbox(sql: PSqlSql, ref: GroupRef): Promise<readonly ResourceEntry[]> {
    const rows = await sql<ResourceInboxRow[]>`select * from resource_inbox
        where ri_type_id = ${EnqueuedType.WS_OUTBOX} and ri_resource::jsonb->'targets'->'groupRef'->>'groupId' = ${ref.groupId}
        order by ri_row_id`;
    return rows.map(toDomain);
}

function decodeGroupStateDeltaEnvelope(value: unknown): GroupStateDeltaEnvelope {
    validateGroupStateDeltaEnvelope(value);
    return value;
}

async function readTopologyRows(sql: PSqlSql, ref: GroupRef): Promise<readonly ResourceEntry[]> {
    const head = toCoalescedGroupRevisionKey(ref);
    const rows = await sql<ResourceInboxRow[]>`select * from resource_inbox
        where ri_topic_id = ${head.topicId} and fk_ext_bank_id = ${head.contextId}
        order by ri_row_id`;
    return rows.map(toDomain);
}

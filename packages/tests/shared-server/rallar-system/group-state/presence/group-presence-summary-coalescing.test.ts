import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { GroupStateRepositoryReads } from '@shared-server/rallar-system/group-state/persistence/group-state-repository-reads.ts';
import * as GroupNamespaces from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { validateGroupStateDeltaEnvelope, type GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { GroupPresenceSummary, GroupRef } from '@shared/api/group-types.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createPSqlAdmissionTestStorage } from '../../../al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService } from './group-presence-test-runtime.ts';

describe('group presence summary coalescing', () => {
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
    process(entry: ResourceEntry): Promise<void>;
    /** Queues and expands one row while no sibling is pending; returns the repository calls the expansion made. */
    processAlone(entry: ResourceEntry): Promise<readonly string[]>;
    readSummary(ref: GroupRef): Promise<GroupPresenceSummary>;
    readCommittedDeltas(ref: GroupRef): Promise<readonly GroupStateDeltaEnvelope[]>;
}

async function createCoalescingFixture(): Promise<CoalescingFixture> {
    const { sql } = await createPSqlAdmissionTestStorage();
    const now = Date.now();
    const repository = new RecordingRuntimeStateRepository(sql);
    const repositoryCalls = repository.calls;
    const resources = createPSqlResourceInboxRepository(sql, () => new Date(now));
    const queue = new PSqlQueueBox(resources, Temporal.Now.instant);
    const worker = new GroupPresenceSummaryWork({
        database: sql,
        runtimeRepository: repository,
        outboxQueueReader: new OutboxQueueReader(queue),
        recomputeDebounceMs: 0,
        recomputeMaxWaitMs: 0,
        serviceId: 'coalescing-api',
        now: () => now
    });
    const process = async (entry: ResourceEntry): Promise<void> => {
        const reserved = [...(await queue.reserveEntries({
            typeIds: new Set([EnqueuedType.APP_OUTBOX]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1,
            observedEntries: [entry]
        })).values()][0];
        if (reserved === undefined) {
            throw new Error(`Expected to reserve ${entry.key.resourceId}`);
        }
        await worker.processReservedEntry(decodePersistedALMessage(reserved.resource), reserved);
    };
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
        readCommittedDeltas: async (ref) => await readCommittedDeltas(sql, ref)
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
    const rows = await sql<ResourceInboxRow[]>`select * from resource_inbox
        where ri_type_id = ${EnqueuedType.WS_OUTBOX} and ri_resource::jsonb->'targets'->'groupRef'->>'groupId' = ${ref.groupId}
        order by ri_row_id`;
    return rows.map((row) => decodeGroupStateDeltaEnvelope(JSON.parse(decodePersistedALMessage(toDomain(row).resource).payload.resource)));
}

function decodeGroupStateDeltaEnvelope(value: unknown): GroupStateDeltaEnvelope {
    validateGroupStateDeltaEnvelope(value);
    return value;
}

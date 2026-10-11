import { Temporal } from '@js-temporal/polyfill';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import * as GroupNamespaces from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createPSqlAdmissionTestStorage } from '../../../al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService } from './group-presence-test-runtime.ts';

export interface GroupDeltaProducerFixture {
    readonly database: PSqlSql;
    readonly repository: PSqlRuntimeStateRepository;
    readonly resources: PSqlResourceInboxRepository;
    readonly worker: GroupPresenceSummaryWork;
    readonly entry: ResourceEntry;
    readonly now: number;
    readonly ref: GroupRef;
    readonly message: ALMessage;
}

export async function createGroupDeltaProducer(sql?: PSqlSql): Promise<GroupDeltaProducerFixture> {
    const database = sql ?? (await createPSqlAdmissionTestStorage()).sql;
    const repository = new PSqlRuntimeStateRepository(database);
    const now = Date.now();
    const resources = createPSqlResourceInboxRepository(database, () => new Date(now));
    const queue = new PSqlQueueBox(resources);
    const groupId = `proved-${crypto.randomUUID()}`;
    const runtime = await seedConnectedGroup(groupId, now);
    for (const namespace of Object.values(GroupNamespaces)) {
        for (const entry of await runtime.findAllEntries(namespace)) {
            await repository.upsert(namespace, entry.key, entry.value, entry.expireAtTimestamp);
        }
    }
    const worker = new GroupPresenceSummaryWork({
        database,
        runtimeRepository: repository,
        outboxQueueReader: new OutboxQueueReader(queue),
        recomputeDebounceMs: 0,
        serviceId: 'producer-api',
        now: () => now
    });
    const event = runtime.groupStateEventStore.events.find((candidate) => candidate.eventType === 'session-connected')!;
    const queued = computeGroupPresenceSummaryEntry({
        effectKind: 'group-presence-summary',
        aggregateRef: groupRef(groupId),
        commandId: event.requestId!,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: now + 60_000,
        acceptedCausalRevision: event.causalRevision,
        event
    }, 'producer-api');
    const entry: ResourceEntry = {
        ...queued,
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1, startTs: Temporal.Instant.fromEpochMilliseconds(now) }
    };
    await resources.entries.write(entry);
    return { database, repository, resources, worker, entry, now, ref: groupRef(groupId), message: decodePersistedALMessage(entry.resource) };
}

export async function readCommittedGroupDelta(producer: GroupDeltaProducerFixture): Promise<ResourceEntry> {
    const rows = await producer.database<ResourceInboxRow[]>`select * from resource_inbox
        where ri_type_id = ${EnqueuedType.WS_OUTBOX} and ri_resource::jsonb->'targets'->'groupRef'->>'groupId' = ${producer.ref.groupId}`;
    if (rows.length !== 1) {
        throw new Error(`Expected one committed group delta, received ${rows.length}`);
    }
    return toDomain(rows[0]!);
}

async function seedConnectedGroup(groupId: string, now: number): Promise<GroupBarrierRepository> {
    const runtime = new GroupBarrierRepository();
    const service = createService(runtime, now);
    await service.createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        requestId: `create-${groupId}`
    });
    await service.connectPresenceSession(SCOPE, groupId, 'session-alice', {
        principalId: 'alice',
        generationId: 'generation-alice',
        actorPrincipalId: 'alice',
        expiresAtEpochMs: now + 60_000,
        requestId: `connect-${groupId}`
    });
    return runtime;
}

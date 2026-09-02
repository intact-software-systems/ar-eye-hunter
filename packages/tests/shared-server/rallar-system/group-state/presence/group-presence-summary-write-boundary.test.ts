import { PGlite } from '@electric-sql/pglite';
import { Temporal } from '@js-temporal/polyfill';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { computeAppOutboxInsert, writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    GROUPS_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE
} from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    validateGroupPresenceSummary,
    type GroupPresenceSummaryRead
} from '@shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts';
import {
    computeGroupPresenceSummaryWork,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryWorkRead
} from '@shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { readRtcTopologyWorkEnvelope } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupMember, GroupPresenceSummary } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { COALESCED_APP_OUTBOX_WORK_FIELD } from '@shared/queuebox/coalesced-app-outbox-work-envelope.ts';
import { computeGroupPresenceSummaryEntry, type GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { createPGliteSqlClient, type PGliteSql } from '../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createTestGroup } from '../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase, type AppInboxTestDatabase } from '../../app-inbox/test-support/app-inbox-test-database.ts';
import { TestResourceInbox, TestResourceInboxResults } from '../inbox/group-state-inbox-resource-fixtures.ts';

const NOW = 1_900_000_000_000;
const REF = { applicationId: 'summary-app', workspaceId: 'main', groupId: 'summary-group' };

interface SummaryAttempt {
    readonly worker: GroupPresenceSummaryWork;
    readonly runtime: FakeRuntimeStateRepository;
    readonly database: AppInboxTestDatabase;
    readonly outbox: InMemoryQueueBox;
    readonly command: GroupPresenceSummaryWorkData;
    readonly entry: ResourceEntry;
    readonly message: ALMessage;
    readonly read: GroupPresenceSummaryWorkRead;
    readonly computed: GroupPresenceSummaryComputedWork;
    readonly effects: string[];
}

afterEach(() => vi.restoreAllMocks());

describe('presence summary pre-transaction validation', () => {
    it('reads the aggregate and presence collections from one database snapshot', async () => {
        const source = createSummaryRead(0, false);
        const owner = source.members[0]!.value;
        const member: GroupMember = {
            ...owner,
            principalId: 'bob',
            role: 'member'
        };
        const runtime = new TornPresenceSummaryReadRuntimeRepository();
        runtime.data.set(
            `${GROUPS_NAMESPACE}::${source.group.entry.key}`,
            stored(source.group.entry.key, { ...source.group.value, activeMemberCount: 2 }, 0).entry
        );
        for (const storedMember of [source.members[0]!, stored(groupStateMemberStorageKey(member), member, 0)]) {
            runtime.data.set(`${MEMBERS_NAMESPACE}::${storedMember.entry.key}`, storedMember.entry);
        }
        runtime.data.set(
            `${PRESENCE_SUMMARIES_NAMESPACE}::${source.current!.entry.key}`,
            source.current!.entry
        );
        const command = createSummaryCommand();
        const entry = {
            ...computeGroupPresenceSummaryEntry(command, 'summary-worker'),
            status: EntityStatus.RESERVED,
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Instant.fromEpochMilliseconds(NOW)
            }
        };
        const worker = new GroupPresenceSummaryWork({
            runtimeRepository: runtime,
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            now: () => NOW,
            serviceId: 'summary-worker'
        });

        const read = await worker.read(command, entry);

        expect(runtime.readBatchCalls).toHaveLength(1);
        expect(runtime.readBatchCalls[0]).toHaveLength(5);
        expect(read.presence.members.map(({ value }) => value.principalId)).toEqual(['alice', 'bob']);
        expect(() => worker.compute(command, read)).not.toThrow();
    });

    it('rejects an original MAX storage revision update in the domain validator', async () => {
        const attempt = await createSummaryAttempt(Number.MAX_SAFE_INTEGER, false);
        expect(attempt.computed.summary).toMatchObject({
            outcome: 'write',
            operation: 'update',
            expectedRevision: Number.MAX_SAFE_INTEGER
        });

        expect(validateGroupPresenceSummary({
            ref: REF,
            read: attempt.read.presence,
            computed: attempt.computed.summary
        })).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.any(TypeError) })]));
    });

    it.each([-0, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
        'rejects original invalid update revision %s before opening a transaction',
        async (revision) => {
            const attempt = await createSummaryAttempt(0, false);
            const current = attempt.read.presence.current!;
            attempt.runtime.data.set(
                `${PRESENCE_SUMMARIES_NAMESPACE}::${current.entry.key}`,
                { ...current.entry, revision }
            );
            const transactionCount = observeTransactionCount(attempt.database);
            const before = new Map(attempt.runtime.data);

            await expect(attempt.worker.processReservedEntry(attempt.message, attempt.entry)).rejects.toThrow();

            expect(transactionCount()).toBe(0);
            expect(attempt.runtime.data).toEqual(before);
            expect(attempt.database.outboxEntries.size).toBe(0);
            expect(attempt.effects).toEqual([]);
        }
    );

    it.each([0, 0.5, Number.MAX_SAFE_INTEGER])(
        'rejects original non-incrementable coalesced generation %s before any transaction',
        async (generation) => {
            const attempt = await createSummaryAttempt(0, false);
            const previous = withCoalescedGeneration(attempt.computed.coalescedTopologyWork.entryWrite.entry, generation);
            await attempt.outbox.enqueue(previous);
            const transactionCount = observeTransactionCount(attempt.database);
            const before = new Map(attempt.runtime.data);

            const processing = attempt.worker.processReservedEntry(attempt.message, attempt.entry);
            await expect(processing).rejects.toThrow();
            expect(transactionCount()).toBe(0);
            await expect(processing).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);
            expect(attempt.runtime.data).toEqual(before);
            expect(attempt.database.outboxEntries.size).toBe(0);
            expect(attempt.effects).toEqual([]);
        }
    );

    it.each([0, Number.MAX_SAFE_INTEGER - 1])('accepts incrementable update revision %s', async (revision) => {
        const attempt = await createSummaryAttempt(revision, false);
        expect(attempt.computed.summary).toMatchObject({ outcome: 'write', operation: 'update', expectedRevision: revision });

        await attempt.worker.processReservedEntry(attempt.message, attempt.entry);

        const stored = await attempt.runtime.findEntry(PRESENCE_SUMMARIES_NAMESPACE, groupStateGroupStorageKey(REF));
        expect(stored?.revision).toBe(revision + 1);
        expect(stored?.value).toBe(attempt.computed.summaryWrite?.value);
        expect(attempt.effects).toEqual(['wake', 'metric']);
    });

    it('preserves MAX for a no-op summary while completing its downstream work', async () => {
        const attempt = await createSummaryAttempt(Number.MAX_SAFE_INTEGER, true);
        expect(attempt.computed.summary.outcome).toBe('no-op');
        expect(attempt.computed.summaryWrite).toBeNull();

        await attempt.worker.processReservedEntry(attempt.message, attempt.entry);

        const stored = await attempt.runtime.findEntry(PRESENCE_SUMMARIES_NAMESPACE, groupStateGroupStorageKey(REF));
        expect(stored?.revision).toBe(Number.MAX_SAFE_INTEGER);
        expect(attempt.database.outboxEntries.size).toBe(2);
        expect(attempt.effects).toEqual(['wake', 'metric']);
    });

    it('rejects negative zero in the SQL guard instead of equating it with the original zero', async () => {
        const attempt = await createSummaryAttempt(0, false);
        const transactionCount = observeTransactionCount(attempt.database);
        vi.spyOn(attempt.worker, 'compute').mockImplementation((command, read) => {
            const computed = computeGroupPresenceSummaryWork(command, read);
            if (!computed.summaryWrite) {
                throw new Error('Expected an update');
            }
            return { ...computed, summaryWrite: { ...computed.summaryWrite, expectedRevision: -0 } };
        });

        await expect(attempt.worker.processReservedEntry(attempt.message, attempt.entry)).rejects.toThrow();

        expect(transactionCount()).toBe(0);
        expect(attempt.database.outboxEntries.size).toBe(0);
        expect(attempt.effects).toEqual([]);
    });

    it.each(['root proxy', 'summary getter', 'runtime-write proxy', 'inherited toJSON'] as const)(
        'rejects a %s without invoking candidate code or opening a transaction',
        async (kind) => {
            const attempt = await createSummaryAttempt(0, false);
            const transactionCount = observeTransactionCount(attempt.database);
            const accesses: string[] = [];
            attempt.worker.compute = (command, read) => {
                const computed = computeGroupPresenceSummaryWork(command, read);
                return createUnsafeCandidate(computed, kind, accesses);
            };

            await expect(attempt.worker.processReservedEntry(attempt.message, attempt.entry)).rejects.toThrow(TypeError);

            expect(accesses).toEqual([]);
            expect(transactionCount()).toBe(0);
            expect(attempt.database.outboxEntries.size).toBe(0);
            expect(attempt.effects).toEqual([]);
        }
    );
});

describe('presence summary downstream SQL writes', () => {
    let database: PGliteSql;

    beforeEach(async () => {
        database = createPGliteSqlClient(new PGlite());
        await database.exec(readFileSync(new URL('../../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url), 'utf8'));
    });

    afterEach(async () => {
        await database.close();
    });

    it('persists downstream bytes without formatting their timestamps inside the transaction', async () => {
        const attempt = await createSummaryAttempt(0, true);
        const reservationWrite = computeAppOutboxInsert(attempt.entry);
        expect(attempt.worker.validate(attempt.command, attempt.read, attempt.computed)).toEqual([]);
        await database.begin((transaction) => writeAppOutboxInsert(transaction, reservationWrite));
        const downstream = attempt.computed.downstreamOutboxWrites[0]!.entry;
        const originalToString = Temporal.PlainDateTime.prototype.toString;
        const formatting: string[] = [];
        vi.spyOn(Temporal.PlainDateTime.prototype, 'toString').mockImplementation(function (this: Temporal.PlainDateTime, options) {
            if (this === downstream.audit.createdTs) {
                formatting.push('downstream timestamp');
                throw new Error('Downstream timestamp formatting inside write');
            }
            return originalToString.call(this, options);
        });

        await database.begin((transaction) => attempt.worker.write(transaction, attempt.computed));

        expect(formatting).toEqual([]);
        expect(await database`select ri_resource, ri_status, ri_attempts from resource_inbox where ri_topic_id = ${AppTopics.groupStateEvent}`)
            .toEqual([{ ri_resource: downstream.resource, ri_status: 'NEW', ri_attempts: 0 }]);
        expect(await database`select ri_status from resource_inbox where ri_resource_id = ${attempt.entry.key.resourceId}`)
            .toEqual([{ ri_status: 'COMPLETED' }]);
    });

    it('matches completed downstream replay bytes without replacing their lifecycle', async () => {
        const attempt = await createSummaryAttempt(0, false);
        const downstream = attempt.computed.downstreamOutboxWrites[0]!.entry;
        const replay = computeAppOutboxInsert({
            ...downstream,
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 2, startTs: Temporal.Instant.fromEpochMilliseconds(NOW), endTs: Temporal.Instant.fromEpochMilliseconds(NOW + 1) }
        });
        await seedDatabaseSummaryAttempt(database, attempt);
        await database.begin((transaction) => writeAppOutboxInsert(transaction, replay));
        const before = await database`select * from resource_inbox where ri_topic_id = ${AppTopics.groupStateEvent}`;
        const effects: string[] = [];
        const worker = createDatabaseSummaryWorker(database, attempt, effects);

        await worker.processReservedEntry(attempt.message, attempt.entry);

        expect(await database`select * from resource_inbox where ri_topic_id = ${AppTopics.groupStateEvent}`).toEqual(before);
        expect(await database`select store_value, revision from runtime_state_store`).toEqual([
            { store_value: attempt.computed.summaryWrite?.value, revision: 1 }
        ]);
        expect(effects).toEqual(['wake', 'metric']);
    });

    it.each(['immutable bytes', 'invalid lifecycle'] as const)('rolls back the summary CAS on downstream %s collision', async (defect) => {
        const attempt = await createSummaryAttempt(0, false);
        const downstream = attempt.computed.downstreamOutboxWrites[0]!;
        await seedDatabaseSummaryAttempt(database, attempt);
        await database.begin((transaction) => writeAppOutboxInsert(transaction, downstream));
        if (defect === 'immutable bytes') {
            await database`update resource_inbox set ri_resource = 'conflicting bytes' where ri_topic_id = ${AppTopics.groupStateEvent}`;
        }
        else {
            await database`update resource_inbox set ri_status = 'COMPLETED' where ri_topic_id = ${AppTopics.groupStateEvent}`;
        }
        const beforeState = await database`select * from runtime_state_store`;
        const beforeOutbox = await database`select * from resource_inbox order by ri_row_id`;
        const effects: string[] = [];
        const worker = createDatabaseSummaryWorker(database, attempt, effects);
        const transactionCount = observeTransactionCount(database);

        await expect(worker.processReservedEntry(attempt.message, attempt.entry)).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);

        expect(transactionCount()).toBe(1);
        expect(await database`select * from runtime_state_store`).toEqual(beforeState);
        expect(await database`select * from resource_inbox order by ri_row_id`).toEqual(beforeOutbox);
        expect(effects).toEqual([]);
    });

    it('rolls back summary and both downstream writes on late reservation loss', async () => {
        const attempt = await createSummaryAttempt(0, false);
        await seedDatabaseSummaryAttempt(database, attempt);
        await database`update resource_inbox set ri_attempts = 2`;
        const beforeState = await database`select * from runtime_state_store`;
        const beforeOutbox = await database`select * from resource_inbox`;
        const effects: string[] = [];
        const worker = createDatabaseSummaryWorker(database, attempt, effects);
        const transactionCount = observeTransactionCount(database);

        await expect(worker.processReservedEntry(attempt.message, attempt.entry))
            .rejects.toThrow('Presence-summary reservation changed before commit');

        expect(transactionCount()).toBe(1);
        expect(await database`select * from runtime_state_store`).toEqual(beforeState);
        expect(await database`select * from resource_inbox`).toEqual(beforeOutbox);
        expect(effects).toEqual([]);
    });

    it('exits after a lost summary CAS and recomputes from fresh facts only on the next delivery', async () => {
        const attempt = await createSummaryAttempt(0, false);
        await seedDatabaseSummaryAttempt(database, attempt);
        await database`update runtime_state_store set revision = 1`;
        const beforeOutbox = await database`select * from resource_inbox`;
        const effects: string[] = [];
        const worker = createDatabaseSummaryWorker(database, attempt, effects);
        const transactionCount = observeTransactionCount(database);

        await expect(worker.processReservedEntry(attempt.message, attempt.entry)).rejects.toThrow();

        expect(transactionCount()).toBe(1);
        expect(await database`select * from resource_inbox`).toEqual(beforeOutbox);
        expect(effects).toEqual([]);
        const current = attempt.read.presence.current!;
        attempt.runtime.data.set(`${PRESENCE_SUMMARIES_NAMESPACE}::${current.entry.key}`, { ...current.entry, revision: 1 });

        await worker.processReservedEntry(attempt.message, attempt.entry);

        expect(transactionCount()).toBe(2);
        expect(await database`select store_value, revision from runtime_state_store`).toEqual([
            { store_value: attempt.computed.summaryWrite?.value, revision: 2 }
        ]);
        expect(effects).toEqual(['wake', 'metric']);
    });
});

function createDatabaseSummaryWorker(database: PGliteSql, attempt: SummaryAttempt, effects: string[]): GroupPresenceSummaryWork {
    return new GroupPresenceSummaryWork({
        runtimeRepository: attempt.runtime,
        outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
        recomputeDebounceMs: 0,
        database,
        now: () => NOW,
        serviceId: 'summary-worker',
        wakeQueue: () => {
            effects.push('wake');
        },
        formationMetrics: () => {
            effects.push('metric');
        }
    });
}

async function seedDatabaseSummaryAttempt(database: PGliteSql, attempt: SummaryAttempt): Promise<void> {
    const current = attempt.read.presence.current!;
    const reservationWrite = computeAppOutboxInsert(attempt.entry);
    const expiry = new Date(current.entry.expireAtTimestamp).toISOString();
    await database.begin(async (transaction) => {
        await transaction`insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, revision)
            values (${PRESENCE_SUMMARIES_NAMESPACE}, ${current.entry.key}, ${current.entry.value}, ${expiry}, ${current.entry.revision})`;
        await writeAppOutboxInsert(transaction, reservationWrite);
    });
}

async function createSummaryAttempt(revision: number, noOp: boolean): Promise<SummaryAttempt> {
    const read = createSummaryRead(revision, noOp);
    const command = createSummaryCommand();
    const queued = computeGroupPresenceSummaryEntry(command, 'summary-worker');
    const entry: ResourceEntry = {
        ...queued,
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1, startTs: Temporal.Instant.fromEpochMilliseconds(NOW) }
    };
    const runtime = new FakeRuntimeStateRepository();
    runtime.data.set(`${GROUPS_NAMESPACE}::${read.group.entry.key}`, read.group.entry);
    for (const member of read.members) {
        runtime.data.set(`${MEMBERS_NAMESPACE}::${member.entry.key}`, member.entry);
    }
    if (read.current) {
        runtime.data.set(`${PRESENCE_SUMMARIES_NAMESPACE}::${read.current.entry.key}`, read.current.entry);
    }
    const queue = new TestResourceInbox();
    await queue.enqueue(entry);
    const database = createAppInboxTestDatabase(queue, new TestResourceInboxResults(), { runtimeRepository: runtime });
    const outbox = new InMemoryQueueBox();
    const effects: string[] = [];
    const worker = new GroupPresenceSummaryWork({
        runtimeRepository: runtime,
        outboxQueueReader: new OutboxQueueReader(outbox),
        recomputeDebounceMs: 0,
        database,
        now: () => NOW,
        serviceId: 'summary-worker',
        wakeQueue: () => {
            effects.push('wake');
        },
        formationMetrics: () => {
            effects.push('metric');
        }
    });
    const actualRead = await worker.read(command, entry);
    return {
        worker,
        runtime,
        database,
        outbox,
        command,
        entry,
        message: decodePersistedALMessage(entry.resource),
        read: actualRead,
        computed: worker.compute(command, actualRead),
        effects
    };
}

function createSummaryRead(revision: number, noOp: boolean): GroupPresenceSummaryRead {
    const group = createTestGroup({ ...REF, snapshotVersion: 2 });
    const member: GroupMember = {
        ...REF,
        principalId: 'alice',
        role: 'owner',
        status: 'active',
        joined: group.created,
        updated: group.updated,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
    const summary: GroupPresenceSummary = {
        ...REF,
        causalRevision: { groupRevision: noOp ? 2 : 1, presenceRevision: 1 },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: NOW - 1_000
    };
    return {
        group: stored(groupStateGroupStorageKey(REF), group, 0),
        members: [stored(groupStateMemberStorageKey(member), member, 0)],
        admissions: [],
        presenceSessions: [],
        current: stored(groupStateGroupStorageKey(REF), summary, revision)
    };
}

function stored<T>(key: string, value: T, revision: number): RuntimeStateEntryValue<T> {
    return {
        value,
        entry: { key, value: JSON.stringify(value), revision, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP, updatedTimestamp: new Date(NOW).toISOString() }
    };
}

function withCoalescedGeneration(entry: ResourceEntry, generation: number): ResourceEntry {
    const message = decodePersistedALMessage(entry.resource);
    const envelope = readRtcTopologyWorkEnvelope(message, AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
    const metadata = envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
    if (metadata === undefined) {
        throw new Error('Expected coalesced topology fixture metadata');
    }
    const data = {
        ...envelope.data,
        [COALESCED_APP_OUTBOX_WORK_FIELD]: { ...metadata, generation }
    };
    return {
        ...entry,
        resource: JSON.stringify({
            ...message,
            payload: { ...message.payload, resource: JSON.stringify({ ...envelope, data }) }
        })
    };
}

function createSummaryCommand(): GroupPresenceSummaryWorkData {
    return {
        effectKind: 'group-presence-summary',
        aggregateRef: REF,
        commandId: 'summary-command',
        createdAtEpochMs: NOW - 1_000,
        expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP,
        acceptedCausalRevision: { groupRevision: 2, presenceRevision: 1 },
        event: {
            ...REF,
            eventId: 'summary-event',
            eventType: 'group-updated',
            snapshotVersion: 2,
            causalRevision: { groupRevision: 2, presenceRevision: 1 },
            occurredAtEpochMs: NOW - 1_000,
            actor: { kind: 'service', serviceId: 'summary-worker' },
            reason: null,
            traceId: null,
            requestId: 'summary-command',
            payload: {}
        }
    };
}

function createUnsafeCandidate(
    computed: GroupPresenceSummaryComputedWork,
    kind: 'root proxy' | 'summary getter' | 'runtime-write proxy' | 'inherited toJSON',
    accesses: string[]
): GroupPresenceSummaryComputedWork {
    const traps: ProxyHandler<object> = {
        get(target, key, receiver) {
            accesses.push(String(key));
            return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
            accesses.push(String(key));
            return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) {
            accesses.push('prototype');
            return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
            accesses.push('keys');
            return Reflect.ownKeys(target);
        }
    };
    if (kind === 'root proxy') {
        return new Proxy<GroupPresenceSummaryComputedWork>(computed, traps);
    }
    if (kind === 'summary getter') {
        return Object.defineProperty({ ...computed }, 'summary', {
            enumerable: true,
            get() {
                accesses.push('summary');
                return computed.summary;
            }
        });
    }
    if (!computed.summaryWrite) {
        throw new Error('Expected summary write');
    }
    if (kind === 'runtime-write proxy') {
        return {
            ...computed,
            summaryWrite: new Proxy<NonNullable<GroupPresenceSummaryComputedWork['summaryWrite']>>(computed.summaryWrite, traps)
        };
    }
    const summaryWrite = { ...computed.summaryWrite };
    Object.setPrototypeOf(summaryWrite, {
        get toJSON() {
            accesses.push('toJSON');
            return undefined;
        }
    });
    return { ...computed, summaryWrite };
}

function observeTransactionCount(database: PSqlSql): () => number {
    const begin = database.begin.bind(database);
    let count = 0;
    vi.spyOn(database, 'begin').mockImplementation(async (operation) => {
        count += 1;
        return await begin(operation);
    });
    return () => count;
}

class TornPresenceSummaryReadRuntimeRepository extends FakeRuntimeStateRepository {
    readonly readBatchCalls: RuntimeStateReadBatchSelector[][] = [];

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.readBatchCalls.push([...selectors]);
        const selections = await super.readRuntimeStateBatch(selectors);
        if (selectors.length === 1 && selectors[0]?.namespace === MEMBERS_NAMESPACE) {
            return selections.map((selection) => ({
                ...selection,
                entries: selection.entries.slice(0, 1)
            }));
        }
        return selections;
    }
}

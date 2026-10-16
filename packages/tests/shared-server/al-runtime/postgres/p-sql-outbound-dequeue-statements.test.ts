import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlResourceInboxEntryReader } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-reader.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundMessageRuntime
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createOutboundMessage,
    createOutboundRuntimeWithWorkTask,
    OUTBOUND_TEST_SEND_PLANNER,
    runOutboundWorkTask
} from '../../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../../../shared/alm/outbound-test-payload.ts';
import {
    createPSqlAdmissionTestStorage,
    type PSqlAdmissionTestStorage
} from './create-p-sql-admission-test-storage.ts';

interface PGliteStatementCounts {
    readonly autocommit: number;
    readonly transactions: number;
    readonly inTransaction: number;
}

afterEach(() => vi.restoreAllMocks());

describe('the PostgreSQL outbound lane on a dequeued row', () => {
    // Before step 2g one dequeued row with one prepared send cost 33 statements, 19 of them
    // autocommit reads (13 point reads of state rows, 6 queue rows, 2 of them the claimed row itself).
    it('reads each admission stage in one statement per store, and the claimed row never again', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { runtime, sent, outbox } = createDequeueLane(storage);
        await runOutboundWorkTask(runtime);
        const row = QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage('dequeued'), 'outbox', Temporal.Now.instant());
        await outbox.enqueue(row);
        const counts = countPGliteStatements(storage.sql.raw);
        const readKeys = recordQueueRowReads();

        await runOutboundWorkTask(runtime);

        expect(sent.map((message) => message.id.msgId)).toEqual([decodePersistedALMessage(row.resource).id.msgId]);
        expect(readKeys().filter((key) => key === toKeyAsString(row.key))).toEqual([]);
        expect(counts()).toEqual({ autocommit: 8, transactions: 5, inTransaction: 10 });
    });

    // Before step 2g every dequeued row committed alone: ten admission transactions and ten sender versions.
    it('commits the dequeued rows of one sender in one batch as one admission transaction and one version bump', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { runtime, sent, outbox, admissionStore } = createDequeueLane(storage);
        await runOutboundWorkTask(runtime);
        const rows = await enqueueRows(outbox, 10);
        const writes = recordAdmissionWrites(admissionStore);

        await runOutboundWorkTask(runtime);
        await runOutboundWorkTask(runtime);

        expect(sent.map((message) => message.id.msgId).sort()).toEqual(rows.map(toMsgId).sort());
        expect(writes.dequeueCommits()).toBe(1);
        expect(await readSenderVersion(storage)).toBe(1);
    });

    it('commits each row alone when two rows of the group write one supersedence track', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { runtime, outbox, admissionStore } = createDequeueLane(storage, SUPERSEDING_PLANNER);
        await runOutboundWorkTask(runtime);
        await enqueueRows(outbox, 2);
        const writes = recordAdmissionWrites(admissionStore);

        await runOutboundWorkTask(runtime);

        // The group's one snapshot finds the shared write and writes nothing; then each row commits alone.
        expect(writes.dequeueCommits()).toBe(3);
        expect(await readSenderVersion(storage)).toBe(2);
    });

    it('conflicts the group on a claim that moved before its commit, then commits every other row alone', async () => {
        const storage = await createPSqlAdmissionTestStorage();
        const { runtime, sent, outbox, admissionStore } = createDequeueLane(storage);
        await runOutboundWorkTask(runtime);
        const [moved, ...others] = await enqueueRows(outbox, 4);
        const writes = recordAdmissionWrites(admissionStore, async () => {
            // Another owner's claim after a lease expiry moves exactly the attempt columns of one row.
            await storage.sql`update resource_inbox set ri_attempts = ri_attempts + 1 where ri_resource_id = ${moved!.key.resourceId}`;
        });

        await runOutboundWorkTask(runtime);
        await runOutboundWorkTask(runtime);

        expect(writes.dequeueCommits()).toBe(1 + 4);
        expect(sent.map((message) => message.id.msgId).sort()).toEqual(others.map(toMsgId).sort());
        expect(await readSenderVersion(storage)).toBe(3);
    });
});

const NAMESPACE = 'dequeue-statements:outbound:admission';

const SUPERSEDING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, undefined),
    supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
});

async function enqueueRows(outbox: QueueBoxResourceEntryRepository, count: number): Promise<ResourceEntry[]> {
    const rows: ResourceEntry[] = [];
    for (let index = 0; index < count; index += 1) {
        const row = QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage(`dequeued-${index}`), 'outbox', Temporal.Now.instant());
        await outbox.enqueue(row);
        rows.push(row);
    }
    return rows;
}

function toMsgId(row: ResourceEntry): string {
    return decodePersistedALMessage(row.resource).id.msgId;
}

async function readSenderVersion(storage: PSqlAdmissionTestStorage): Promise<number | undefined> {
    const entry = await storage.repository.findEntry(NAMESPACE, `${NAMESPACE}:version:self`);
    return entry === undefined ? undefined : (JSON.parse(entry.value) as { version: number; }).version;
}

/** Every admission commit that admits a dequeued row, alone or as a group, counted as it reaches the store. */
function recordAdmissionWrites(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    beforeFirstDequeueCommit?: () => Promise<void>
): { dequeueCommits(): number; } {
    let dequeueCommits = 0;
    const commitBundles = store.commitBundles.bind(store);
    const commitBundle = store.commitBundle.bind(store);
    const count = async (bundles: readonly ALOutboundCommitBundle<OutboundTestPayload>[]) => {
        if (bundles.some((bundle) => bundle.canonicalEntry?.typeId === 'outbox')) {
            if (dequeueCommits === 0) {
                await beforeFirstDequeueCommit?.();
            }
            dequeueCommits += 1;
        }
    };
    vi.spyOn(store, 'commitBundles').mockImplementation(async (bundles) => {
        await count(bundles);
        return await commitBundles(bundles);
    });
    vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle, observation) => {
        await count([bundle]);
        return await commitBundle(bundle, observation);
    });
    return { dequeueCommits: () => dequeueCommits };
}

function createDequeueLane(
    storage: PSqlAdmissionTestStorage,
    planner: ALOutboundPlanner<OutboundTestPayload> = OUTBOUND_TEST_SEND_PLANNER
) {
    const stores = createPSqlALOutboundRuntimeStores({
        repository: storage.repository,
        namespace: 'dequeue-statements',
        nowMs: Date.now,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined,
        decodePrepared: decodeOutboundTestPayload
    });
    const sent: ALMessage[] = [];
    const runtime = createOutboundRuntimeWithWorkTask(() =>
        createDefaultALOutboundMessageRuntime({
            decodePreparedMessage: decodeOutboundTestPayload,
            outbox: stores.workQueue,
            stores,
            dequeue: { types: new Set(['outbox']), resilience: createDefaultALOutboundDequeueResilience() },
            carrier: 'ws',
            nowMs: Date.now,
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox', Temporal.Now.instant()),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: planner,
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage);
                return { status: 'sent', submissionAttempted: true };
            }
        })
    );
    return { runtime, sent, outbox: stores.workQueue, admissionStore: stores.admissionStore };
}

/** Every queue-row key read by key, one-key and batched reads alike. */
function recordQueueRowReads(): () => readonly string[] {
    const keys: string[] = [];
    const findByKey = PSqlResourceInboxEntryReader.prototype.findByKey;
    const findByKeys = PSqlResourceInboxEntryReader.prototype.findByKeys;
    vi.spyOn(PSqlResourceInboxEntryReader.prototype, 'findByKey').mockImplementation(function (
        this: PSqlResourceInboxEntryReader,
        key: Key
    ) {
        keys.push(toKeyAsString(key));
        return findByKey.call(this, key);
    });
    vi.spyOn(PSqlResourceInboxEntryReader.prototype, 'findByKeys').mockImplementation(function (
        this: PSqlResourceInboxEntryReader,
        requested: readonly Key[]
    ) {
        keys.push(...requested.map(toKeyAsString));
        return findByKeys.call(this, requested);
    });
    return () => keys;
}

/** Every statement the PGlite instance runs, outside a transaction and inside one, with each transaction counted once. */
function countPGliteStatements(raw: PSqlAdmissionTestStorage['sql']['raw']): () => PGliteStatementCounts {
    let autocommit = 0;
    let transactions = 0;
    let inTransaction = 0;
    const query = raw.query.bind(raw);
    const transaction = raw.transaction.bind(raw);
    vi.spyOn(raw, 'query').mockImplementation((...args: Parameters<typeof raw.query>) => {
        autocommit += 1;
        return query(...args);
    });
    vi.spyOn(raw, 'transaction').mockImplementation((callback) => {
        transactions += 1;
        return transaction((tx) => {
            const txQuery = tx.query.bind(tx);
            return callback(Object.assign(Object.create(tx), {
                query: (...args: Parameters<typeof tx.query>) => {
                    inTransaction += 1;
                    return txQuery(...args);
                }
            }));
        });
    });
    return () => ({ autocommit, transactions, inTransaction });
}

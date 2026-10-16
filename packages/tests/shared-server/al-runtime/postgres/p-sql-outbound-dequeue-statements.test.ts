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
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundMessageRuntime
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { toKeyAsString, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createOutboundMessage,
    createOutboundRuntimeWithWorkTask,
    OUTBOUND_TEST_SEND_PLANNER,
    runOutboundWorkTask
} from '../../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../../../shared/alm/outbound-test-payload.ts';
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
});

function createDequeueLane(storage: PSqlAdmissionTestStorage) {
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
            planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage);
                return { status: 'sent', submissionAttempted: true };
            }
        })
    );
    return { runtime, sent, outbox: stores.workQueue };
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

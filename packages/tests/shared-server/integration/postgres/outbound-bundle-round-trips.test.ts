import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const GROUP_SIZE = 16;
const SETTLE_POLL = { timeout: 20_000 };
const WS_SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const VERSION_TTL_MS = normalizeALRuntimeStoreRetention(undefined).versionTtlMs;

interface RecordedStatement {
    readonly transaction: number | null;
    readonly text: string;
    readonly values: readonly PSqlParameter[];
    readonly rowCount: number;
}

interface StatementLog {
    readonly statements: RecordedStatement[];
    transactions: number;
}

interface StoredStateRow {
    readonly store_key: string;
    readonly store_value: string;
    readonly revision: number | string;
}

interface StoredQueueRow {
    readonly ri_topic_id: string;
    readonly ri_status: string;
    readonly ri_attempts: number | string;
}

// A WS lane claims every WS_OUTBOX row of its database, so each test runs on the API schema of its own.
describe('Postgres outbound admission bundle', () => {
    postgresIt('commits a 16-row WS group in one statement per kind of write, with every row it wrote before', async () => {
        await withRunStorage(async ({ sql, runId }) => {
            const log: StatementLog = { statements: [], transactions: 0 };
            const lane = createWsDequeueLane(recordStatements(sql, log, null), runId);
            const proved = await writeProvedWsRows(lane, runId);
            const messages = proved.map(({ message }) => message);
            const committingFrom = Date.now();

            try {
                await lane.engine.executeOnce();
                await expect.poll(() => countSent(lane, messages), SETTLE_POLL).toBe(GROUP_SIZE);
                await expect.poll(() => readQueueRows(sql), SETTLE_POLL)
                    .toEqual(toExpectedQueueRows());
            }
            finally {
                await lane.dispose();
            }

            const committedBy = Date.now();
            expect(await readStateRows(sql, lane)).toEqual(toExpectedStateRows(lane, messages));
            for (const sent of await readSentRows(sql, lane)) {
                expect(sent).toMatchObject(toExpectedSentRow(lane, proved, sent));
            }
            const stateExpiries = await readStateExpiries(sql, lane);
            expect(new Set(stateExpiries).size).toBe(1);
            expect(stateExpiries[0]! - committingFrom).toBeGreaterThanOrEqual(VERSION_TTL_MS);
            expect(stateExpiries[0]! - committedBy).toBeLessThanOrEqual(VERSION_TTL_MS);
            expect(await readQueueExpiries(sql, proved)).toEqual(proved.map(toQueueExpiries));
            const commits = readVersionCommits(log, lane);
            expect(commits).toHaveLength(1);
            expect(commits[0]!.map(({ text, rowCount }) => [toStatementKind(text), rowCount])).toEqual([
                ['state', 2 * GROUP_SIZE + 1],
                ['hold', GROUP_SIZE],
                ['insert', 2 * GROUP_SIZE]
            ]);
        });
    }, 60_000);

    postgresIt('writes none of a commit whose sender version moved after the commit read it', async () => {
        await withRunStorage(async ({ sql, runId }) => {
            const namespace = `${runId}:fence`;
            const versionKey = `version:${runId}`;
            const backend = new PSqlAdmissionWorkBackend({ sql, namespace, nowMs: Date.now });
            await backend.write(async (write) => await write.setFence(versionKey, 0));
            const entry = createWorkEntry(runId);

            await expect(backend.write(async (write) => {
                await write.read(versionKey, (value) => value);
                await write.readWork(entry.key);
                // Another commit of the same sender lands between this commit's read and its write.
                await sql`
                    update runtime_state_store set revision = revision + 1
                    where store_namespace = ${namespace} and store_key = ${versionKey}
                `;
                await write.set(`effect:${runId}`, 'written');
                await write.setFence(versionKey, 1);
                write.writeWork(entry);
            })).rejects.toBeInstanceOf(ALAdmissionBackendConflictError);

            expect(await backend.read(versionKey, (value) => value)).toBe(0);
            expect(await backend.read(`effect:${runId}`, (value) => value)).toBeUndefined();
            expect(await backend.workQueue.getItem(entry.key)).toBeUndefined();
        });
    }, 60_000);

    postgresIt('fails a member whose message id another sender owns alone, and commits the others', async () => {
        await withRunStorage(async ({ sql, runId }) => {
            const lane = createWsDequeueLane(sql, runId);
            const messages = (await writeProvedWsRows(lane, runId)).map(({ message }) => message);
            const [corrupt, ...others] = messages;
            await lane.repository.upsert(
                lane.namespace,
                `${lane.namespace}:msg-owner:${corrupt!.id.msgId}`,
                JSON.stringify('intruder'),
                Date.now() + 60_000
            );

            try {
                await lane.engine.executeOnce();
                await expect.poll(() => countSent(lane, others), SETTLE_POLL).toBe(others.length);
            }
            finally {
                await lane.dispose();
            }

            expect(countSent(lane, [corrupt!])).toBe(0);
            const states = await readStateRows(sql, lane);
            expect(states.filter(({ key }) => key.startsWith('sent:'))).toHaveLength(others.length);
        });
    }, 60_000);
});

interface RunStorage {
    readonly sql: PSqlSql;
    readonly runId: string;
}

async function withRunStorage(run: (storage: RunStorage) => Promise<void>): Promise<void> {
    const storage = await createResourceInboxTestStorage('outbound_bundle', 4);
    try {
        await run({ sql: storage.sql, runId: crypto.randomUUID() });
    }
    finally {
        await storage.close();
    }
}

interface WsDequeueLane {
    readonly namespace: string;
    readonly senderId: string;
    readonly repository: PSqlRuntimeStateRepository;
    readonly workQueue: QueueBoxResourceEntryRepository;
    readonly engine: InboxOutboxEngine;
    readonly native: TestWebSocket;
    dispose(): Promise<void>;
}

function createWsDequeueLane(sql: PSqlSql, runId: string): WsDequeueLane {
    const repository = new PSqlRuntimeStateRepository(sql);
    const stores = createPSqlALOutboundRuntimeStores({
        repository,
        namespace: runId,
        nowMs: Date.now,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const proofs = new WsOutboxProvenanceReader({ repository, nowMs: Date.now });
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://peer');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        inboundVolatileStores: undefined,
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        dequeueTiming: undefined,
        targetResolver: { resolveBroadcastRecipients: () => [{ peerId: 'peer', connectionId: 'peer' }] },
        readAuthenticatedConnectionScope: () => ({ scope: WS_SCOPE, expiresAtEpochMs: Date.now() + 30_000 }),
        readProducerProvenance: (message, entry) => proofs.readProducerProvenance(message, entry)
    });
    return {
        namespace: `${runId}:outbound:admission`,
        senderId: `server-${runId}`,
        repository,
        workQueue: stores.workQueue,
        engine,
        native,
        dispose: async () => {
            await Promise.all([service.dispose(), engine.stop()]);
        }
    };
}

/** Raw WS rows of one sender to one connected peer, each with the producer proof its dequeue verifies. */
async function writeProvedWsRows(lane: WsDequeueLane, runId: string): Promise<ProvedWsRow[]> {
    const rows: ProvedWsRow[] = [];
    for (let index = 0; index < GROUP_SIZE; index += 1) {
        const message = newALUnicastMessage(
            lane.senderId,
            { topicId: 'snapshot', resourceId: `page-${index}`, contextId: runId },
            'peer',
            'snapshot.v1',
            {},
            { ttlMs: 30_000, qos: { durability: { algo: 'local-outbox' } } }
        );
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        const facts: Omit<WsOutboxProvenance, 'digest'> = {
            version: 1,
            producerKind: 'state-sync',
            queueKey: entry.key,
            typeId: entry.typeId,
            messageId: message.id.msgId,
            senderId: message.id.senderId,
            expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
            target: { kind: 'scoped-unicast', peerId: 'peer', scope: WS_SCOPE, admittedAudience: ['peer'] }
        };
        const proof = { ...facts, digest: computeWsOutboxProvenanceDigest(entry, facts) };
        await lane.repository.upsert(
            WS_OUTBOX_PROVENANCE_NAMESPACE,
            toWsOutboxProvenanceKey(entry.key),
            JSON.stringify(proof),
            proof.expiresAtMs
        );
        await lane.workQueue.enqueue(entry);
        rows.push({ message, entry });
    }
    return rows;
}

interface ProvedWsRow {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
}

interface StateRowSummary {
    readonly key: string;
    readonly value: string | undefined;
    readonly revision: number;
}

interface StoredExpiryRow {
    readonly expire_at: string;
}

interface StoredQueueExpiryRow {
    readonly ri_resource: string;
    readonly expire_ts: string;
}

function countSent(lane: WsDequeueLane, messages: readonly ALMessage[]): number {
    const frames = lane.native.sent.map((frame) => JSON.stringify(frame));
    return messages.filter((message) => frames.some((frame) => frame.includes(message.id.msgId))).length;
}

/** The state rows of the lane's namespace, its prefix dropped; every row but a sent row with its stored value. */
async function readStateRows(sql: PSqlSql, lane: WsDequeueLane): Promise<readonly StateRowSummary[]> {
    const rows = await sql<StoredStateRow[]>`
        select store_key, store_value, revision from runtime_state_store
        where store_namespace = ${lane.namespace}
        order by store_key collate "C"
    `;
    return rows.map((row) => {
        const key = row.store_key.slice(lane.namespace.length + 1);
        return {
            key,
            value: key.startsWith('sent:') ? undefined : row.store_value,
            revision: Number(row.revision)
        };
    });
}

/** The parent wrote an owner and a sent row per message and the sender version, each one insert at revision 0. */
function toExpectedStateRows(lane: WsDequeueLane, messages: readonly ALMessage[]): readonly StateRowSummary[] {
    return [
        ...messages.map((message) => ({
            key: `msg-owner:${message.id.msgId}`,
            value: JSON.stringify(lane.senderId),
            revision: 0
        })),
        ...messages.map((message) => ({ key: `sent:${message.id.msgId}`, value: undefined, revision: 0 })),
        { key: `version:${lane.senderId}`, value: JSON.stringify({ senderId: lane.senderId, version: 1 }), revision: 0 }
    ].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/** Each sent row's stored value, decoded. */
async function readSentRows(sql: PSqlSql, lane: WsDequeueLane): Promise<readonly object[]> {
    const rows = await sql<StoredStateRow[]>`
        select store_key, store_value, revision from runtime_state_store
        where store_namespace = ${lane.namespace} and store_key like ${`${lane.namespace}:sent:%`}
    `;
    expect(rows).toHaveLength(GROUP_SIZE);
    return rows.map((row) => JSON.parse(row.store_value) as object);
}

/** What the parent stored for a sent message: its WS row as the reference, and the policy it was admitted under. */
function toExpectedSentRow(lane: WsDequeueLane, proved: readonly ProvedWsRow[], sent: object): object {
    const row = proved.find(({ message }) => JSON.stringify(sent).includes(message.id.msgId))!;
    return {
        msgId: row.message.id.msgId,
        reference: {
            key: row.entry.key,
            typeId: 'WS_OUTBOX',
            scope: lane.namespace,
            msgId: row.message.id.msgId,
            senderId: lane.senderId,
            expiresAtMs: row.entry.audit.expiryTs.epochMilliseconds
        },
        unicastPeerId: 'peer',
        policy: { admittedAudience: ['peer'], recipientScope: WS_SCOPE }
    };
}

async function readStateExpiries(sql: PSqlSql, lane: WsDequeueLane): Promise<readonly number[]> {
    const rows = await sql<StoredExpiryRow[]>`
        select to_char(expire_at_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expire_at
        from runtime_state_store
        where store_namespace = ${lane.namespace}
    `;
    return rows.map((row) => Date.parse(row.expire_at));
}

/** Per message, in the order given, the expiry of each of its queue rows. */
async function readQueueExpiries(sql: PSqlSql, proved: readonly ProvedWsRow[]): Promise<readonly number[][]> {
    const rows = await sql<StoredQueueExpiryRow[]>`
        select ri_resource, to_char(expire_ts, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expire_ts from resource_inbox
    `;
    return proved.map(({ message }) => rows.filter((row) => row.ri_resource.includes(message.id.msgId)).map((row) => Date.parse(row.expire_ts)));
}

/** The parent wrote each message's identity and own-work rows to expire with the WS row they admit. */
function toQueueExpiries({ entry }: ProvedWsRow): number[] {
    return Array.from({ length: 3 }, () => entry.audit.expiryTs.epochMilliseconds);
}

/** Each queue row as its topic, status and attempts. */
async function readQueueRows(sql: PSqlSql): Promise<readonly string[]> {
    const rows = await sql<StoredQueueRow[]>`select ri_topic_id, ri_status, ri_attempts from resource_inbox`;
    return rows.map((row) => `${row.ri_topic_id}:${row.ri_status}:${Number(row.ri_attempts)}`).sort();
}

/**
 * Where the parent's lane settles: per message a completed identity row and a completed own-work row, both
 * written by the bundle, and the claimed row itself completed by its release.
 */
function toExpectedQueueRows(): readonly string[] {
    return [
        ...Array.from({ length: GROUP_SIZE }, () => `AL_OUTBOUND:${EntityStatus.COMPLETED}:1`),
        ...Array.from({ length: GROUP_SIZE }, () => `AL_OUTBOUND_IDENTITY:${EntityStatus.COMPLETED}:0`),
        ...Array.from({ length: GROUP_SIZE }, () => `snapshot:${EntityStatus.COMPLETED}:1`)
    ].sort();
}

/** The statements of every transaction that wrote the run's sender version, one list per transaction. */
function readVersionCommits(log: StatementLog, lane: WsDequeueLane): readonly (readonly RecordedStatement[])[] {
    const versionKey = `${lane.namespace}:version:${lane.senderId}`;
    const transactions = new Set(
        log.statements
            .filter(({ transaction, text, values }) =>
                transaction !== null && text.includes('runtime_state_store') &&
                JSON.stringify(values).includes(versionKey)
            )
            .map(({ transaction }) => transaction)
    );
    return [...transactions].map((opened) => log.statements.filter(({ transaction }) => transaction === opened));
}

function createWorkEntry(runId: string): ResourceEntry {
    return {
        key: { topicId: 'alm-work', resourceId: 'fenced', contextId: runId },
        typeId: 'alm-work',
        resource: 'computed message',
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-09-06T12:00:00'),
            expiryTs: Temporal.Instant.from('2099-01-01T00:00:00Z')
        },
        dequeueAudit: { attempts: 0 }
    };
}

function toStatementKind(text: string): string {
    if (text.includes('runtime_state_store')) {
        return 'state';
    }
    return text.startsWith('insert into resource_inbox') ? 'insert' : text.includes('for update') ? 'hold' : text;
}

/** Records every template statement with its values, its row count and the transaction it ran in. */
function recordStatements(source: PSqlSql, log: StatementLog, transaction: number | null): PSqlSql {
    function recording<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function recording(values: readonly PSqlParameter[]): object;
    function recording<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return source(stringsOrValues as readonly PSqlParameter[]);
        }
        const strings = stringsOrValues as TemplateStringsArray;
        const text = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
        return source<Result>(strings, ...values).then((rows) => {
            log.statements.push({ transaction, text, values, rowCount: Array.isArray(rows) ? rows.length : 0 });
            return rows;
        });
    }
    return Object.assign(recording, {
        begin: async <T>(write: (inner: PSqlSql) => Promise<T>): Promise<T> => {
            log.transactions += 1;
            const opened = log.transactions;
            return await source.begin(async (inner) => await write(recordStatements(inner, log, opened)));
        }
    });
}

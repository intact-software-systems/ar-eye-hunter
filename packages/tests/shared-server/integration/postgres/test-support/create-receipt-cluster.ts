import { expect, onTestFinished } from 'vitest';

import { createPSqlALReceiptRecordStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts';
import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { toALReceiptRecordHeadKey, type ALReceiptRecordRef } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import type { ALReceiptRecordEndedHead } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { toALReceiptRecordWorkKey } from '@shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerReceiptObservation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';

import type { SimulatedWebSocket } from '../../../../shared/native-websocket-fixture.ts';
import {
    createBridgeBus,
    createClusterInstance,
    RECEIPT_SERVER_PEER_ID,
    type ClusterInstance
} from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type TerminablePostgresSql
} from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { deletePostgresRunRows, NO_POSTGRES_RUN_ROWS, readPostgresRunRowCounts } from './delete-postgres-run-rows.ts';
import type { WorkerHold } from './postgres-worker-hold.ts';
import { awaitHoldArrival } from './race-past-held-commit.ts';
import { recordPostgresStatements, type PostgresStatementLog } from './record-postgres-statements.ts';

export const POLL = { timeout: 20_000 } as const;

type AckCountObservation = Extract<WsQueueBoxServerReceiptObservation, { readonly kind: 'ack-count'; }>;

/** One run: its rows carry `runId`, its instances share one store id, one bus and the test's own reader of the record. */
export interface ReceiptCluster {
    readonly runId: string;
    readonly storeId: string;
    readonly clients: TerminablePostgresSql[];
    readonly bus: ReturnType<typeof createBridgeBus>;
    readonly originSockets: SimulatedWebSocket[];
    /** What every instance's receipt observer recorded. */
    readonly observations: WsQueueBoxServerReceiptObservation[];
    /** Reads the record every instance writes, through a client no instance uses. */
    readonly reader: ALReceiptRecord;
    /** The record's work queue, read through the reader's client. */
    readonly readerWorkQueue: QueueBoxResourceEntryRepository;
    readonly recordNamespace: string;
}

interface StartInstanceInput {
    /** The instance's cluster publisher id. */
    readonly name: string;
    readonly roomPeerIds: readonly string[];
    /** When set, the record's stores sit on a client of their own, wrapped by this (a hold on its transactions). */
    readonly toRecordSql: ((client: PSqlSql) => PSqlSql) | undefined;
    /** When set, every statement of the instance's one client is recorded here. */
    readonly log: PostgresStatementLog | undefined;
    readonly starts: boolean;
}

export interface ReceiptInstance extends ClusterInstance {
    /** The client the instance's record stores use: its own when they are wrapped, else the instance's one client. */
    readonly recordClient: TerminablePostgresSql;
}

/** Starts one `acceptIncomingMessage` on an instance. */
export type StartAcceptance = () => ReturnType<ClusterInstance['service']['acceptIncomingMessage']>;

type StoredEnd = Pick<ALReceiptRecordEndedHead, 'phase' | 'confirmedRecipientPeerIds' | 'outsideAudienceRecipientPeerIds'>;

/** The run's cleanup is registered first, so it runs after every instance's own disposal. */
export async function createReceiptCluster(): Promise<ReceiptCluster> {
    const runId = crypto.randomUUID();
    const clients: TerminablePostgresSql[] = [];
    onTestFinished(async () => await closeReceiptCluster(runId, clients));
    const storeId = `ws-receipt-cluster-${runId}`;
    const readerClient = await openClient(clients);
    const { backend, namespace } = createPSqlALReceiptRecordStores({
        repository: new PSqlRuntimeStateRepository(readerClient),
        namespace: storeId,
        nowMs: Date.now
    });
    return {
        runId,
        storeId,
        clients,
        bus: createBridgeBus(),
        originSockets: [],
        observations: [],
        reader: new ALReceiptRecord({ backend, namespace, nowMs: Date.now }),
        readerWorkQueue: backend.workQueue,
        recordNamespace: namespace
    };
}

/**
 * Deletes the run's rows before asserting none remain, then ends every client whatever happened; the first client
 * is the reader's, which no instance uses.
 */
async function closeReceiptCluster(runId: string, clients: readonly TerminablePostgresSql[]): Promise<void> {
    try {
        const [reader] = clients;
        if (reader !== undefined) {
            const deletes = await Promise.allSettled([deletePostgresRunRows(reader, runId)]);
            expect(deletes.filter(({ status }) => status === 'rejected')).toEqual([]);
            expect(await readPostgresRunRowCounts(reader, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
        }
    }
    finally {
        await Promise.allSettled(clients.map(async (client) => await client.end()));
    }
}

async function openClient(clients: TerminablePostgresSql[]): Promise<TerminablePostgresSql> {
    const client = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 10);
    clients.push(client);
    return client;
}

export function instanceInput(name: string, roomPeerIds: readonly string[]): StartInstanceInput {
    return { name, roomPeerIds, toRecordSql: undefined, log: undefined, starts: true };
}

/**
 * Every instance shares the run's store id for its inbound, outbound and record stores, and the server's name, as
 * api-v1's instances share `wsRuntimeName`: an ended receipt's repeat is the outbound owner's duplicate only then.
 */
export async function startInstance(cluster: ReceiptCluster, input: StartInstanceInput): Promise<ReceiptInstance> {
    const client = await openClient(cluster.clients);
    const sql: PSqlSql = input.log === undefined ? client : recordPostgresStatements(client, input.log, null);
    const recordClient = input.toRecordSql === undefined ? client : await openClient(cluster.clients);
    const recordSql = input.toRecordSql === undefined ? sql : input.toRecordSql(recordClient);
    const repository = new PSqlRuntimeStateRepository(sql);
    const receiptRecordStores = createPSqlALReceiptRecordStores({
        repository: new PSqlRuntimeStateRepository(recordSql),
        namespace: cluster.storeId,
        nowMs: Date.now
    });
    expect(receiptRecordStores.namespace).toBe(cluster.recordNamespace);
    const instance = await createClusterInstance({
        name: RECEIPT_SERVER_PEER_ID,
        outboundStores: createDefaultPSqlALOutboundRuntimeStores({
            repository,
            namespace: cluster.storeId,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        }),
        inboundStores: createDefaultPSqlALInboundRuntimeStores({ repository, namespace: cluster.storeId }),
        inboundVolatileStores: undefined,
        receiptRecordStores,
        receiptObserver: (observation) => cluster.observations.push(observation),
        roomView: { inSync: true },
        bus: cluster.bus,
        publisherId: `${input.name}-${cluster.runId}`,
        engine: new InboxOutboxEngine(),
        roomPeerIds: input.roomPeerIds
    });
    if (input.starts) {
        instance.engine.start();
    }
    return { ...instance, recordClient };
}

/** An instance lost as a process is: its service disposed and its engine stopped, its sockets left as they were. */
export async function loseInstance(instance: ClusterInstance): Promise<void> {
    await instance.service.dispose();
    await instance.engine.stop();
}

interface HeldCount {
    readonly hold: WorkerHold;
    readonly count: StartAcceptance;
}

/**
 * Starts every count and waits until each has reached its hold, then releases them all together. Every count is
 * settled before this returns or throws, so none still runs while the case's cleanup deletes its rows.
 */
export async function countTogether(counts: readonly HeldCount[]): Promise<Awaited<ReturnType<StartAcceptance>>[]> {
    const counting = counts.map(({ count }) => count());
    try {
        await Promise.all(counts.map(async ({ hold }, index) => await awaitHoldArrival(hold, counting[index]!)));
    }
    finally {
        counts.forEach(({ hold }) => hold.release());
        await Promise.allSettled(counting);
    }
    return await Promise.all(counting);
}

/** The stored head's terminal phase and sets, and its ended work row delivered. */
export async function expectStoredEnd(cluster: ReceiptCluster, ref: ALReceiptRecordRef, ended: StoredEnd): Promise<void> {
    expect((await cluster.reader.read(ref)).right?.head).toMatchObject(ended);
    const endedWork = toALReceiptRecordWorkKey(cluster.recordNamespace, 'ended', ref);
    await expect.poll(async () => (await cluster.readerWorkQueue.getItem(endedWork))?.status, POLL).toBe(EntityStatus.COMPLETED);
}

/** The outcome of each count the instances observed for the message's ACKs. */
export function readCountOutcomes(cluster: ReceiptCluster, msgId: string): readonly AckCountObservation['outcome'][] {
    return cluster.observations.flatMap((observation) => observation.kind === 'ack-count' && observation.ack.ackedMsgId === msgId ? [observation.outcome] : []);
}

/** Batches that run after an operation answers have settled once a quarter second passes without a statement. */
export async function waitForQuietStatements(log: PostgresStatementLog): Promise<void> {
    let seen = -1;
    await expect.poll(() => {
        const quiet = log.statements.length === seen;
        seen = log.statements.length;
        return quiet;
    }, { ...POLL, interval: 250 }).toBe(true);
}

export async function readHeadCount(cluster: ReceiptCluster, ref: ALReceiptRecordRef): Promise<number> {
    const [reader] = cluster.clients;
    const rows = await reader!<Array<{ readonly count: number; }>>`
        select count(*)::int as count from runtime_state_store
        where store_namespace = ${cluster.recordNamespace}
            and store_key = ${toALReceiptRecordHeadKey(cluster.recordNamespace, ref)}
    `;
    return rows[0]?.count ?? 0;
}

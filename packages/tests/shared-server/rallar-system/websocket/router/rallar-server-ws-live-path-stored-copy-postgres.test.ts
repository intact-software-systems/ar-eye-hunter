// Ruling M1 cited below is the maintainer's ruling on R16 of plans/active/alm-v1-production-readiness.md (a room copy
// missed on the default fan-out).
import { describe, expect, it } from 'vitest';

import { createPSqlALReceiptRecordStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts';
import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores,
    createPSqlALInboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS } from '@shared/alm/ALStoreRetention.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';

import { createBridgeBus } from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import { createReceiptCluster, POLL, type ReceiptCluster } from '../../../integration/postgres/test-support/create-receipt-cluster.ts';
import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    connectLiveRoomSession,
    createLiveRoomInstance,
    createLiveRoomSend,
    LIVE_ROOM_ORIGIN,
    LIVE_ROOM_SESSION_IDS,
    readLiveRoomStoredCopies,
    type LiveRoomInstance,
    type LiveRoomInstanceStores,
    type LiveRoomStoredCopy
} from './live-room-cluster-fixture.ts';
import { createRecordingLiveWsPublication } from './recording-live-ws-publication.ts';

/** Long enough for the engine to hand both sends on in real time; the reads judge the deadline on their own clock. */
const LIFETIME_MS = 60_000;
const CASE_TIMEOUT_MS = 60_000;

describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('the server\'s PostgreSQL inbound store keeps a live-path room send for its repair', () => {
    // Pins a change to the inbound store's retention on PostgreSQL that leaves a live-path send with no envelope or
    // audience another instance can read before its deadline: the resend of ruling M1 would then send nothing.
    it('keeps a handed-on send\'s envelope and admitted audience readable through another client until its deadline', async () => {
        const run = await createReceiptCluster();
        const instance = await startPostgresLiveRoomInstance(run);
        await connectLiveRoomSession(instance, LIVE_ROOM_ORIGIN, undefined);
        await connectLiveRoomSession(instance, 'r1', undefined);
        const sentAtMs = Date.now();
        const receipted = createLiveRoomSend({ msgId: `m-1-${run.runId}`, nowMs: sentAtMs, lifetimeMs: LIFETIME_MS });
        const unreceipted: ALMessage = {
            ...createLiveRoomSend({ msgId: `m-2-${run.runId}`, nowMs: sentAtMs, lifetimeMs: LIFETIME_MS }),
            delivery: { reliability: 'at-least-once', ack: 'none' }
        };
        const sends = [receipted, unreceipted];
        const deadlineMs = sentAtMs + LIFETIME_MS;

        for (const message of sends) {
            expect((await instance.service.acceptIncomingMessage(message, LIVE_ROOM_ORIGIN)).right).toEqual({ kind: 'admitted' });
        }
        // Two rows admitted a moment apart may be claimed in either order: the subject is the store, not the claim order.
        await expect.poll(() => [...instance.handledMsgIds].sort(), POLL).toEqual(sends.map((message) => message.id.msgId).sort());

        const kept = sends.map((envelope) => ({ envelope, sourceAudience: LIVE_ROOM_SESSION_IDS, ingressAudience: LIVE_ROOM_SESSION_IDS }));
        expect(await readStoredCopiesAt(run, sends, Date.now())).toEqual(kept);
        expect(await readStoredCopiesAt(run, sends, deadlineMs - 1)).toEqual(kept);
        expect((await readStoredCopiesAt(run, sends, deadlineMs)).map(({ envelope }) => envelope)).toEqual([undefined, undefined]);
    }, CASE_TIMEOUT_MS);
});

/** One instance on a client of its own, over the run's store id, its engine started; the run's cleanup deletes its rows. */
async function startPostgresLiveRoomInstance(run: ReceiptCluster): Promise<LiveRoomInstance> {
    const client = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 10);
    run.clients.push(client);
    const repository = new PSqlRuntimeStateRepository(client);
    const stores: LiveRoomInstanceStores = {
        inboundStores: createDefaultPSqlALInboundRuntimeStores({ repository, namespace: run.storeId }),
        receiptRecordStores: createPSqlALReceiptRecordStores({ repository, namespace: run.storeId, nowMs: Date.now }),
        outboundStores: createDefaultPSqlALOutboundRuntimeStores({ repository, namespace: run.storeId, decodePrepared: decodeWsQueueBoxServerPreparedMessage }),
        volatileStores: undefined
    };
    const instance = await createLiveRoomInstance({
        publisherId: `a-${run.runId}`,
        nowMs: Date.now,
        stores,
        noticeTransport: createRecordingLiveWsPublication().livePublication.transport,
        bridge: createBridgeBus(),
        roomSessionIds: LIVE_ROOM_SESSION_IDS
    });
    instance.engine.start();
    return instance;
}

/** Each send as another instance reads it at `readAtMs`: a store object of its own, on the run's reader client. */
async function readStoredCopiesAt(run: ReceiptCluster, sends: readonly ALMessage[], readAtMs: number): Promise<readonly LiveRoomStoredCopy[]> {
    const store = createPSqlALInboundRuntimeStores({
        repository: new PSqlRuntimeStateRepository(run.readerClient),
        namespace: run.storeId,
        nowMs: () => readAtMs,
        // Neither read under test depends on a track's lifetime.
        orderingTrackTtlMs: DEFAULT_AL_REPOSITORY_TTL_MS,
        supersedenceTrackTtlMs: DEFAULT_AL_REPOSITORY_TTL_MS,
        retention: undefined
    }).admissionStore;
    return await readLiveRoomStoredCopies(store, sends, readAtMs);
}

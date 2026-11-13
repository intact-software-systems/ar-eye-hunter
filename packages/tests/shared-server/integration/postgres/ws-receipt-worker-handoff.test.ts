import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createDefaultPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';

import {
    connect,
    countCopies,
    createBridgeBus,
    createClusterInstance,
    installClock,
    readSentReceipts,
    receiverAck,
    roomMessage,
    runReceiptWorkerHandoff
} from '../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

interface ReceiptStorageCleanup {
    readonly sql: PostgresSql;
    readonly namespace: string;
    readonly nowMs: number;
}

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const RECEIVER_PEER_IDS = Array.from({ length: 14 }, (_unused, index) => `receiver-${String(index + 1).padStart(2, '0')}`);

afterEach(() => vi.restoreAllMocks());

postgresIt('delivers an admitted receipt across separate Postgres stores when A dequeues and B sends', async () => {
    const clock = installClock();
    const namespace = `receipt-worker-handoff:${crypto.randomUUID()}`;
    const first = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await cleanupReceiptStorage({ sql: first, namespace: `${namespace}:outbound:admission`, nowMs: clock.nowMs });
        }
        finally {
            await first.end();
        }
    });
    const second = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => second.end());
    const options = { namespace, decodePrepared: decodeWsQueueBoxServerPreparedMessage };
    const storesA = createDefaultPSqlALOutboundRuntimeStores({ ...options, repository: new PSqlRuntimeStateRepository(first) });
    const storesB = createDefaultPSqlALOutboundRuntimeStores({ ...options, repository: new PSqlRuntimeStateRepository(second) });

    const result = await runReceiptWorkerHandoff({ storesA, storesB, nowMs: clock.nowMs });

    expect(result.wrongFrames).toEqual([]);
    expect(result.receipts, JSON.stringify(result.claims)).toEqual([expect.objectContaining({
        msgId: 'room-message-1',
        originPeerId: 'a',
        phase: 'admitted',
        expectedRecipientPeerIds: ['b', 'c'],
        confirmedRecipientPeerIds: [],
        snapshotVersion: 7
    })]);
});

postgresIt('completes one receipt naming all fourteen receivers once the last held ACK is released', async () => {
    const namespace = `receipt-fourteen-receivers:${crypto.randomUUID()}`;
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    const sentAtMs = Date.now();
    onTestFinished(async () => {
        try {
            await cleanupReceiptStorage({ sql, namespace: `${namespace}:outbound:admission`, nowMs: sentAtMs });
        }
        finally {
            await sql.end();
        }
    });
    const outboundStores = createDefaultPSqlALOutboundRuntimeStores({
        namespace,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        repository: new PSqlRuntimeStateRepository(sql)
    });
    const instance = await createClusterInstance({
        name: 'server',
        outboundStores,
        bus: createBridgeBus(),
        publisherId: 'local',
        engine: new InboxOutboxEngine(),
        roomPeerIds: ['a', ...RECEIVER_PEER_IDS]
    });
    instance.engine.start();
    const origin = await connect(instance, 'a');
    const receivers = await Promise.all(RECEIVER_PEER_IDS.map(async (peerId) => await connect(instance, peerId)));
    const subjectReceipts = () => readSentReceipts(origin).filter((receipt) => receipt.msgId === 'room-message-1');
    const promptReceiverPeerIds = RECEIVER_PEER_IDS.slice(0, -1);
    const heldReceiverPeerId = RECEIVER_PEER_IDS.at(-1)!;

    expect((await instance.service.acceptIncomingMessage(roomMessage(sentAtMs), 'a')).right?.kind).toBe('admitted');
    await expect.poll(() => receivers.map((socket) => countCopies(socket, 'room-message-1'))).toEqual(RECEIVER_PEER_IDS.map(() => 1));
    await expect.poll(() => subjectReceipts().map((receipt) => receipt.phase)).toEqual(['admitted']);
    for (const peerId of promptReceiverPeerIds) {
        await instance.service.acceptIncomingMessage(receiverAck(peerId, Date.now()), peerId);
    }
    expect(subjectReceipts().map((receipt) => receipt.phase)).toEqual(['admitted']);
    await instance.service.acceptIncomingMessage(receiverAck(heldReceiverPeerId, Date.now()), heldReceiverPeerId);
    await expect.poll(() => subjectReceipts().some((receipt) => receipt.phase === 'complete')).toBe(true);

    const completed = subjectReceipts().filter((receipt) => receipt.phase === 'complete');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ originPeerId: 'a', outsideAudienceRecipientPeerIds: [] });
    expect([...completed[0]!.expectedRecipientPeerIds].sort()).toEqual(RECEIVER_PEER_IDS);
    expect([...completed[0]!.confirmedRecipientPeerIds].sort()).toEqual(RECEIVER_PEER_IDS);
    expect(subjectReceipts().map((receipt) => receipt.phase)).not.toContain('timed-out');
});

/** Deletes only this unique namespace's work, canonical message/identity range and metadata. */
async function cleanupReceiptStorage(input: ReceiptStorageCleanup): Promise<void> {
    const { sql, namespace } = input;
    const canonical = toALOutboundCanonicalKey(namespace, roomMessage(input.nowMs));
    const work = toALOutboundWorkKey(namespace, 'any-effect');
    await sql`
        delete from resource_inbox
        where (ri_topic_id in ('AL_OUTBOUND_MESSAGE', 'AL_OUTBOUND_IDENTITY') and ri_resource_id = ${canonical.resourceId})
            or (ri_topic_id = ${work.topicId} and ri_resource_id = ${work.resourceId})
    `;
    await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
}

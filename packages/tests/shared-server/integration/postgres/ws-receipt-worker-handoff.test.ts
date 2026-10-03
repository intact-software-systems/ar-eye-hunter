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
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';

import {
    installClock,
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

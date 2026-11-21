import { onTestFinished } from 'vitest';

import { createDefaultPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RelayedAckNotice } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';

import { createDefaultApiV1DatabaseLifecycle } from '../../../../../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';
import { createApiV1RelayedAckNotices } from '../../../../../../apps/api-v1/src/db/create-postgres-relayed-ack-notice-transport.ts';
import {
    createRelayedAckMiddlewareInstance,
    type RelayedAckMiddlewareInstance,
    type RelayedAckMiddlewareInstanceInput
} from '../../../rallar-system/middleware/relayed-ack-middleware-fixture.ts';
import { requirePostgresDatabaseUrl } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

export interface PostgresWsReplicaInput {
    /** The inbound admission namespace every replica of one run shares; its rows are deleted when the test ends. */
    readonly inboundNamespace: string;
    readonly publisherId: string;
    readonly sessionIds: readonly string[];
    readonly roomView: RelayedAckMiddlewareInstanceInput['roomView'];
    readonly roomAudiencePeerIds: readonly string[];
    /** Every ACK notice any replica of the run publishes, recorded before it reaches PostgreSQL. */
    readonly relayedAcks: RelayedAckNotice[];
}

/** One API replica: its own application and listener pools, the shared inbound namespace, the NOTIFY relay. */
export async function createPostgresWsReplica(input: PostgresWsReplicaInput): Promise<RelayedAckMiddlewareInstance> {
    const lifecycle = await createDefaultApiV1DatabaseLifecycle({
        database: {
            mode: 'postgres',
            url: requirePostgresDatabaseUrl(),
            schemaInitialization: 'disabled',
            pubSub: 'postgres',
            applicationPool: { maxConnections: 4, idleTimeoutSeconds: 1 },
            listenerPool: { maxConnections: 1, idleTimeoutSeconds: 0 }
        },
        pgliteEvidence: { mode: 'disabled', pollIntervalMs: 1_000 },
        statementCensus: undefined
    });
    onTestFinished(async () => {
        try {
            await deleteInboundAdmissionRows(lifecycle.database, input.inboundNamespace);
        }
        finally {
            await lifecycle.close();
        }
    });
    const relayedAckNotices = createApiV1RelayedAckNotices({
        mode: 'postgres',
        notification: lifecycle.notification,
        publisherId: input.publisherId
    });
    if (relayedAckNotices === undefined) {
        throw new Error('PostgreSQL pub/sub must relay acknowledgement notices');
    }
    const { transport } = relayedAckNotices;
    return await createRelayedAckMiddlewareInstance({
        relayedAckNotices: {
            ...relayedAckNotices,
            transport: {
                publish: async (notice) => {
                    input.relayedAcks.push(notice);
                    await transport.publish(notice);
                },
                subscribe: (channel, onNotice) => transport.subscribe(channel, onNotice)
            }
        },
        inboundStores: createDefaultPSqlALInboundRuntimeStores({
            namespace: input.inboundNamespace,
            repository: new PSqlRuntimeStateRepository(lifecycle.database)
        }),
        sessionIds: input.sessionIds,
        roomAudiencePeerIds: input.roomAudiencePeerIds,
        roomView: input.roomView
    });
}

/** Deletes only this run's inbound admission namespace: its state rows and its work rows. */
async function deleteInboundAdmissionRows(sql: PSqlSql, inboundNamespace: string): Promise<void> {
    const namespace = `${inboundNamespace}:inbound:admission`;
    const work = toALInboundWorkKey(namespace, 'any-effect');
    await sql`delete from resource_inbox where ri_topic_id = ${work.topicId} and ri_resource_id = ${work.resourceId}`;
    await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
}

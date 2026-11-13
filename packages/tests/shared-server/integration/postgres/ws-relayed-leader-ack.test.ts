import { describe, expect, it, onTestFinished } from 'vitest';

import { createDefaultPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RelayedAckNotice } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';

import { createDefaultApiV1DatabaseLifecycle } from '../../../../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';
import { createApiV1RelayedAckNotices } from '../../../../../apps/api-v1/src/db/create-postgres-relayed-ack-notice-transport.ts';
import {
    createRelayedAckMiddlewareInstance,
    readReceiptPhases,
    readSentReceipts,
    toRelayedAckMessage,
    toRelayedAckRoomMessage,
    type RelayedAckMiddlewareInstance
} from '../../rallar-system/middleware/relayed-ack-middleware-fixture.ts';
import { requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const SENDER = 'player';
const LEADER = 'director';
const TRACE_ID = 'trace-ws-relayed-leader-ack';
/** The wait the ALM scale recipe gives a shot's receipt read. */
const SHOT_RECEIPT_WAIT_MS = 5_000;

interface PostgresReplicaInput {
    readonly runId: string;
    readonly publisherId: string;
    readonly sessionIds: readonly string[];
    /** Every ACK notice any replica of the run publishes, recorded before it reaches PostgreSQL. */
    readonly relayedAcks: RelayedAckNotice[];
}

/**
 * The hosted ALM scale shape: a player's `group-leader` shot carried over WS, admitted by the API replica the
 * player is connected to, and acknowledged by the director over WS. Each replica owns its own PostgreSQL pools,
 * shares the inbound admission namespace as the API replicas do, and relays ACKs over PostgreSQL NOTIFY.
 */
describe('Postgres WS group-leader ACK relay', () => {
    postgresIt('completes the shot receipt when the director acknowledges on the sender instance', async () => {
        const runId = crypto.randomUUID();
        const relayedAcks: RelayedAckNotice[] = [];
        const only = await createPostgresReplica({
            runId,
            publisherId: `replica-1-${runId}`,
            sessionIds: [SENDER, LEADER],
            relayedAcks
        });

        const shot = await sendShotAndAcknowledge({ runId, senderReplica: only, leaderReplica: only });

        expect(relayedAcks).toEqual([]);
        expect(shot.receiptPhases).toEqual(['admitted', 'complete']);
    });

    postgresIt('completes the shot receipt when the director acknowledges on another instance', async () => {
        const runId = crypto.randomUUID();
        const relayedAcks: RelayedAckNotice[] = [];
        const replica = (index: number, sessionIds: readonly string[]) =>
            createPostgresReplica({ runId, publisherId: `replica-${index}-${runId}`, sessionIds, relayedAcks });
        const senderReplica = await replica(1, [SENDER]);
        const leaderReplica = await replica(2, [LEADER]);
        await replica(3, []);

        const shot = await sendShotAndAcknowledge({ runId, senderReplica, leaderReplica });

        expect(shot.ackAcceptance).toEqual({ kind: 'control', handled: false });
        expect(relayedAcks.map((notice) => notice.publisherId)).toEqual([`replica-2-${runId}`]);
        expect(shot.receiptPhases).toEqual(['admitted', 'complete']);
        const complete = readSentReceipts(senderReplica.sockets[SENDER]!, toShotMsgId(runId)).at(-1);
        expect(complete).toMatchObject({ expectedRecipientPeerIds: [LEADER], confirmedRecipientPeerIds: [LEADER] });
    });
});

interface ShotInput {
    readonly runId: string;
    readonly senderReplica: RelayedAckMiddlewareInstance;
    readonly leaderReplica: RelayedAckMiddlewareInstance;
}

interface ShotOutcome {
    readonly ackAcceptance: ALInboundMessageRuntime.Acceptance | undefined;
    readonly receiptPhases: readonly string[];
}

async function sendShotAndAcknowledge(input: ShotInput): Promise<ShotOutcome> {
    const msgId = toShotMsgId(input.runId);
    const sender = input.senderReplica.sockets[SENDER]!;
    const shot = toRelayedAckRoomMessage({ msgId, senderId: SENDER, ack: 'group-leader', traceId: TRACE_ID });
    expect((await input.senderReplica.service.acceptIncomingMessage(shot, SENDER)).right?.kind).toBe('admitted');
    await expect.poll(() => readReceiptPhases(sender, msgId)).toEqual(['admitted']);

    const accepted = await input.leaderReplica.service.acceptIncomingMessage(
        toRelayedAckMessage({ ackedMsgId: msgId, fromPeerId: LEADER, originPeerId: SENDER, traceId: TRACE_ID }),
        LEADER
    );

    expect(accepted.left).toBeUndefined();
    await expect.poll(() => readReceiptPhases(sender, msgId), { timeout: SHOT_RECEIPT_WAIT_MS }).toContain('complete');
    return { ackAcceptance: accepted.right, receiptPhases: readReceiptPhases(sender, msgId) };
}

/** One API replica: its own application and listener pools, the shared inbound namespace, the NOTIFY relay. */
async function createPostgresReplica(input: PostgresReplicaInput): Promise<RelayedAckMiddlewareInstance> {
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
            await deleteInboundAdmissionRows(lifecycle.database, input.runId);
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
            namespace: toInboundNamespace(input.runId),
            repository: new PSqlRuntimeStateRepository(lifecycle.database)
        }),
        sessionIds: input.sessionIds,
        roomAudiencePeerIds: [LEADER]
    });
}

function toShotMsgId(runId: string): string {
    return `shot-${runId}`;
}

function toInboundNamespace(runId: string): string {
    return `ws-relayed-leader-ack-${runId}`;
}

/** Deletes only this run's inbound admission namespace: its state rows and its work rows. */
async function deleteInboundAdmissionRows(sql: PSqlSql, runId: string): Promise<void> {
    const namespace = `${toInboundNamespace(runId)}:inbound:admission`;
    const work = toALInboundWorkKey(namespace, 'any-effect');
    await sql`delete from resource_inbox where ri_topic_id = ${work.topicId} and ri_resource_id = ${work.resourceId}`;
    await sql`delete from runtime_state_store where store_namespace = ${namespace}`;
}

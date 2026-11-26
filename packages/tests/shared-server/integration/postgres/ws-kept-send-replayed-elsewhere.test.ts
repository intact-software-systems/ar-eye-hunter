import { describe, expect, it } from 'vitest';

import {
    connect,
    readOriginReceiptPhases,
    readReceiptAggregationVerdicts,
    roomMessage
} from '../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import { runKeptSendReplayedElsewhere } from '../../rallar-system/middleware/room-audience-middleware-fixture.ts';
import { createPostgresWsReplica, type PostgresWsReplicaInput } from './test-support/create-postgres-ws-replica.ts';
import { createReceiptCluster, instanceInput, POLL, startInstance } from './test-support/create-receipt-cluster.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const SENDER = 'player';
const RECIPIENT = 'director';
const TRACE_ID = 'trace-ws-kept-send-replayed-elsewhere';
const ORIGIN = 'o';
const ROOM = [ORIGIN, 'r1', 'r2'];

/**
 * A room send kept by the API replica whose room view is behind, and admitted by the replay of another replica that
 * shares the inbound admission namespace: the receipt starts on the admitting replica.
 */
describe('Postgres WS kept send replayed by another replica', () => {
    postgresIt('starts the receipt of a send one replica kept on the replica whose replay admits it', async () => {
        const runId = crypto.randomUUID();
        const replica = (input: Pick<PostgresWsReplicaInput, 'sessionIds' | 'roomView'>) =>
            createPostgresWsReplica({
                inboundNamespace: `ws-kept-send-replayed-elsewhere-${runId}`,
                roomAudiencePeerIds: [SENDER, RECIPIENT],
                ...input
            });
        const keeping = await replica({ sessionIds: [SENDER], roomView: 'behind' });
        const replaying = await replica({ sessionIds: [SENDER, RECIPIENT], roomView: 'in-sync' });

        const kept = await runKeptSendReplayedElsewhere({
            keeping,
            replaying,
            msgId: `kept-${runId}`,
            senderId: SENDER,
            recipientId: RECIPIENT,
            traceId: TRACE_ID
        });

        expect(kept.keptAcceptance).toEqual({ kind: 'pending-admission' });
        expect(kept.sentByKeepingReplica).toEqual(['nack:not-yet-in-sync']);
        expect(kept.receiptsFromReplayingReplica.map(({ phase }) => phase)).toEqual(['admitted', 'complete']);
        expect(kept.receiptsFromReplayingReplica[0]).toMatchObject({
            expectedRecipientPeerIds: [RECIPIENT],
            snapshotVersion: 1
        });
    });

    // Pins an admitted that a replay on an instance holding no socket of the origin writes nowhere: only its row,
    // which the cluster publisher carries to the origin's instance, reaches the origin.
    postgresIt('a kept send replayed on an instance without the origin\'s socket answers admitted as a row', async () => {
        const cluster = await createReceiptCluster();
        // The keeping instance runs no work of its own, so the replay is the replaying instance's.
        const keeping = await startInstance(cluster, { ...instanceInput('keeping', ROOM), starts: false, roomView: { inSync: false } });
        const replaying = await startInstance(cluster, instanceInput('replaying', ROOM));
        await connect(replaying, 'r1');
        await connect(replaying, 'r2');
        cluster.originSockets.push(await connect(keeping, ORIGIN));
        const msgId = `room-${cluster.runId}-kept-elsewhere`;

        const kept = await keeping.service.acceptIncomingMessage(roomMessage({ msgId, originPeerId: ORIGIN, nowMs: Date.now(), lifetimeMs: 30_000 }), ORIGIN);

        expect(kept.right).toEqual({ kind: 'pending-admission' });
        await expect.poll(() => readOriginReceiptPhases(cluster.originSockets, msgId), POLL).toEqual(['admitted']);
        expect(readReceiptAggregationVerdicts(cluster.observations, msgId)).toEqual(['receipt-outbox:admitted:admitted']);
        expect(cluster.observations.filter((observation) => observation.kind === 'receipt-transport' && observation.originIsHere === true))
            .toEqual([]);
    }, 60_000);
});

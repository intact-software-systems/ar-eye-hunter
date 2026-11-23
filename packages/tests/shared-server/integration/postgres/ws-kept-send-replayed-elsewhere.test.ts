import { describe, expect, it } from 'vitest';

import { runKeptSendReplayedElsewhere } from '../../rallar-system/middleware/room-audience-middleware-fixture.ts';
import { createPostgresWsReplica, type PostgresWsReplicaInput } from './test-support/create-postgres-ws-replica.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const SENDER = 'player';
const RECIPIENT = 'director';
const TRACE_ID = 'trace-ws-kept-send-replayed-elsewhere';

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
});

import { describe, expect, it } from 'vitest';

import type { RelayedAckNotice } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';

import { readSentReceipts, toWsDeliveredAckMessage } from '../../../ws-receipted-send-test-controls.ts';
import {
    readReceiptPhases,
    RECIPE_RECEIPT_READ_WAIT_MS,
    toRelayedAckRoomMessage,
    type RelayedAckMiddlewareInstance
} from '../../rallar-system/middleware/relayed-ack-middleware-fixture.ts';
import { createPostgresWsReplica } from './test-support/create-postgres-ws-replica.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const SENDER = 'player';
const LEADER = 'director';
const TRACE_ID = 'trace-ws-relayed-leader-ack';

/**
 * The hosted ALM scale shape: a player's `group-leader` shot carried over WS, admitted by the API replica the
 * player is connected to, and acknowledged by the director over WS. Each replica owns its own PostgreSQL pools,
 * shares the inbound admission namespace as the API replicas do, and relays ACKs over PostgreSQL NOTIFY.
 */
describe('Postgres WS group-leader ACK relay', () => {
    postgresIt('completes the shot receipt when the director acknowledges on the sender instance', async () => {
        const runId = crypto.randomUUID();
        const relayedAcks: RelayedAckNotice[] = [];
        const only = await createPostgresWsReplica({
            inboundNamespace: toInboundNamespace(runId),
            publisherId: `replica-1-${runId}`,
            sessionIds: [SENDER, LEADER],
            roomView: 'in-sync',
            roomAudiencePeerIds: [LEADER],
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
            createPostgresWsReplica({
                inboundNamespace: toInboundNamespace(runId),
                publisherId: `replica-${index}-${runId}`,
                sessionIds,
                roomView: 'in-sync',
                roomAudiencePeerIds: [LEADER],
                relayedAcks
            });
        const senderReplica = await replica(1, [SENDER]);
        const leaderReplica = await replica(2, [LEADER]);
        await replica(3, []);

        const shot = await sendShotAndAcknowledge({ runId, senderReplica, leaderReplica });

        expect(shot.ackAcceptance).toEqual({ kind: 'control', handled: false });
        expect(relayedAcks.map((notice) => notice.publisherId)).toEqual([`replica-2-${runId}`]);
        expect(shot.receiptPhases).toEqual(['admitted', 'complete']);
        const complete = readSentReceipts(senderReplica.sockets[SENDER]!).filter((receipt) => receipt.msgId === toShotMsgId(runId)).at(-1);
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
        toWsDeliveredAckMessage({ ackedMsgId: msgId, fromPeerId: LEADER, originPeerId: SENDER, traceId: TRACE_ID }),
        LEADER
    );

    expect(accepted.left).toBeUndefined();
    await expect.poll(() => readReceiptPhases(sender, msgId), { timeout: RECIPE_RECEIPT_READ_WAIT_MS }).toContain('complete');
    return { ackAcceptance: accepted.right, receiptPhases: readReceiptPhases(sender, msgId) };
}

function toShotMsgId(runId: string): string {
    return `shot-${runId}`;
}

function toInboundNamespace(runId: string): string {
    return `ws-relayed-leader-ack-${runId}`;
}

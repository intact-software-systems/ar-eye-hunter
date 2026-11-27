import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import type { ALOutboundAdmissionStore } from '../../alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import {
    isALOutboundRowUnrecorded,
    toALOrderingPendingPredecessors,
    type ALOrderingBatchSequences,
    type ALOrderingIndexedSequence
} from '../../alm/outbound/lane/compute-al-outbound-group-sent-positions.ts';
import type { JsonWebSocketServer } from '../../websocket/json-web-socket-server.ts';
import { toWsQueueBoxServerOutsideAudienceAck } from './scope/to-ws-queue-box-server-outside-audience-ack.ts';
import type {
    WsQueueBoxServerOutboundPlanning,
    WsQueueBoxServerPreparedMessage
} from './ws-queue-box-server-outbound-planning.ts';
import type { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';

export namespace WsQueueBoxServerTrackOrder {
    export interface Dependencies {
        readonly admissionStore: Pick<
            ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>,
            | 'readStoredMessage'
            | 'listOrderingMessages'
            | 'readStoredPredecessorsToSettled'
            | 'readOrderingPredecessor'
        >;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly socket: Pick<JsonWebSocketServer, 'connections'>;
        readonly receipts: Pick<WsQueueBoxServerReceiptAggregation, 'acceptControlMessage'>;
        readonly outboundPlanning: Pick<WsQueueBoxServerOutboundPlanning, 'resolvePolicy'>;
        readonly name: string;
        readonly newControlId: () => string;
    }
}

/** How an outside-audience drop was judged: from durable presence, or against this instance's open sockets. */
export type WsOutsideAudienceJudgement = 'durable' | 'open-here';

/**
 * Keeps a WS track's recorded positions in sequence order: a dequeued row waits for the lower sequences of its track
 * still to record, every copy reads the positions its first dequeue fixed, and a recipient a copy skips is recorded
 * outside the receipt its origin awaits.
 */
export class WsQueueBoxServerTrackOrder {
    private readonly dependencies: WsQueueBoxServerTrackOrder.Dependencies;

    constructor(dependencies: WsQueueBoxServerTrackOrder.Dependencies) {
        this.dependencies = dependencies;
    }

    /**
     * A dequeued row that still has to record on its track follows every pending indexed predecessor its batch claimed
     * too, and otherwise waits for the nearest one its batch did not, so the track's positions are written in sequence
     * order: a sequence nobody indexed, one recorded, expired or admitted to no audience holds nothing. A held row's
     * re-check reads that one predecessor's index row and stored row: it releases once the row records, ends or names
     * another message.
     */
    async readTrackOrderAuthority(
        message: ALMessage,
        batch: ALOrderingBatchSequences
    ): Promise<ALOutboundMessageRuntime.DequeuedAdmissionAuthority> {
        const { admissionStore, clock } = this.dependencies;
        const trackKey = toALOrderingTrackKey(message);
        const seq = message.ordering?.seq;
        if (trackKey === undefined || seq === undefined || seq <= 1) {
            return { status: 'authorized' };
        }
        const own = await admissionStore.readStoredMessage(message.id.msgId);
        if (own !== undefined && !isALOutboundRowUnrecorded(own, clock.nowMs())) {
            return { status: 'authorized' };
        }
        const indexed = (await admissionStore.listOrderingMessages(trackKey)).filter((row) => row.seq < seq);
        if (indexed.length === 0) {
            return { status: 'authorized' };
        }
        const nowMs = clock.nowMs();
        const predecessors = await admissionStore.readStoredPredecessorsToSettled(indexed, nowMs);
        const pending = toALOrderingPendingPredecessors({ message, ...predecessors, batch, nowMs });
        if (pending.nearestOutside !== undefined) {
            return this.toHeldAuthority(trackKey, pending.nearestOutside);
        }
        return pending.inBatch.length > 0
            ? { status: 'follows-batch-predecessor', seqs: pending.inBatch }
            : { status: 'authorized' };
    }

    /**
     * The positions a tracked row's first dequeue recorded, which every live copy of the row takes its entry from;
     * read once per send of the row, `null` for a row with no track or nothing recorded.
     */
    async readSentPositions(message: ALMessage): Promise<Readonly<Record<string, number>> | null> {
        if (toALOrderingTrackKey(message) === undefined) {
            return null;
        }
        return (await this.dependencies.admissionStore.readStoredMessage(message.id.msgId))?.sentPositions ?? null;
    }

    /**
     * Records each session the server sent its origin's row nothing outside the audience of the receipt the origin
     * awaits (S4-R9), as the server's outside-audience ACK, which the receipt record counts for every origin: a relayed
     * row's and the server's own rows -- its publications and every producer row it sends (S5-R8). Rows no receipt
     * counts recipients of have none to record in. A dequeue or retry drop is judged from durable presence and recorded
     * whatever this instance's sockets hold; a send-time drop or skip is judged only for a session whose socket here is
     * open -- a session live elsewhere is its own instance's to send, one live nowhere is the retry's to judge. A
     * server publication's drop at its first dequeue precedes the pending row that would prove it and writes nothing:
     * the row and the head expect only the judged audience (D545). A skip once the row exists, before or after the
     * head opened, is counted.
     */
    async writeOutsideAudience(
        message: ALMessage,
        sessionIds: readonly string[],
        judgement: WsOutsideAudienceJudgement
    ): Promise<void> {
        const { name, outboundPlanning, socket, receipts, clock } = this.dependencies;
        const originPeerId = message.id.senderId;
        if (!isALLogicalReceiptMode(outboundPlanning.resolvePolicy(message).effective.ack.algo)) {
            return;
        }
        const judged = sessionIds.filter((sessionId) =>
            sessionId !== originPeerId &&
            (judgement === 'durable' || socket.connections.get(sessionId)?.isOpen === true)
        );
        for (const recipientPeerId of judged) {
            await receipts.acceptControlMessage(toWsQueueBoxServerOutsideAudienceAck({
                message,
                recipientPeerId,
                serverPeerId: name,
                controlId: this.dependencies.newControlId(),
                nowMs: clock.nowMs()
            }));
        }
    }

    private toHeldAuthority(
        trackKey: string,
        nearest: ALOrderingIndexedSequence
    ): ALOutboundMessageRuntime.DequeuedAdmissionAuthority {
        const { admissionStore, clock } = this.dependencies;
        return {
            status: 'held',
            reason: `WS row waits for sequence ${nearest.seq} of its track to record first`,
            readReleased: async () => {
                const predecessor = await admissionStore.readOrderingPredecessor(trackKey, nearest.seq);
                return predecessor === undefined || predecessor.msgId !== nearest.msgId ||
                    (predecessor.stored !== undefined && !isALOutboundRowUnrecorded(predecessor.stored, clock.nowMs()));
            }
        };
    }
}

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
import type { WsQueueBoxServerAckRelay } from './ws-queue-box-server-ack-relay.ts';
import type {
    WsQueueBoxServerOutboundPlanning,
    WsQueueBoxServerPreparedMessage
} from './ws-queue-box-server-outbound-planning.ts';

export namespace WsQueueBoxServerTrackOrder {
    export interface Dependencies {
        readonly admissionStore: Pick<
            ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>,
            | 'readStoredMessage'
            | 'listOrderingMessages'
            | 'readStoredPredecessorsToSettled'
            | 'readOrderingPredecessor'
            | 'commitOutsideAudience'
        >;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly socket: Pick<JsonWebSocketServer, 'connections'>;
        readonly ackRelay: Pick<WsQueueBoxServerAckRelay, 'writeServerAck'>;
        readonly outboundPlanning: Pick<WsQueueBoxServerOutboundPlanning, 'resolvePolicy'>;
        readonly name: string;
        readonly newControlId: () => string;
    }
}

/**
 * Keeps a WS track's recorded positions in sequence order: a dequeued row waits for the lower sequences of its track
 * still to record, every copy reads the positions its first dequeue fixed, and a recipient a copy skips is recorded
 * outside the receipt its origin awaits.
 */
export class WsQueueBoxServerTrackOrder {
    private static readonly OWN_OUTSIDE_AUDIENCE_ATTEMPTS = 3;
    private readonly dependencies: WsQueueBoxServerTrackOrder.Dependencies;

    constructor(dependencies: WsQueueBoxServerTrackOrder.Dependencies) {
        this.dependencies = dependencies;
    }

    /**
     * A dequeued row that still has to record on its track follows every pending indexed predecessor its batch claimed
     * too, and otherwise waits for the nearest one its batch did not, so the track's positions are written in sequence
     * order: a sequence nobody indexed, one recorded, expired or admitted to no audience holds nothing. A held row's
     * re-check reads that one predecessor's index row: it releases once the row records, ends or names another message.
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
     * awaits (S4-R9): a relayed row's origin hears it as an outside-audience ACK, and the server's own rows -- its
     * publications and every producer row it sends -- record it in their own receipt (S5-R8). Rows no receipt counts
     * recipients of have none to record in. Only a session connected here is this instance's to judge: its re-check
     * sees every other instance's session as not here, which is no exclusion, so that session stays expected and its
     * own instance answers for it.
     */
    async writeOutsideAudience(message: ALMessage, sessionIds: readonly string[]): Promise<void> {
        const { name, outboundPlanning, socket, ackRelay, clock } = this.dependencies;
        const originPeerId = message.id.senderId;
        if (!isALLogicalReceiptMode(outboundPlanning.resolvePolicy(message).effective.ack.algo)) {
            return;
        }
        const judged = sessionIds.filter((sessionId) =>
            sessionId !== originPeerId && socket.connections.get(sessionId)?.isOpen === true
        );
        if (originPeerId === name) {
            await this.commitOwnOutsideAudience(message, judged);
            return;
        }
        for (const recipientPeerId of judged) {
            await ackRelay.writeServerAck(toWsQueueBoxServerOutsideAudienceAck({
                message,
                recipientPeerId,
                serverPeerId: name,
                controlId: this.dependencies.newControlId(),
                nowMs: clock.nowMs()
            }));
        }
    }

    /** Each attempt re-reads the receipt; one that ended or was never pending has nobody left to record. */
    private async commitOwnOutsideAudience(message: ALMessage, recipientPeerIds: readonly string[]): Promise<void> {
        if (recipientPeerIds.length === 0) {
            return;
        }
        const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        for (let attempt = 0; attempt < WsQueueBoxServerTrackOrder.OWN_OUTSIDE_AUDIENCE_ATTEMPTS; attempt += 1) {
            if (
                await this.dependencies.admissionStore.commitOutsideAudience(receipt, recipientPeerIds) !== 'conflict'
            ) {
                return;
            }
        }
        console.error('Own receipt outside-audience record kept conflicting', { msgId: message.id.msgId });
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

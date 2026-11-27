import { EDGE_ORDER_RECEIVER_DEFAULT_LIMITS } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import { EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { toALGroupTargetKey } from '@shared/al-contracts/al-contract.ts';
import { isALDeliveryTerminal, type ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';

/** The channel-and-room streams a page sends on at once: the figure a receiver follows, so neither end outruns the other. */
export const EDGE_ORDER_MAX_SEND_STREAMS = EDGE_ORDER_RECEIVER_DEFAULT_LIMITS.maxStreams;

export namespace EdgeOrderSendStreams {
    export interface Input {
        /** Mints a stream id in memory. Never the session id, which a reload keeps and every tab of a login shares. */
        readonly newStreamId: () => string;
        /**
         * Past this many streams the one sent on least recently is forgotten, and its next send starts a new
         * stream, which its receivers enter at once and order against nothing the old stream carried.
         */
        readonly maxStreams: number;
        /** How long a send every recipient acknowledged stays open: a recipient may not have sorted it yet. */
        readonly acknowledgedSettleMs: number;
    }

    /** What the send side keeps at an instant: the streams it minted, and their open sends and stated holes. */
    export interface Usage {
        readonly sendStreams: number;
        readonly openSends: number;
    }

    /**
     * Who a room send reaches when it narrows its room: one principal, one peer, a fixed list, or everyone but
     * some sessions. A send that names none of them reaches its whole room.
     */
    export interface Audience {
        readonly principalId?: string;
        readonly peerId?: string;
        readonly recipientPeerIds?: readonly string[];
        readonly exceptPeerIds?: readonly string[];
    }

    /** A channel's send, as far as its order is concerned: what its channel declares and where it is going. */
    export interface ChannelSend {
        readonly order: 'edge' | undefined;
        /** Absent, the channel's topic is its type. */
        readonly topicId: string | undefined;
        readonly typeId: string;
        /** Absent only for a send that names no room, which no edge-ordered channel makes. */
        readonly roomRef: GroupRef | undefined;
        readonly audience: Audience;
        /** Whether a lost copy of the send comes back: it is at-least-once and asks a receipt. */
        readonly retried: boolean;
    }
}

/**
 * The page's edge-ordered send streams, each minted when its first send needs it: one per channel, room and
 * audience, and on a live channel one per publication stream, which is the unit its values replace each other in. A
 * session left out of a narrowed send never sees that send's stream, so it never waits for it.
 */
export class EdgeOrderSendStreams {
    private readonly streams: LatestRepository<string, EdgeOrderSender>;
    private readonly newStreamId: () => string;
    private readonly acknowledgedSettleMs: number;

    constructor(input: EdgeOrderSendStreams.Input) {
        this.streams = new LatestRepository({ maxEntries: input.maxStreams });
        this.newStreamId = input.newStreamId;
        this.acknowledgedSettleMs = input.acknowledgedSettleMs;
    }

    /**
     * Takes the next position of the stream of the send's channel, room and audience; absent for a channel that
     * declares no order. Called once the send's options passed validation and before the send awaits anything.
     */
    openSend(send: EdgeOrderSendStreams.ChannelSend): EdgeOrderOpenSend | undefined {
        const { roomRef } = send;
        if (send.order !== 'edge' || roomRef === undefined) {
            return undefined;
        }
        const { principalId, peerId, recipientPeerIds, exceptPeerIds } = send.audience;
        return this.openStreamSend(
            JSON.stringify([
                send.topicId ?? send.typeId,
                send.typeId,
                toALGroupTargetKey(roomRef),
                principalId ?? null,
                peerId ?? null,
                toSessionSetKey(recipientPeerIds),
                toSessionSetKey(exceptPeerIds)
            ]),
            send.retried
        );
    }

    /**
     * Takes the next position of a live publication stream, when a value of it leaves the stage for its carrier: a
     * value another displaced on the stage never takes one. Nothing retries a live value.
     */
    openLiveSend(publicationStreamKey: string): EdgeOrderOpenSend {
        return this.openStreamSend(publicationStreamKey, false);
    }

    private openStreamSend(key: string, retried: boolean): EdgeOrderOpenSend {
        // Taken out and put back, so the stream last sent on is the newest and the cap pushes out the one idle longest.
        const stream = this.streams.take(key) ?? new EdgeOrderSender(this.newStreamId(), this.acknowledgedSettleMs);
        this.streams.set(key, stream);
        return new EdgeOrderOpenSend(stream, stream.openSend(retried));
    }

    /** Closes, in every stream, the sends that have ended by `nowMs`: an idle page then keeps no open send. */
    closeEndedSends(nowMs: number): void {
        for (const stream of this.streams.readAllValues()) {
            stream.closeEndedSends(nowMs);
        }
    }

    getUsage(): EdgeOrderSendStreams.Usage {
        const streams = this.streams.readAllValues();
        return {
            sendStreams: streams.length,
            openSends: streams.reduce((openSends, stream) => openSends + stream.getOpenSendCount(), 0)
        };
    }
}

/** One key for one set of sessions, in whatever order a send lists them; `null` when the send names none. */
function toSessionSetKey(sessionIds: readonly string[] | undefined): readonly string[] | null {
    return sessionIds === undefined ? null : [...sessionIds].sort();
}

/**
 * A send that fails before it has a handle closes its position, so no receiver waits for it. A send with a handle
 * states its own end through it.
 */
export async function endEdgeOrderSendOnFailure(
    edgeOrderSend: EdgeOrderOpenSend | undefined,
    delivery: Promise<RallarMessageHandle>
): Promise<RallarMessageHandle> {
    try {
        return await delivery;
    }
    catch (error) {
        edgeOrderSend?.end();
        throw error;
    }
}

/** One send of an edge-ordered stream, from the position it took to the lifecycle its stream reads its end from. */
export class EdgeOrderOpenSend {
    private readonly stream: EdgeOrderSender;
    private readonly position: number;

    constructor(stream: EdgeOrderSender, position: number) {
        this.stream = stream;
        this.position = position;
    }

    stamp(nowMs: number): EdgeOrderStamp {
        return this.stream.stampSend(this.position, nowMs);
    }

    /**
     * From here the stream reads a retried send's end from its handle. A handle that is already terminal was
     * refused before any carrier took the message, so nothing of it set out. An acknowledged send reads `delivered`,
     * and the stream keeps it open for its settle time. A send that failed, or whose observation was lost, reads
     * `open` until its deadline: a copy already on its way can still arrive. Any other end is `undelivered`. The
     * stream reads nothing of a send nothing retries: no receiver waits for it, however it ends.
     */
    observe(handle: Pick<RallarMessageHandle, 'lifecycle'>): void {
        const submitted = handle.lifecycle();
        if (isALDeliveryTerminal(submitted)) {
            this.end();
            return;
        }
        this.stream.observeSend(this.position, {
            expiresAtMs: submitted.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
            getEnd: () => toEdgeOrderSendEnd(handle.lifecycle())
        });
    }

    /** Nothing of the send set out: it threw before it had a handle, or its handle was refused at once. */
    end(): void {
        this.stream.endSend(this.position);
    }
}

function toEdgeOrderSendEnd(lifecycle: ALDeliveryLifecycle): EdgeOrderSender.SendEnd {
    if (lifecycle.state === 'acknowledged') {
        return 'delivered';
    }
    return !isALDeliveryTerminal(lifecycle) || lifecycle.state === 'failed' || lifecycle.state === 'unobservable'
        ? 'open'
        : 'undelivered';
}

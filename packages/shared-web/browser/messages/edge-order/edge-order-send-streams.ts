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
         * Past this many channel-and-room streams the one sent on least recently is forgotten, and its next send
         * starts a new stream.
         */
        readonly maxStreams: number;
    }

    /** What the send side keeps at an instant: the streams it minted, and their open sends and stated holes. */
    export interface Usage {
        readonly sendStreams: number;
        readonly openSends: number;
    }

    /** A channel's send, as far as its order is concerned: what its channel declares and where it is going. */
    export interface ChannelSend {
        readonly order: 'edge' | undefined;
        /** Absent, the channel's topic is its type. */
        readonly topicId: string | undefined;
        readonly typeId: string;
        /** Absent only for a send that names no room, which no edge-ordered channel makes. */
        readonly roomRef: GroupRef | undefined;
    }
}

/** The page's edge-ordered send streams: one per channel and room, minted when the first send needs it. */
export class EdgeOrderSendStreams {
    private readonly streams: LatestRepository<string, EdgeOrderSender>;
    private readonly newStreamId: () => string;

    constructor(input: EdgeOrderSendStreams.Input) {
        this.streams = new LatestRepository({ maxEntries: input.maxStreams });
        this.newStreamId = input.newStreamId;
    }

    /**
     * Takes the next position of the channel-and-room's stream; absent for a channel that declares no order.
     * Called once the send's options passed validation and before the send awaits anything.
     */
    openSend(send: EdgeOrderSendStreams.ChannelSend): EdgeOrderOpenSend | undefined {
        const { roomRef } = send;
        if (send.order !== 'edge' || roomRef === undefined) {
            return undefined;
        }
        const key = JSON.stringify([send.topicId ?? send.typeId, send.typeId, toALGroupTargetKey(roomRef)]);
        // Taken out and put back, so the stream last sent on is the newest and the cap pushes out the one idle longest.
        const stream = this.streams.take(key) ?? new EdgeOrderSender(this.newStreamId());
        this.streams.set(key, stream);
        return new EdgeOrderOpenSend(stream, stream.openSend());
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
     * From here the stream reads the send's end from its handle. A handle that is already terminal was refused
     * before any carrier took the message, so nothing of it set out. An acknowledged send reads `delivered`. A send
     * that failed, or whose observation was lost, reads `open` until its deadline: a copy already on its way can
     * still arrive. Any other end is `undelivered`. Every edge-ordered send is at-least-once and receipted, so each
     * is one a receiver waits for.
     */
    observe(handle: Pick<RallarMessageHandle, 'lifecycle'>): void {
        const submitted = handle.lifecycle();
        if (isALDeliveryTerminal(submitted)) {
            this.end();
            return;
        }
        this.stream.observeSend(this.position, {
            expiresAtMs: submitted.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
            retried: true,
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

import { EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { toALGroupTargetKey } from '@shared/al-contracts/al-contract.ts';
import { isALDeliveryTerminal } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';

export namespace EdgeOrderSendStreams {
    export interface Input {
        /** Mints a stream id in memory. Never the session id, which a reload keeps and every tab of a login shares. */
        readonly newStreamId: () => string;
        /** Past this many channel-and-room streams the oldest is forgotten, and its next send starts a new stream. */
        readonly maxStreams: number;
    }

    export interface ChannelRoom {
        readonly topicId: string;
        readonly typeId: string;
        readonly roomRef: GroupRef;
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

    /** Takes the next position of the channel-and-room's stream. Called before the send awaits anything. */
    openSend(channelRoom: EdgeOrderSendStreams.ChannelRoom): EdgeOrderOpenSend {
        const key = JSON.stringify([channelRoom.topicId, channelRoom.typeId, toALGroupTargetKey(channelRoom.roomRef)]);
        const stream = this.streams.setIfAbsent(key, () => new EdgeOrderSender(this.newStreamId()));
        return new EdgeOrderOpenSend(stream, stream.openSend());
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
     * before any carrier took the message, so nothing of it set out. A send that fails later keeps its position
     * open until its deadline, as does one whose observation was lost: a copy already on its way can still
     * arrive. Every edge-ordered send is at-least-once and receipted, so each is one a receiver waits for.
     */
    observe(handle: RallarMessageHandle): void {
        const submitted = handle.lifecycle();
        if (isALDeliveryTerminal(submitted)) {
            this.end();
            return;
        }
        this.stream.observeSend(this.position, {
            expiresAtMs: submitted.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
            retried: true,
            hasEnded: () => {
                const lifecycle = handle.lifecycle();
                return isALDeliveryTerminal(lifecycle) && lifecycle.state !== 'failed' &&
                    lifecycle.state !== 'unobservable';
            }
        });
    }

    /** Nothing of the send set out: it threw before it had a handle, or its handle was refused at once. */
    end(): void {
        this.stream.endSend(this.position);
    }
}

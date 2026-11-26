import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';

export namespace EdgeOrderSender {
    export interface SendDto {
        readonly expiresAtMs: number;
        /** False for a send nothing retries: a lost copy never comes back, so no receiver waits for it. */
        readonly retried: boolean;
    }
}

export class EdgeOrderSender {
    private readonly stream: string;
    private lastPosition = 0;
    /** Positions are inserted in rising order, so the first key is the lowest open position. */
    private readonly openSends = new Map<number, EdgeOrderSender.SendDto>();

    constructor(stream: string) {
        this.stream = stream;
    }

    stampSend(send: EdgeOrderSender.SendDto): EdgeOrderStamp {
        const earlierCanArriveUntilMs = computeLatestRetriedDeadline(this.openSends.values());
        this.lastPosition += 1;
        this.openSends.set(this.lastPosition, send);
        return {
            stream: this.stream,
            position: this.lastPosition,
            lowestOpenPosition: this.openSends.keys().next().value ?? this.lastPosition,
            earlierCanArriveUntilMs
        };
    }

    endSend(position: number): void {
        this.openSends.delete(position);
    }
}

function computeLatestRetriedDeadline(openSends: Iterable<EdgeOrderSender.SendDto>): number | undefined {
    let latestDeadlineMs: number | undefined;
    for (const send of openSends) {
        if (send.retried && (latestDeadlineMs === undefined || send.expiresAtMs > latestDeadlineMs)) {
            latestDeadlineMs = send.expiresAtMs;
        }
    }
    return latestDeadlineMs;
}

import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';

/** What an edge-ordered message carries in `payload.resource`: the application's payload beside its stamp. */
export interface EdgeOrderWirePayload {
    readonly stamp: EdgeOrderStamp;
    readonly payload: RallarMessagePayload;
}

const MAX_STREAM_LENGTH = 64;

/** `payloadJson` is the application payload as already validated JSON text, so the wrapper adds its own bytes only. */
export function toEdgeOrderWireJson(stamp: EdgeOrderStamp, payloadJson: string): string {
    return `{"edgeOrder":${JSON.stringify(stamp)},"payload":${payloadJson}}`;
}

/** Absent when the resource is not a wrapper with a valid stamp: the sender's channel was not declared edge-ordered. */
export function decodeEdgeOrderWirePayload(resource: string): EdgeOrderWirePayload | undefined {
    let wire: RallarMessagePayload;
    try {
        wire = JSON.parse(resource);
    }
    catch {
        return undefined;
    }
    if (
        typeof wire !== 'object' || wire === null || !('payload' in wire) || !('edgeOrder' in wire) ||
        !isEdgeOrderStamp(wire.edgeOrder)
    ) {
        return undefined;
    }
    const { stream, position, lowestOpenPosition, earlierCanArriveUntilMs } = wire.edgeOrder;
    return {
        stamp: { stream, position, lowestOpenPosition, earlierCanArriveUntilMs },
        payload: wire.payload as RallarMessagePayload
    };
}

function isEdgeOrderStamp(value: unknown): value is EdgeOrderStamp {
    return typeof value === 'object' && value !== null &&
        'stream' in value && 'position' in value && 'lowestOpenPosition' in value &&
        typeof value.stream === 'string' && value.stream.length > 0 && value.stream.length <= MAX_STREAM_LENGTH &&
        isPosition(value.position) && isPosition(value.lowestOpenPosition) &&
        value.lowestOpenPosition <= value.position &&
        (!('earlierCanArriveUntilMs' in value) || typeof value.earlierCanArriveUntilMs === 'number');
}

function isPosition(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

import {
    EDGE_ORDER_MAX_STATED_HOLES,
    type EdgeOrderPositionRun,
    type EdgeOrderStamp
} from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';

/** What an edge-ordered message carries in `payload.resource`: the application's payload beside its stamp. */
export interface EdgeOrderWirePayload {
    readonly stamp: EdgeOrderStamp;
    readonly payload: RallarMessagePayload;
}

const MAX_STREAM_LENGTH = 64;

/**
 * `payloadJson` is the application payload as already validated JSON text, so the wrapper adds its own bytes only.
 * A stamp that states no hole, as nearly every stamp does, carries no `holes` at all.
 */
export function toEdgeOrderWireJson(stamp: EdgeOrderStamp, payloadJson: string): string {
    const edgeOrder = stamp.holes.length > 0 ? stamp : { ...stamp, holes: undefined };
    return `{"edgeOrder":${JSON.stringify(edgeOrder)},"payload":${payloadJson}}`;
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
        stamp: { stream, position, lowestOpenPosition, earlierCanArriveUntilMs, holes: wire.edgeOrder.holes ?? [] },
        payload: wire.payload as RallarMessagePayload
    };
}

/** A stamp as it travels: one that states no hole has no `holes`. */
type EdgeOrderWireStamp = Omit<EdgeOrderStamp, 'holes'> & Partial<Pick<EdgeOrderStamp, 'holes'>>;

function isEdgeOrderStamp(value: unknown): value is EdgeOrderWireStamp {
    return typeof value === 'object' && value !== null &&
        'stream' in value && 'position' in value && 'lowestOpenPosition' in value &&
        typeof value.stream === 'string' && value.stream.length > 0 && value.stream.length <= MAX_STREAM_LENGTH &&
        isPosition(value.position) && isPosition(value.lowestOpenPosition) &&
        value.lowestOpenPosition <= value.position &&
        (!('earlierCanArriveUntilMs' in value) || typeof value.earlierCanArriveUntilMs === 'number') &&
        (!('holes' in value) || isHolesBetween(value.holes, value.lowestOpenPosition, value.position));
}

/** Rising runs that do not touch, each above the lowest open position, which is open, and below the stamped one. */
function isHolesBetween(
    value: unknown,
    lowestOpenPosition: number,
    position: number
): value is readonly EdgeOrderPositionRun[] {
    if (!Array.isArray(value) || value.length > EDGE_ORDER_MAX_STATED_HOLES) {
        return false;
    }
    let lowestNextStart = lowestOpenPosition + 1;
    for (const run of value) {
        if (!isPositionRun(run) || run[0] < lowestNextStart || run[1] >= position) {
            return false;
        }
        lowestNextStart = run[1] + 2;
    }
    return true;
}

function isPositionRun(value: unknown): value is EdgeOrderPositionRun {
    return Array.isArray(value) && value.length === 2 && isPosition(value[0]) && isPosition(value[1]) &&
        value[0] <= value[1];
}

function isPosition(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

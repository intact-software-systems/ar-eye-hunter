import type { ALAdmissionReadContext } from '../../al-admission-backend.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../../al-admission-value-validation.ts';

/** A track whose snapshot the store evicted at its cap, and the instant that eviction stops counting. */
export interface ALInboundEvictedOrderingTrack {
    readonly trackKey: string;
    /** The eviction's instant plus one ordering-track TTL: a snapshot it removed would have expired by then. */
    readonly untilMs: number;
}

export interface ToALInboundEvictedOrderingTracksInput {
    /** The store's row as read, oldest eviction first. */
    readonly held: readonly ALInboundEvictedOrderingTrack[];
    readonly evictedTrackKeys: readonly string[];
    readonly untilMs: number;
    readonly nowMs: number;
    /** The most evictions the row keeps; the oldest leave first. */
    readonly maxTracks: number;
}

export function decodeALInboundEvictedOrderingTracks(value: unknown): readonly ALInboundEvictedOrderingTrack[] {
    const tracks = decodeALAdmissionArray(value, (entry) => {
        const track = decodeALAdmissionRecord(entry, ['trackKey', 'untilMs']);
        return { trackKey: decodeALAdmissionString(track.trackKey), untilMs: decodeALAdmissionNumber(track.untilMs) };
    });
    if (new Set(tracks.map((track) => track.trackKey)).size !== tracks.length) {
        throw new TypeError('Stored evicted ordering tracks must name each track once');
    }
    return tracks;
}

/** The row after an eviction pass: lapsed entries dropped, each evicted track moved to newest, the oldest past the bound. */
export function toALInboundEvictedOrderingTracks(
    input: ToALInboundEvictedOrderingTracksInput
): readonly ALInboundEvictedOrderingTrack[] {
    const evicted = new Set(input.evictedTrackKeys);
    const kept = input.held.filter((track) => track.untilMs > input.nowMs && !evicted.has(track.trackKey));
    const added = [...evicted].map((trackKey) => ({ trackKey, untilMs: input.untilMs }));
    const tracks = [...kept, ...added];
    return tracks.slice(Math.max(0, tracks.length - input.maxTracks));
}

export function isALInboundOrderingTrackEvicted(
    held: readonly ALInboundEvictedOrderingTrack[],
    trackKey: string,
    nowMs: number
): boolean {
    return held.some((track) => track.trackKey === trackKey && track.untilMs > nowMs);
}

export interface ReadALInboundOrderingTrackEvictedInput {
    readonly database: Pick<ALAdmissionReadContext, 'read'>;
    /** The store's one row of evicted tracks. */
    readonly key: string;
    readonly trackKey: string;
    readonly nowMs: number;
}

export async function readALInboundOrderingTrackEvicted(
    input: ReadALInboundOrderingTrackEvictedInput
): Promise<boolean> {
    const held = await input.database.read(input.key, decodeALInboundEvictedOrderingTracks);
    return held !== undefined && isALInboundOrderingTrackEvicted(held, input.trackKey, input.nowMs);
}

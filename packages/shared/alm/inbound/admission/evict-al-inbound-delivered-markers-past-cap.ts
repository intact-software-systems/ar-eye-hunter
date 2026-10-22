import type { ALAdmissionWorkBackend } from '../../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';
import { decodeALInboundDeliveryProgress } from '../al-inbound-ordering-validation.ts';
import type { ALInboundDeliveredMarkerIndex, ALInboundIndexedMarker } from './al-inbound-delivered-marker-index.ts';

/**
 * The most delivered markers one of the browser's inbound stores keeps, as many as it keeps ordering snapshots; the
 * server's stores pass no cap and keep each marker until its expiry.
 */
export const AL_INBOUND_MAX_DELIVERED_MARKERS = 256;

/** The delivered markers one store holds, stated after the pass a new marker runs. */
export type ALInboundDeliveredMarkersReport = (markers: number) => void;

export interface EvictALInboundDeliveredMarkersPastCapInput {
    readonly backend: ALAdmissionWorkBackend;
    readonly deliveredPrefix: string;
    readonly bufferedPrefix: string;
    readonly index: ALInboundDeliveredMarkerIndex;
    readonly maxMarkers: number;
    readonly nowMs: number;
    /** Absent where nothing reads the count. */
    readonly report: ALInboundDeliveredMarkersReport | undefined;
}

/**
 * Keeps the store's markers at the cap: past it, the least recently admitted track's marker leaves, found at the head
 * of the index without reading the store's other markers. Each removal is one guarded write that rereads the marker: a
 * marker gone already counts as gone, one whose expiry an admission moved since the index saw it is moved behind the
 * others instead.
 *
 * The cap is soft in one case: a marker whose track still buffers a release, an in-order one waiting for its delivery
 * included, is never evicted, since that release's delivery reads it as its completion evidence; the next oldest leaves
 * instead, and a store whose every marker buffers stays past the cap until its releases drain or expire. A kept head
 * is read again by every later pass, one guarded write each, so a pass costs one write per buffering head before it.
 *
 * The first pass of a store reads every marker once, so the index also counts the rows it held before the index
 * existed. The pass runs after the admission that wrote the marker committed, so it is best-effort: a failing read or
 * write, a conflict or a throwing `report` ends the pass without a count and leaves the eviction to the next new marker.
 * States how many markers the store holds to `report`.
 */
export async function evictALInboundDeliveredMarkersPastCap(
    input: EvictALInboundDeliveredMarkersPastCapInput
): Promise<void> {
    try {
        if (!input.index.loaded) {
            input.index.load(await readHeldMarkers(input));
        }
        let excess = input.index.count(input.nowMs) - input.maxMarkers;
        for (const marker of input.index.getOldest(input.nowMs)) {
            if (excess <= 0) {
                break;
            }
            excess -= await removeUnlessLive(input, marker) === 'gone' ? 1 : 0;
        }
        input.report?.(input.index.count(input.nowMs));
    }
    catch (error) {
        if (!(error instanceof ALAdmissionBackendConflictError)) {
            console.warn('AL inbound delivered-marker eviction failed; the next new marker retries it', error);
        }
    }
}

async function readHeldMarkers(input: EvictALInboundDeliveredMarkersPastCapInput): Promise<ALInboundIndexedMarker[]> {
    const held = await input.backend.readWithin((session) =>
        session.list(input.deliveredPrefix, decodeALInboundDeliveryProgress)
    );
    return held.map((entry) => ({
        trackKey: entry.key.slice(input.deliveredPrefix.length),
        expireAtTimestamp: entry.value.expireAtTimestamp
    }));
}

/** Removes the marker unless an admission moved it since the index saw it or its track still buffers a release. */
async function removeUnlessLive(
    input: EvictALInboundDeliveredMarkersPastCapInput,
    marker: ALInboundIndexedMarker
): Promise<'gone' | 'kept'> {
    const key = `${input.deliveredPrefix}${marker.trackKey}`;
    const outcome = await input.backend.write(async (transaction) => {
        const current = await transaction.read(key, decodeALInboundDeliveryProgress);
        if (current === undefined) {
            return 'gone';
        }
        if (current.expireAtTimestamp > marker.expireAtTimestamp) {
            return current.expireAtTimestamp;
        }
        const buffered = await transaction.list(`${input.bufferedPrefix}${marker.trackKey}:`, () => true);
        if (buffered.length > 0) {
            return 'kept';
        }
        await transaction.remove(key);
        return 'gone';
    });
    if (typeof outcome === 'number') {
        input.index.record({ trackKey: marker.trackKey, expireAtTimestamp: outcome });
        return 'kept';
    }
    if (outcome === 'gone') {
        input.index.forget(marker.trackKey);
    }
    return outcome;
}

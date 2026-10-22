import type { ALAdmissionWorkBackend } from '../../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';
import { decodeALInboundDeliveryProgress } from '../al-inbound-ordering-validation.ts';
import type { ALInboundDeliveredMarkerIndex, ALInboundIndexedMarker } from './al-inbound-delivered-marker-index.ts';

/**
 * The committed default of the most delivered markers one inbound store keeps per sender, the browser's and the
 * server's alike. It matches the browser's ordering-snapshot cap, so one sender at both caps still has a marker for
 * every track it orders.
 */
export const AL_INBOUND_MAX_DELIVERED_MARKERS = 256;

/** The delivered markers one store holds, every sender's summed, stated after the pass a new marker runs. */
export type ALInboundDeliveredMarkersReport = (markers: number) => void;

export interface EvictALInboundDeliveredMarkersPastCapInput {
    readonly backend: ALAdmissionWorkBackend;
    readonly deliveredPrefix: string;
    readonly bufferedPrefix: string;
    readonly index: ALInboundDeliveredMarkerIndex;
    /** The sender whose new marker ran the pass; only its markers are counted against the cap and evicted. */
    readonly senderId: string;
    readonly maxMarkers: number;
    readonly nowMs: number;
    /** Absent where nothing reads the count. */
    readonly report: ALInboundDeliveredMarkersReport | undefined;
}

/**
 * Keeps the sender's markers at the cap: past it, the sender's marker that expires first leaves, found at the head of
 * the index without reading the store's other markers. Each removal is one guarded write that rereads the marker: a
 * marker gone already counts as gone, one whose expiry an admission moved since the index saw it is moved behind the
 * others instead.
 *
 * The cap is soft in one case: a marker whose track still buffers a release is never evicted, since that release's
 * delivery reads it as its completion evidence; the sender's next oldest leaves instead, and a sender whose every
 * marker buffers stays past the cap until its releases drain or expire.
 *
 * The first pass of a store reads every marker once, so the index also counts the rows it held before the index
 * existed. The pass runs after the admission that wrote the marker committed, so it is best-effort: a failing read or
 * write, a conflict or a throwing `report` ends the pass without a count and leaves the eviction to the next new marker.
 * States how many markers the store holds, every sender's summed, to `report`.
 */
export async function evictALInboundDeliveredMarkersPastCap(
    input: EvictALInboundDeliveredMarkersPastCapInput
): Promise<void> {
    try {
        if (!input.index.loaded) {
            input.index.load(await readHeldMarkers(input));
        }
        let excess = input.index.countSender(input.senderId, input.nowMs) - input.maxMarkers;
        for (const marker of input.index.readOldest(input.senderId, input.nowMs)) {
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
        input.index.record(input.senderId, { trackKey: marker.trackKey, expireAtTimestamp: outcome });
        return 'kept';
    }
    if (outcome === 'gone') {
        input.index.forget(input.senderId, marker.trackKey);
    }
    return outcome;
}

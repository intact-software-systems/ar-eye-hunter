import type { ALOrderingTrackSnapshot } from '../../../al-contracts/al-runtime.ts';
import { jsonEquals } from '../../../repository/state-utils.ts';
import type { ALAdmissionBackendEntry } from '../../al-admission-backend.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';
import { decodeALInboundOrderingSnapshot } from '../al-inbound-ordering-validation.ts';
import {
    decodeALInboundEvictedOrderingTracks,
    toALInboundEvictedOrderingTracks
} from './al-inbound-evicted-ordering-tracks.ts';

/**
 * The most ordering snapshots one of the browser's inbound stores keeps (D191); the server's stores pass no cap. The
 * next new track evicts the least recently updated one, so a departed sender's tracks leave under churn instead of an
 * hour after their last message.
 */
export const AL_INBOUND_MAX_ORDERING_TRACKS = 256;

/** The ordering snapshots one store holds, stated after the eviction pass a new track runs. */
export type ALInboundOrderingTracksReport = (tracks: number) => void;

export interface EvictALInboundOrderingTracksPastCapInput {
    readonly backend: ALAdmissionWorkBackend;
    readonly orderingPrefix: string;
    /** The store's one row of the tracks its cap evicted. */
    readonly evictedTracksKey: string;
    readonly maxTracks: number;
    readonly orderingTrackTtlMs: number;
    readonly nowMs: number;
    /** Absent where nothing reads the count. */
    readonly report: ALInboundOrderingTracksReport | undefined;
}

/**
 * Removes the least recently updated snapshots past the cap, each only if it is still the one read: a snapshot
 * updated in between is no longer the least recent, and its conflict leaves the eviction to the next new track.
 * Only the snapshot leaves; the track's delivered marker keeps the completion evidence its live work reads.
 * The same write records each track it removed in the evicted-track row until one ordering-track TTL after the pass,
 * so a recorded copy of that track enters at its own sequence instead of asking for sequences already delivered; a
 * snapshot it did not remove, because it changed or was already gone, is not recorded.
 * States how many snapshots the store holds after the pass to `report`.
 *
 * The pass runs after the admission that opened the track committed, so it is best-effort: a snapshot or row that
 * does not decode, a failed removal write or a throwing `report` ends the pass without a count and leaves the eviction
 * to the next new track. The admission's own read of a corrupt snapshot still fails where it decodes that snapshot.
 */
export async function evictALInboundOrderingTracksPastCap(
    input: EvictALInboundOrderingTracksPastCapInput
): Promise<void> {
    try {
        const held = await input.backend.readWithin((session) =>
            session.list(input.orderingPrefix, decodeALInboundOrderingSnapshot)
        );
        const evicted = resolveLeastRecentlyUpdatedTracks(held, held.length - input.maxTracks);
        const gone = evicted.length === 0 ? 0 : await removeUnchangedTracks(input, evicted);
        input.report?.(held.length - gone);
    }
    catch (error) {
        console.warn('AL inbound ordering-track eviction failed; the next new track retries it', error);
    }
}

/** Answers how many of `evicted` the store no longer holds: those it removed and those a rival pass already had. */
async function removeUnchangedTracks(
    input: EvictALInboundOrderingTracksPastCapInput,
    evicted: readonly ALAdmissionBackendEntry<ALOrderingTrackSnapshot>[]
): Promise<number> {
    try {
        return await input.backend.write(async (transaction) => {
            const removedTrackKeys: string[] = [];
            let gone = 0;
            for (const track of evicted) {
                const current = await transaction.read(track.key, decodeALInboundOrderingSnapshot);
                const unchanged = current !== undefined && jsonEquals(current, track.value);
                if (unchanged) {
                    await transaction.remove(track.key);
                    removedTrackKeys.push(track.key.slice(input.orderingPrefix.length));
                }
                if (unchanged || current === undefined) {
                    gone += 1;
                }
            }
            await writeEvictedTracks(transaction, input, removedTrackKeys);
            return gone;
        });
    }
    catch (error) {
        if (!(error instanceof ALAdmissionBackendConflictError)) {
            throw error;
        }
        return 0;
    }
}

async function writeEvictedTracks(
    transaction: ALAdmissionWorkWriteContext,
    input: EvictALInboundOrderingTracksPastCapInput,
    evictedTrackKeys: readonly string[]
): Promise<void> {
    if (evictedTrackKeys.length === 0) {
        return;
    }
    const held = await transaction.read(input.evictedTracksKey, decodeALInboundEvictedOrderingTracks);
    const tracks = toALInboundEvictedOrderingTracks({
        held: held ?? [],
        evictedTrackKeys,
        untilMs: input.nowMs + input.orderingTrackTtlMs,
        nowMs: input.nowMs
    });
    // The row lapses with its newest entry, so it leaves the store once no entry names a live eviction.
    await transaction.set(input.evictedTracksKey, tracks, Math.max(...tracks.map((track) => track.untilMs)));
}

/** Every snapshot expires one TTL after its update, so the least recently updated is also the next to expire. */
function resolveLeastRecentlyUpdatedTracks(
    held: readonly ALAdmissionBackendEntry<ALOrderingTrackSnapshot>[],
    count: number
): readonly ALAdmissionBackendEntry<ALOrderingTrackSnapshot>[] {
    return [...held]
        .sort((left, right) => left.value.updatedAtMs - right.value.updatedAtMs || left.key.localeCompare(right.key))
        .slice(0, Math.max(0, count));
}

import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';
import { computeALInboundWitnessedCompletedThrough } from '../admission/al-inbound-delivery-progress.ts';
import type { ALInboundOrderingPositionStatement } from '../admission/record-al-inbound-ordering-position.ts';
import type {
    ALInboundAdmissionRead,
    ALInboundCommitBundle,
    ALInboundMessageReadDto,
    ALInboundOrderingTrackRead
} from '../al-inbound-admission-store.ts';
import { toALInboundBufferedReleaseEffects } from '../al-inbound-effect-intent.ts';
import { prepareALInboundCommitBundle, type ALInboundEffectFacts } from '../prepare-al-inbound-commit-bundle.ts';
import type { ALOrderingHeldEntry } from './compute-al-ordering-held-entry.ts';

export interface ComputeALInboundHeldTrackEntryInput {
    /**
     * The admission surface of the track's lowest live copy, planned as it was admitted: its `msg` is the object the
     * end verified and planned, which the bundle and the stated entry carry, never the track's own decode of it.
     */
    readonly read: ALInboundAdmissionRead;
    readonly entry: Extract<ALOrderingHeldEntry, { readonly kind: 'entered'; }>;
    /**
     * The entered copy's plan as the copy entered at, from the same sender's track and source: what its slot records,
     * so its delivery waits on nothing below it.
     */
    readonly plan: ALMessageHandlingPlan;
    readonly facts: ALInboundEffectFacts;
}

/** The bundle that ends a hold at a copy, and that copy as its committed entry names it. */
export interface ALInboundHeldTrackEntry {
    readonly bundle: ALInboundCommitBundle;
    readonly entered: Omit<ALInboundOrderingPositionStatement, 'workerId'>;
}

/**
 * The bundle that ends a track's bounded hold at its lowest live copy, as an entered admission of that copy would write
 * it: the new position, and a release of that copy and of each contiguous live successor through the buffered-release
 * path. It is guarded by the track as read, so an arrival that moved the track first wins and the timer runs again.
 */
export function computeALInboundHeldTrackEntry(input: ComputeALInboundHeldTrackEntryInput): ALInboundHeldTrackEntry {
    const { read, entry } = input;
    const plan = { ...input.plan, orderingRuntime: entry.observation };
    const slot = read.bufferedSnapshots.find((buffered) => buffered.seq === entry.observation.seq);
    if (slot === undefined) {
        throw new Error('A held entry names a copy its track does not buffer');
    }
    const entered: ALInboundMessageReadDto = {
        kind: 'incoming',
        orderingTrackTtlMs: read.orderingTrackTtlMs,
        namespace: read.namespace,
        msg: read.msg,
        fromPeerId: read.fromPeerId,
        source: read.source,
        nowMs: read.nowMs,
        observations: read.observations,
        orderingSnapshot: read.orderingSnapshot,
        orderingAcceptance: entry,
        bufferedSnapshots: read.bufferedSnapshots.map((buffered) => {
            // The run's last copy completes the track past the expired copies the position passed after it.
            const reached = {
                ...buffered,
                completesThrough: entry.completesThrough[buffered.seq] ?? buffered.completesThrough
            };
            if (buffered.seq === entry.observation.seq) {
                return { ...reached, msg: read.msg, plan };
            }
            const priorSeq = entry.passedPriorSeqs[buffered.seq];
            // A copy released past expired ones waits on the released copy before it, as an omission waits on its prior.
            return priorSeq === undefined ? reached : {
                ...reached,
                plan: {
                    ...buffered.plan,
                    orderingRuntime: { ...buffered.plan.orderingRuntime, status: 'omitted', priorSeq }
                }
            };
        }),
        supersedence: read.supersedence,
        pendingAck: read.pendingAck,
        acks: read.acks,
        nacks: read.nacks,
        controlOwners: read.controlOwners,
        plan,
        // The end releases buffered copies and admits no duplicate, so it forwards no retried copy.
        retriedCopyNextHopPeerIds: [],
        retention: read.retention,
        durability: read.durability
    };
    return {
        bundle: prepareALInboundCommitBundle({
            read: entered,
            facts: input.facts,
            mutations: [{ kind: 'set-ordering', trackKey: entry.trackKey, snapshot: entry.nextSnapshot }],
            effects: toALInboundBufferedReleaseEffects(entered)
        }),
        entered: { msg: read.msg, carrier: slot.carrier, plan }
    };
}

/**
 * The bundle that ends a track's bounded hold when every buffered copy expired: the position and the delivery progress
 * move past every buffered sequence, as a witness moves them, and nothing is released. It is bookkeeping on expired
 * copies, so it names no admission deadline; it is guarded by the track as read, as the entry is.
 */
export function computeALInboundPassedTrack(
    track: ALInboundOrderingTrackRead,
    entry: Extract<ALOrderingHeldEntry, { readonly kind: 'passed'; }>
): ALInboundCommitBundle {
    const { observations } = track;
    const progress = observations.deliveryProgress?.value;
    return {
        admissionExpiresAtMs: null,
        senderId: observations.senderId,
        observations,
        mutations: [{ kind: 'set-ordering', trackKey: entry.trackKey, snapshot: entry.nextSnapshot }, {
            kind: 'set-delivery-progress',
            trackKey: entry.trackKey,
            value: {
                completedThrough: computeALInboundWitnessedCompletedThrough({
                    completedThrough: progress?.completedThrough ?? 0,
                    previousPosition: 0,
                    witnessedPosition: entry.nextSnapshot.lastContiguousSeq
                }),
                expireAtTimestamp: Math.max(progress?.expireAtTimestamp ?? 0, track.nowMs + track.orderingTrackTtlMs)
            }
        }],
        durableEffects: []
    };
}

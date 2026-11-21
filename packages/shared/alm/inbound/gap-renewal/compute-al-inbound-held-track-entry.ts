import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';
import type {
    ALInboundAdmissionRead,
    ALInboundCommitBundle,
    ALInboundMessageReadDto
} from '../al-inbound-admission-store.ts';
import { toALInboundBufferedReleaseEffects } from '../al-inbound-effect-intent.ts';
import { prepareALInboundCommitBundle, type ALInboundEffectFacts } from '../prepare-al-inbound-commit-bundle.ts';
import type { ALOrderingHeldEntry } from './compute-al-ordering-held-entry.ts';

export interface ComputeALInboundHeldTrackEntryInput {
    /** The admission surface of the track's lowest buffered copy, read with the plan that copy was admitted with. */
    readonly read: ALInboundAdmissionRead;
    readonly entry: ALOrderingHeldEntry;
    /** The copy's plan as an entered copy: what its slot records, so its delivery waits on nothing below it. */
    readonly plan: ALMessageHandlingPlan;
    readonly facts: ALInboundEffectFacts;
}

/**
 * The bundle that ends a track's bounded hold, as an entered admission of its lowest buffered copy would write it: the
 * track's new position, and a release of that copy and of each contiguous successor through the buffered-release path.
 * It is guarded by the track it read, so an arrival that moved the track first wins and the timer runs again.
 */
export function computeALInboundHeldTrackEntry(input: ComputeALInboundHeldTrackEntryInput): ALInboundCommitBundle {
    const { read, entry, plan } = input;
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
        bufferedSnapshots: read.bufferedSnapshots.map((buffered) =>
            buffered.seq === entry.observation.seq ? { ...buffered, plan } : buffered
        ),
        supersedence: read.supersedence,
        pendingAck: read.pendingAck,
        acks: read.acks,
        nacks: read.nacks,
        controlOwners: read.controlOwners,
        plan,
        retention: read.retention,
        durability: read.durability
    };
    return prepareALInboundCommitBundle({
        read: entered,
        facts: input.facts,
        mutations: [{ kind: 'set-ordering', trackKey: entry.trackKey, snapshot: entry.nextSnapshot }],
        effects: toALInboundBufferedReleaseEffects(entered)
    });
}

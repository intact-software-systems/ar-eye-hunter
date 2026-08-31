import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { ALOrderingTrackSnapshot } from '../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { computeALOrderingObservation } from '../compute-al-ordering-observation.ts';
import { computeALSupersedenceObservation } from '../compute-al-supersedence-observation.ts';
import type { ALInboundPlannerState, ALInboundSupersedenceReadState } from './al-inbound-admission-store.ts';

export interface ALInboundPlannerSnapshot {
    readonly msg: ALMessage;
    readonly prePlan: ALMessageHandlingPlan;
    readonly nowMs: number;
    readonly orderingTrackKey: string | undefined;
    readonly orderingSnapshot: ALOrderingTrackSnapshot | undefined;
    readonly orderingTrackTtlMs: number;
    readonly dedupExpiresAt: number | undefined;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceTrackTtlMs: number;
    /** Replays have already committed deduplication and ordering admission. */
    readonly admitted: boolean;
}

export function toALInboundPlannerState(read: ALInboundPlannerSnapshot): ALInboundPlannerState {
    return {
        dedupStore: read.admitted ? undefined : {
            has: (key, nowMs = read.nowMs) =>
                key === read.prePlan.dedupKey && read.dedupExpiresAt !== undefined && read.dedupExpiresAt > nowMs
        },
        orderingStore: read.admitted ? undefined : {
            peek: (candidate, nowMs = read.nowMs) => {
                if (
                    read.orderingTrackKey === undefined || candidate.id.msgId !== read.msg.id.msgId ||
                    toALOrderingTrackKey(candidate) !== read.orderingTrackKey
                ) {
                    return { status: 'untracked', missingSeqs: [], releasableSeqs: [] };
                }
                return computeALOrderingObservation({
                    snapshot: read.orderingSnapshot,
                    msg: candidate,
                    nowMs,
                    trackTtlMs: read.orderingTrackTtlMs,
                    apply: false
                }).observation;
            }
        },
        supersedenceStore: {
            peek: (supersedence, nowMs = read.nowMs) => {
                if (
                    supersedence.msgId !== read.msg.id.msgId || supersedence.key !== read.prePlan.supersedence.key ||
                    supersedence.replacesMsgId !== read.prePlan.supersedence.replacesMsgId
                ) {
                    return { status: 'untracked' };
                }
                return computeALSupersedenceObservation({
                    supersedence,
                    latest: read.supersedence.latest,
                    replacement: read.supersedence.replacement,
                    nowMs,
                    trackTtlMs: read.supersedenceTrackTtlMs
                });
            }
        }
    };
}

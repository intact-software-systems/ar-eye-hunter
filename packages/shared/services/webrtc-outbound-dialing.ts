import type { PeerId } from '../api/api-config.ts';
import {
    computeInFlightDialAdmission,
    type InFlightDialAdmission
} from '../api/group-lifecycle/compute-in-flight-dial-admission.ts';
import { isPeerSetupStarted, type WebRtcConnectionService } from './web-rtc-connection-service.ts';
import type { WebRtcPeerOwnership } from './webrtc-group-manager-contracts.ts';
import { computeInFlightSetupCounts, type OutboundDialPlan } from './webrtc-outbound-dial-plan.ts';

export interface OutboundDialingInput {
    readonly rtcQBox: WebRtcConnectionService;
    readonly dialPlan: OutboundDialPlan;
    readonly ownership: WebRtcPeerOwnership;
}

export interface OutboundDialsStarted {
    readonly attemptCount: number;
    readonly failureCount: number;
    /** Desired peers that waited for a connection-budget slot. */
    readonly deferredCount: number;
    /** Desired peers that waited for an owner's in-flight slot (product decision 18). */
    readonly pacedCount: number;
}

type DialSlot = 'existing-connection' | 'new-connection';

/**
 * One reconcile pass's dials. Spends the connection budget and the in-flight
 * bound as dials start, on what each ensure actually did: a paced peer holds
 * no slot, and a dial that started nothing frees its slot for the next
 * candidate at once.
 */
export class WebRtcOutboundDialing {
    private readonly rtcQBox: WebRtcConnectionService;
    private readonly dialPlan: OutboundDialPlan;
    private readonly ownership: WebRtcPeerOwnership;
    private readonly inFlightSetupCounts: Map<string, number>;
    private newDialBudget: number;
    private readonly started = { attemptCount: 0, failureCount: 0, deferredCount: 0, pacedCount: 0 };

    constructor(input: OutboundDialingInput) {
        this.rtcQBox = input.rtcQBox;
        this.dialPlan = input.dialPlan;
        this.ownership = input.ownership;
        this.inFlightSetupCounts = computeInFlightSetupCounts(
            input.rtcQBox.inFlightPeerIds(),
            input.ownership.groupKeysByPeerId
        );
        this.newDialBudget = input.dialPlan.newDialBudget;
    }

    start(): OutboundDialsStarted {
        for (const peerId of this.dialPlan.livePeerIds) {
            this.ensureDesiredPeer(peerId);
        }
        for (const peerId of this.dialPlan.deadKnownPeerIds) {
            this.startDial(peerId, 'existing-connection');
        }
        for (const peerId of this.dialPlan.candidatePeerIds) {
            this.startDial(peerId, 'new-connection');
        }
        return { ...this.started };
    }

    private startDial(peerId: PeerId, slot: DialSlot): void {
        if (slot === 'new-connection' && this.newDialBudget === 0) {
            this.started.deferredCount += 1;
            return;
        }
        if (this.resolveDialAdmission(peerId) === 'wait') {
            this.started.pacedCount += 1;
            return;
        }
        if (this.ensureDesiredPeer(peerId) !== 'setup-started') {
            return;
        }
        if (slot === 'new-connection') {
            this.newDialBudget -= 1;
        }
        for (const groupKey of getOwnerGroupKeys(this.ownership, peerId)) {
            this.inFlightSetupCounts.set(groupKey, (this.inFlightSetupCounts.get(groupKey) ?? 0) + 1);
        }
    }

    private resolveDialAdmission(peerId: PeerId): InFlightDialAdmission {
        const owningGroupBudgets = getOwnerGroupKeys(this.ownership, peerId).map((groupKey) => ({
            inFlightSetupCount: this.inFlightSetupCounts.get(groupKey) ?? 0,
            maxConcurrentEdgeSetups: getGroupSetupBound(this.ownership, groupKey)
        }));
        return computeInFlightDialAdmission({ owningGroupBudgets });
    }

    private ensureDesiredPeer(
        peerId: PeerId
    ): WebRtcConnectionService.PeerConnectionEnsureOutcome | undefined {
        const connected = this.rtcQBox.ensurePeerConnectionStarted(peerId);
        if (isPeerSetupStarted(connected)) {
            this.started.attemptCount += 1;
        }
        if (connected.left) {
            this.started.failureCount += 1;
            if (connected.left.kind !== 'self' && connected.left.kind !== 'dial-denied') {
                console.error(
                    `Failed to connect peer ${peerId}. Owners=${
                        JSON.stringify(this.ownership.groupsByPeerId.get(peerId) ?? [])
                    }. Cause=${connected.left.kind}`,
                    connected.left.error
                );
            }
            return undefined;
        }
        return connected.right?.outcome;
    }
}

function getOwnerGroupKeys(ownership: WebRtcPeerOwnership, peerId: PeerId): readonly string[] {
    const groupKeys = ownership.groupKeysByPeerId.get(peerId);
    if (!groupKeys) {
        throw new Error(`Desired peer ${peerId} has no owning group`);
    }
    return groupKeys;
}

function getGroupSetupBound(ownership: WebRtcPeerOwnership, groupKey: string): number {
    const bound = ownership.maxConcurrentEdgeSetupsByGroupKey.get(groupKey);
    if (bound === undefined) {
        throw new Error(`Owning group ${groupKey} has no in-flight bound`);
    }
    return bound;
}

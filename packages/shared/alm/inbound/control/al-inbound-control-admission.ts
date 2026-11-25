import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALAckPayload, ALControlAcceptance } from '../../../al-contracts/al-control.ts';
import { decodeALControlMessage } from '../../../al-contracts/al-control.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { toExpireAtTimestampFromNow } from '../../ALStoreRetention.ts';
import { computeALVolatileControlRowExpiryMs } from '../../delivery/compute-al-volatile-control-row-expiry-ms.ts';
import { isALRelayedNackReason } from '../../delivery/is-al-relayed-nack-reason.ts';
import { resolveALDeliveryReceiptAlgo } from '../../delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundControlDecisionSurface,
    ALInboundMessageOwner
} from '../al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import { toALInboundPendingControlId } from '../al-inbound-pending-admission.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../al-inbound-runtime-diagnostics.ts';
import { toALDeliveryCarrier, toALInboundMessageOwnerKey } from '../al-inbound-source-validation.ts';
import { computeALInboundWorkEntry } from '../al-inbound-work-entry.ts';
import {
    signALInboundReceiptControls,
    type ALInboundReceiptProofs
} from '../receipt-proof/sign-al-inbound-receipt-controls.ts';
import type { ALInboundAcknowledgementEvidence } from './al-inbound-acknowledgement-evidence.ts';
import type { ALInboundControlSubject } from './al-inbound-control-rows.ts';
import {
    computeALInboundControlAdmission,
    toALInboundControlCommitBundle,
    type ALInboundControlAdmissionCandidate,
    type ALInboundControlAdmissionRead
} from './compute-al-inbound-control-admission.ts';
import {
    computeALInboundNackAdmission,
    computeALInboundUnheldGapNackAdmission,
    computeALInboundUnreceiptedGapNackAdmission,
    resolveALInboundGapNackTarget,
    toALInboundNackCommitBundle,
    type ALInboundGapNackRoute,
    type ALInboundNackAdmissionCandidate,
    type ALInboundNackAdmissionRead,
    type ALInboundUnheldGapNackAdmissionRead,
    type ALInboundUnreceiptedGapNackAdmissionRead
} from './compute-al-inbound-nack-admission.ts';
import { validateALInboundControlAdmission } from './validate-al-inbound-control-admission.ts';
import {
    validateALInboundNackAdmission,
    validateALInboundUnheldGapNackAdmission,
    validateALInboundUnreceiptedGapNackAdmission
} from './validate-al-inbound-nack-admission.ts';

/** The next hops a lane passes a copy of `msg` from `source` down to, as it would forward it were it new. */
export type ALInboundRetriedCopyNextHops = (
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source
) => readonly string[];

/**
 * The lane's retried-copy next hops: as its planner forwards a copy that is new, and only where it supplies
 * `forwardRetriedCopy`; `undefined` on any other lane.
 */
export function resolveALInboundRetriedCopyNextHops(
    lane: Pick<ALInboundMessageRuntime.Dependencies, 'forwardRetriedCopy' | 'planIncomingMessage' | 'clock'>
): ALInboundRetriedCopyNextHops | undefined {
    if (lane.forwardRetriedCopy === undefined) {
        return undefined;
    }
    return (msg, source) =>
        lane.planIncomingMessage(msg, source, { nowMs: lane.clock.nowMs() }).forwarding.nextHopPeerIds;
}

export interface ALInboundControlAdmissionDependencies {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly port: ALWorkQueuePort;
    readonly clock: ALInboundMessageRuntime.Clock;
    readonly newControlId: () => string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly receiptProofs: ALInboundReceiptProofs;
    readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
    /**
     * `undefined` on a lane that forwards no retried copy. Such a lane relays no gap NACK about a stored message it keeps
     * no row for: the repair that NACK asks for would reach no child through it (6c).
     */
    readonly planRetriedCopyNextHops: ALInboundRetriedCopyNextHops | undefined;
    /** `undefined` on a lane that relays no gap NACK about a message it holds nothing of (6d). */
    readonly readGapNackParent: ALInboundMessageRuntime.Dependencies['readGapNackParent'];
    readonly readUpstreamPeerId: ALInboundMessageRuntime.Dependencies['readUpstreamPeerId'];
    readonly readGapNackRelayHops: ALInboundMessageRuntime.Dependencies['readGapNackRelayHops'];
    readonly isLayoutChildPeer: ALInboundMessageRuntime.Dependencies['isLayoutChildPeer'];
}

/** A gap NACK the relay keeps no row for, by what the relay holds of the message it names. */
type ALInboundRowlessGapNack =
    | Readonly<{ kind: 'unreceipted'; read: ALInboundUnreceiptedGapNackAdmissionRead; }>
    | Readonly<{ kind: 'unheld'; read: ALInboundUnheldGapNackAdmissionRead; }>;

type ALInboundGapNack = ALInboundUnreceiptedGapNackAdmissionRead['nack'];

type ALInboundRowSurface = ALInboundControlDecisionSurface & { readonly owner: ALInboundMessageOwner; };

/** A child's NACK about a message whose row this relay holds, and what the message's room says of a gap NACK. */
interface ALInboundRowNack {
    readonly nack: ALInboundNackAdmissionRead['nack'];
    readonly surface: ALInboundRowSurface;
    readonly gapRoute: ALInboundGapNackRoute | undefined;
    readonly nowMs: number;
}

/** The message a child's gap NACK names, as this relay stores it, and whether the sender is its child in that room. */
interface ALInboundStoredGapNackMessage {
    readonly msg: ALMessage;
    readonly isLayoutChild: boolean;
}

export type ALInboundControlAdmissionResult =
    | Readonly<{ kind: 'not-handled'; }>
    | Readonly<{
        kind: 'committed';
        acceptance: ALControlAcceptance;
    }>
    | Readonly<{ kind: 'pending-control'; }>
    | Readonly<{ kind: 'rejected'; reason: string; }>
    /** The store could not persist the control, so it wrote nothing; an inline caller answers it not handled. */
    | ALInboundMessageRuntime.UnpersistedControl;

export interface ALInboundPendingControl {
    readonly kind: 'admit-control';
    readonly msg: ALMessage;
    /** The carrier the control arrived on: its acknowledgement is recorded, and its replay claimed, under it. */
    readonly carrier: ALDeliveryCarrier;
    readonly expiresAtMs: number;
}

type ALInboundControlArrival = Pick<ALInboundPendingControl, 'msg' | 'carrier'>;

/** What an admitted ACK or NACK commits, the acceptance it returns, and the admission clock its retention uses. */
interface ALInboundControlCommit {
    readonly bundle: ALInboundCommitBundle;
    readonly acceptance: ALControlAcceptance;
    readonly nowMs: number;
}

/** A replay that commits owes its caller the same acceptance the inline admission returned. */
export interface ALInboundControlReplayResult {
    readonly outcome: ALWorkOutcome;
    readonly acceptance: ALControlAcceptance | undefined;
    /**
     * The replay's own commit persisted work behind the page its batch read; nothing else announces it.
     * Every committed acknowledgement relays at least the recipient it names, so a commit always writes work.
     */
    readonly wroteWork: boolean;
}

/** One conditional admission per call; a conflict becomes retained work the inbound worker replays. */
export class ALInboundControlAdmission {
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly port: ALWorkQueuePort;
    private readonly clock: ALInboundMessageRuntime.Clock;
    private readonly newControlId: () => string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly receiptProofs: ALInboundReceiptProofs;
    private readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
    private readonly planRetriedCopyNextHops: ALInboundRetriedCopyNextHops | undefined;
    private readonly readGapNackParent: ALInboundMessageRuntime.Dependencies['readGapNackParent'];
    private readonly readUpstreamPeerId: ALInboundMessageRuntime.Dependencies['readUpstreamPeerId'];
    private readonly readGapNackRelayHops: ALInboundMessageRuntime.Dependencies['readGapNackRelayHops'];
    private readonly isLayoutChildPeer: ALInboundMessageRuntime.Dependencies['isLayoutChildPeer'];

    constructor(dependencies: ALInboundControlAdmissionDependencies) {
        this.admissionStore = dependencies.admissionStore;
        this.port = dependencies.port;
        this.clock = dependencies.clock;
        this.newControlId = dependencies.newControlId;
        this.retention = dependencies.retention;
        this.receiptProofs = dependencies.receiptProofs;
        this.diagnostics = dependencies.diagnostics;
        this.planRetriedCopyNextHops = dependencies.planRetriedCopyNextHops;
        this.readGapNackParent = dependencies.readGapNackParent;
        this.readUpstreamPeerId = dependencies.readUpstreamPeerId;
        this.readGapNackRelayHops = dependencies.readGapNackRelayHops;
        this.isLayoutChildPeer = dependencies.isLayoutChildPeer;
    }

    async admit(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        evidence?: ALInboundAcknowledgementEvidence
    ): Promise<ALInboundControlAdmissionResult> {
        return await this.admitArrival({ msg, carrier: toALDeliveryCarrier(source) }, evidence);
    }

    async replay(
        payload: ALInboundPendingControl,
        evidence?: ALInboundAcknowledgementEvidence
    ): Promise<ALInboundControlReplayResult> {
        if (payload.expiresAtMs <= this.clock.nowMs()) {
            evidence?.admissionResult('expired');
            return { outcome: { status: 'completed' }, acceptance: undefined, wroteWork: false };
        }
        const result = await this.admitArrival(payload, evidence);
        evidence?.admissionResult(result.kind);
        return {
            outcome: { status: result.kind === 'pending-control' ? 'retry' : 'completed' },
            acceptance: result.kind === 'committed' ? result.acceptance : undefined,
            wroteWork: result.kind === 'committed'
        };
    }

    /** A relay admits a child's ACK, and the NACKs it relays; every other control is its outbound owner's. */
    private async admitArrival(
        arrival: ALInboundControlArrival,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const control = decodeALControlMessage(arrival.msg).right;
        if (control?.type === 'ack') {
            return await this.admitAcknowledgement(arrival, { ...control.payload, carrier: arrival.carrier }, evidence);
        }
        return control?.type === 'nack' && isALRelayedNackReason(control.payload.reason)
            ? await this.admitRelayedNack(
                arrival,
                { ...control.payload, reason: control.payload.reason },
                evidence
            )
            : { kind: 'not-handled' };
    }

    private async admitAcknowledgement(
        arrival: ALInboundControlArrival,
        ack: ALAckPayload,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const nowMs = this.clock.nowMs();
        const read = await this.readControlAdmission(arrival, ack, nowMs);
        if (read === undefined) {
            return { kind: 'not-handled' };
        }
        const candidate = computeALInboundControlAdmission(read, this.retention);
        const issues = validateALInboundControlAdmission(candidate);
        evidence?.candidate(candidate, issues.length === 0);
        if (issues.length > 0) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        return await this.commitControlAdmission(arrival, {
            bundle: toALInboundControlCommitBundle(this.toStoreCandidate(candidate)),
            acceptance: candidate.acceptance,
            nowMs: candidate.read.nowMs
        }, evidence);
    }

    private async admitRelayedNack(
        arrival: ALInboundControlArrival,
        nack: ALInboundNackAdmissionRead['nack'],
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const nowMs = this.clock.nowMs();
        const indexed = await this.readDecisionSurface({ msgId: nack.msgId, fromPeerId: nack.fromPeerId });
        if (nack.reason === 'gap' && this.routesGapNack()) {
            return await this.admitGapNack(arrival, { nack: { ...nack, reason: 'gap' }, indexed, nowMs }, evidence);
        }
        return indexed === undefined
            ? { kind: 'not-handled' }
            : await this.admitRowNack(arrival, { nack, surface: indexed, gapRoute: undefined, nowMs }, evidence);
    }

    /** The lane relays a gap NACK without a row (6c, 6d), and so routes one by the message's room. */
    private routesGapNack(): boolean {
        return this.planRetriedCopyNextHops !== undefined || this.readGapNackParent !== undefined;
    }

    /**
     * A child's gap NACK: about a message this relay holds nothing of (6d); about one whose row waits on the sender or,
     * in the room's accepted layout, has the sender as its child; or about a stored message that asked for no receipt
     * (6c). The provenance row is read first, so a message without one costs no canonical read, and the stored message
     * once, for the room that decides the sender's place and this relay's upstream peer.
     */
    private async admitGapNack(
        arrival: ALInboundControlArrival,
        input: Readonly<{ nack: ALInboundGapNack; indexed: ALInboundRowSurface | undefined; nowMs: number; }>,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const { nack, indexed, nowMs } = input;
        const reference = { senderId: nack.originPeerId, msgId: nack.msgId };
        const owner = indexed?.owner ?? await this.admissionStore.readMessageProvenance(reference);
        if (owner === undefined) {
            const unheld = this.readUnheldGapNack(arrival, nack, nowMs);
            return unheld === undefined
                ? { kind: 'not-handled' }
                : await this.admitRowlessGapNack(arrival, { kind: 'unheld', read: unheld }, evidence);
        }
        const stored = await this.readStoredGapNackMessage(nack, nowMs);
        const surface = indexed ?? (stored?.isLayoutChild === true
            ? await this.readDecisionSurface({
                msgId: nack.msgId,
                fromPeerId: nack.fromPeerId,
                senderId: nack.originPeerId
            })
            : undefined);
        if (surface !== undefined) {
            const parentPeerId = surface.pendingAck?.toPeerId;
            const gapRoute = stored === undefined || parentPeerId === undefined
                ? undefined
                : this.readGapNackRoute(stored, nack, parentPeerId);
            return await this.admitRowNack(arrival, { nack, surface, gapRoute, nowMs }, evidence);
        }
        const unreceipted = stored === undefined
            ? undefined
            : this.readUnreceiptedGapNack(arrival, { nack, owner, stored, nowMs });
        return unreceipted === undefined
            ? { kind: 'not-handled' }
            : await this.admitRowlessGapNack(arrival, { kind: 'unreceipted', read: unreceipted }, evidence);
    }

    private async admitRowNack(
        arrival: ALInboundControlArrival,
        rowNack: ALInboundRowNack,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const { nack, surface, gapRoute, nowMs } = rowNack;
        const candidate = computeALInboundNackAdmission({
            namespace: this.admissionStore.namespace,
            nack,
            controlOwners: surface.controlOwners,
            owner: surface.owner,
            pending: surface.pendingAck,
            acks: surface.acks,
            nacks: surface.nacks,
            gapRoute,
            nowMs,
            controlMsgId: this.newControlId(),
            traceId: arrival.msg.id.traceId
        }, this.retention);
        const issues = validateALInboundNackAdmission(candidate);
        evidence?.candidate(candidate, issues.length === 0);
        if (issues.length > 0) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        return await this.commitControlAdmission(arrival, {
            bundle: toALInboundNackCommitBundle(this.toStoreCandidate(candidate)),
            acceptance: candidate.acceptance,
            nowMs
        }, evidence);
    }

    private async admitRowlessGapNack(
        arrival: ALInboundControlArrival,
        rowless: ALInboundRowlessGapNack,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const { read } = rowless;
        const [candidate, issues] = rowless.kind === 'unreceipted'
            ? [
                computeALInboundUnreceiptedGapNackAdmission(rowless.read, this.retention),
                validateALInboundUnreceiptedGapNackAdmission(rowless.read)
            ]
            : [
                computeALInboundUnheldGapNackAdmission(rowless.read, this.retention),
                validateALInboundUnheldGapNackAdmission(rowless.read)
            ];
        evidence?.candidate(candidate, issues.length === 0);
        if (issues.length > 0) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        return await this.commitControlAdmission(arrival, {
            bundle: toALInboundNackCommitBundle(this.toStoreCandidate(candidate)),
            acceptance: candidate.acceptance,
            nowMs: read.nowMs
        }, evidence);
    }

    /** A gap NACK about a message this relay holds nothing of, on a lane that names its parent for one (6d). */
    private readUnheldGapNack(
        arrival: ALInboundControlArrival,
        nack: ALInboundGapNack,
        nowMs: number
    ): ALInboundUnheldGapNackAdmissionRead | undefined {
        const parent = this.readGapNackParent?.(nack);
        return parent === undefined ? undefined : {
            namespace: this.admissionStore.namespace,
            nack,
            parent: parent.source,
            relayHops: parent.relayHops,
            nowMs,
            controlMsgId: this.newControlId(),
            traceId: arrival.msg.id.traceId
        };
    }

    /** The stored message a gap NACK names, read once; absent when the relay keeps no copy of it. */
    private async readStoredGapNackMessage(
        nack: ALInboundGapNack,
        nowMs: number
    ): Promise<ALInboundStoredGapNackMessage | undefined> {
        const stored = await this.admissionStore.readDeliverySurface(
            { senderId: nack.originPeerId, msgId: nack.msgId },
            nowMs
        );
        return stored === undefined
            ? undefined
            : { msg: stored.msg, isLayoutChild: this.isLayoutChildPeer(stored.msg, nack.fromPeerId) };
    }

    /**
     * What the message's room says of a child's gap NACK this relay knows the parent `knownParentPeerId` of (6d): its
     * grant reads the room's presence for the child and the peer the NACK goes to.
     */
    private readGapNackRoute(
        stored: ALInboundStoredGapNackMessage,
        nack: ALInboundGapNack,
        knownParentPeerId: string
    ): ALInboundGapNackRoute {
        const readUpstreamPeerId = this.readUpstreamPeerId(stored.msg);
        const upstreamPeerId = readUpstreamPeerId === nack.fromPeerId ? undefined : readUpstreamPeerId;
        const targetPeerId = resolveALInboundGapNackTarget(knownParentPeerId, { upstreamPeerId });
        return {
            isLayoutChild: stored.isLayoutChild,
            upstreamPeerId,
            relayHops: this.readGapNackRelayHops(stored.msg, [nack.fromPeerId, targetPeerId])
        };
    }

    /**
     * Its parent is this relay's current upstream peer, else the peer the message arrived from; its children the next
     * hops the lane passes a copy down to; absent for a message that asked for a receipt, or on a lane that passes no
     * copy down.
     */
    private readUnreceiptedGapNack(
        arrival: ALInboundControlArrival,
        held: Readonly<{
            nack: ALInboundGapNack;
            owner: ALInboundMessageOwner;
            stored: ALInboundStoredGapNackMessage;
            nowMs: number;
        }>
    ): ALInboundUnreceiptedGapNackAdmissionRead | undefined {
        const { nack, owner, stored, nowMs } = held;
        if (
            this.planRetriedCopyNextHops === undefined || owner.source.kind === 'trusted-server' ||
            resolveALDeliveryReceiptAlgo(stored.msg) !== 'none'
        ) {
            return undefined;
        }
        return {
            namespace: this.admissionStore.namespace,
            nack,
            msg: stored.msg,
            owner,
            arrivalPeerId: owner.source.peerId,
            route: this.readGapNackRoute(stored, nack, owner.source.peerId),
            childPeerIds: this.planRetriedCopyNextHops(stored.msg, owner.source),
            nowMs,
            controlMsgId: this.newControlId(),
            traceId: arrival.msg.id.traceId
        };
    }

    private async commitControlAdmission(
        arrival: ALInboundControlArrival,
        admitted: ALInboundControlCommit,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const signed = await signALInboundReceiptControls({
            bundle: admitted.bundle,
            namespace: this.admissionStore.namespace,
            receiptProofs: this.receiptProofs,
            signFailure: 'leave-out',
            diagnostics: this.diagnostics
        });
        evidence?.commit('pending');
        const status = await this.admissionStore.commitBundle(signed);
        evidence?.commit(status);
        if (status === 'committed') {
            return { kind: 'committed', acceptance: admitted.acceptance };
        }
        evidence?.retention('pending');
        await this.retainPendingControl(arrival, admitted.nowMs);
        evidence?.retention('returned');
        return { kind: 'pending-control' };
    }

    /**
     * The volatile pair keeps a message's ACK and NACK histories no longer than its deadline plus the receipt grace
     * (D74): the control-owner index that admits a control expires at the deadline, and a data copy past it is
     * refused expired. A relay row of a message that named no deadline carries none, so its history keeps the TTL.
     */
    private toStoreCandidate<C extends ALInboundControlAdmissionCandidate | ALInboundNackAdmissionCandidate>(
        candidate: C
    ): C {
        return {
            ...candidate,
            controlExpireAtTimestamp: computeALVolatileControlRowExpiryMs(
                candidate.controlExpireAtTimestamp,
                this.admissionStore.durability,
                candidate.read.pending?.expireAtTimestamp
            )
        };
    }

    private async retainPendingControl(arrival: ALInboundControlArrival, nowMs: number): Promise<void> {
        const expiresAtMs = toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs, nowMs);
        const work = computeALInboundWorkEntry({
            namespace: this.admissionStore.namespace,
            effectId: toALInboundPendingControlId(arrival.msg),
            payload: { kind: 'admit-control', msg: arrival.msg, carrier: arrival.carrier, expiresAtMs },
            observedAtMs: nowMs,
            expireAtTimestamp: expiresAtMs,
            carrier: arrival.carrier,
            signsForRecipient: false
        });
        await this.port.retainIfAbsent(work.entry);
    }

    /**
     * An acknowledgement whose peer owns no tracked message, or an ambiguous one, is not handled. The ACKs it relays
     * carry the trace of the acknowledgement they relay, which names the acknowledged message's trace.
     */
    private async readControlAdmission(
        arrival: ALInboundControlArrival,
        ack: ALAckPayload,
        nowMs: number
    ): Promise<ALInboundControlAdmissionRead | undefined> {
        const surface = await this.readDecisionSurface({ msgId: ack.ackedMsgId, fromPeerId: ack.fromPeerId });
        return surface === undefined ? undefined : {
            namespace: this.admissionStore.namespace,
            ack,
            controlOwners: surface.controlOwners,
            owner: surface.owner,
            pending: surface.pendingAck,
            acks: surface.acks,
            nacks: surface.nacks,
            nowMs,
            controlMsgId: this.newControlId(),
            traceId: arrival.msg.id.traceId
        };
    }

    /** The surface of a child's control: none for a peer that owes no tracked message, never one without provenance. */
    private async readDecisionSurface(subject: ALInboundControlSubject): Promise<ALInboundRowSurface | undefined> {
        const surface = await this.admissionStore.readControlDecisionSurface(subject);
        if (surface === undefined) {
            return undefined;
        }
        if (surface.messageOwner === undefined) {
            throw new ALAdmissionCorruptionError(
                toALInboundMessageOwnerKey(this.admissionStore.namespace, subject.msgId, surface.senderId),
                new TypeError('Retained inbound acknowledgement state has no message provenance')
            );
        }
        return { ...surface, owner: surface.messageOwner };
    }
}

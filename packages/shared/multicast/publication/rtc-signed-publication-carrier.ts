import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALAckAlgo, ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { assertALPublicationProofSigningInputKept } from '../../al-contracts/publication-proof/al-publication-proof.ts';
import type { ALDeliveryRefusalReason } from '../../alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import type { ReadableKeyedValues } from '../../cache/RepositoryInterfaces.ts';
import { Either } from '../../resilience/Either.ts';
import type { PublicationCrypto } from '../../signature/publication-crypto.ts';
import { readRtcGroupSnapshotByRef } from '../read-rtc-outbound-observation.ts';
import {
    toRtcPublicationHandlingPlan,
    type RtcRoomSnapshotAdmission
} from '../room-authority/rtc-room-snapshot-admission.ts';
import { computeRtcFrozenAudienceRefusal, isRtcUnfrozenRoomMessage } from '../web-rtc-overlay-frozen-audience.ts';
import { computeGrantedSubscribeHolders } from './compute-granted-subscribe-holders.ts';
import {
    computeRtcGrantedPublicationRefusal,
    resolveRtcGrantedAddresseeRefusal,
    resolveRtcGrantedLeaderRefusal,
    resolveRtcGrantedPublicationShapeRefusal,
    RTC_GRANTED_PUBLICATION_REFUSALS,
    toRtcOriginShapeRefusal,
    type RtcGrantedPublicationRefusalInput
} from './compute-rtc-granted-publication-refusal.ts';
import { computeRtcPublicationAdmission } from './compute-rtc-publication-admission.ts';
import { computeRtcRepairRefusal, type RtcRepairRefusal } from './compute-rtc-repair-refusal.ts';
import { computeRtcRepairTargetAdmission } from './compute-rtc-repair-target-admission.ts';
import { isRtcPublisherProofRequired, resolveRtcReceiptedRoomShapeRefusal } from './is-rtc-publisher-proof-required.ts';
import type { RtcGrantedTopicReader } from './rtc-granted-topic-reader.ts';
import type { RtcPublicationProofVerifierPort } from './rtc-publication-proof-verifier-port.ts';
import type { RtcTopicSubscriptionReader } from './rtc-topic-subscription-reader.ts';
import {
    resolveRtcPublicationSigningRefusal,
    signRtcPublication,
    type RtcPublicationSigningFailure
} from './sign-rtc-publication.ts';
import { toRtcGrantedListedLeg } from './to-rtc-granted-listed-leg.ts';

export namespace RtcSignedPublicationCarrier {
    /**
     * Why a granted leg is refused before admission. `unsupported`: RTC cannot carry it as it was asked, which a
     * fallback carrier takes over. `unauthorized`: the origin's judgement, from its cached snapshot, that the addressee
     * of a `receiver` unicast may not receive it; the leg decides whether a fallback carrier may ask its server instead.
     */
    export interface LegRefusal {
        readonly reason: Extract<ALDeliveryRefusalReason, 'unsupported' | 'unauthorized'>;
        readonly detail: string;
    }

    export interface Dependencies {
        readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
        /** Which topics are granted: who may publish and subscribe on one, and that its frames are carried signed. */
        readonly grantedTopics: RtcGrantedTopicReader;
        readonly publicationCrypto: PublicationCrypto;
        /** A frame that must carry a proof is forwarded or delivered only once this page's verifier verified it. */
        readonly publicationVerifier: RtcPublicationProofVerifierPort;
        /** A granted frame is delivered only while this tab's token for its room and topic is active. */
        readonly topicSubscriptions: RtcTopicSubscriptionReader;
        /** The session's principal (its clientId), whose subscribe grant a granted frame's delivery reads. */
        readonly selfPrincipalId: string;
        readonly selfSessionId: string;
        /** The clock an origin reads its own session's lease by when it signs. */
        readonly clock: ALOutboundMessageRuntime.Clock;
    }

    /** Whether a repair may serve `peerId` under the receipt the repair tracks. */
    export type RepairTargetAdmission = (peerId: string, receiptMode: ALAckAlgo) => boolean;

    /** One incoming frame as its room judged it: the plan before the room's refusal, and the plan after it. */
    export interface IncomingPlanInput {
        readonly msg: ALMessage;
        readonly fromPeerId: string | undefined;
        readonly snapshot: GroupSnapshot | undefined;
        readonly admission: RtcRoomSnapshotAdmission;
        readonly plan: ALMessageHandlingPlan;
        readonly roomPlan: ALMessageHandlingPlan;
        readonly nowMs: number;
    }
}

/**
 * The RTC carrier's signed frames: granted publications, and room sends that ask a `receiver` or `leader` receipt
 * (`isRtcPublisherProofRequired`). An origin admits one as a leg and signs it in the first dispatch that holds its
 * frozen audience and its room snapshot, and a relay or receiver verifies its proof before it plans it, forwarding or
 * delivering only an admitted frame. Only a granted publication also answers to its topic's grants.
 */
export class RtcSignedPublicationCarrier {
    readonly #dependencies: Omit<RtcSignedPublicationCarrier.Dependencies, 'publicationCrypto'>;
    /** An ES private field: the advanced middleware hands app code the manager owning this carrier, never the page key. */
    readonly #publicationCrypto: PublicationCrypto;

    constructor({ publicationCrypto, ...dependencies }: RtcSignedPublicationCarrier.Dependencies) {
        this.#dependencies = dependencies;
        this.#publicationCrypto = publicationCrypto;
    }

    /** By topic, whatever the target: a granted topic's frame naming no room is still judged, and refused unbound. */
    isGrantedPublication(msg: ALMessage): boolean {
        return this.#dependencies.grantedTopics.isGrantedTopic(readALTargetGroupRef(msg), msg.route.topicId);
    }

    /** Whether RTC carries the frame only with its origin's proof: a granted publication, or a receipted room send. */
    isProofRequired(msg: ALMessage): boolean {
        return isRtcPublisherProofRequired({ message: msg, topicGranted: this.isGrantedPublication(msg) });
    }

    /**
     * A granted leg -- a room multicast, a listed or principal room broadcast, or a room unicast -- is
     * refused for the shape its sender gave before any freezing work, then for a `group-leader` leg whose leader holds
     * no `subscribe`, then when its origin cannot sign at all, then as unauthorized for a `receiver` unicast to its
     * own sender or to a session that holds no `subscribe`; else a unicast is listed as a broadcast of one and the
     * leg is frozen to the live sessions whose principal holds `subscribe` on its topic as `toAdmittedMessage` carries
     * it, then refused when that frozen audience passes the RTC room limit. Its admission signs that narrowed audience
     * (`signAdmitted`).
     */
    admitLeg(
        msg: ALMessage,
        toAdmittedMessage: (msg: ALMessage, subscribeHolders: ReadonlySet<string>) => ALMessage
    ): Either<RtcSignedPublicationCarrier.LegRefusal, ALMessage> {
        const shapeRefusal = resolveRtcGrantedPublicationShapeRefusal(msg);
        if (shapeRefusal !== undefined) {
            return Either.ofLeft({ reason: 'unsupported', detail: shapeRefusal });
        }
        const snapshot = this.readRoomSnapshot(msg);
        const nowEpochMs = this.#dependencies.clock.nowMs();
        const subscribeHolders = snapshot === null
            ? new Set<string>()
            : computeGrantedSubscribeHolders(snapshot, msg.route.topicId, nowEpochMs);
        const { selfSessionId } = this.#dependencies;
        const leaderRefusal = resolveRtcGrantedLeaderRefusal({ msg, snapshot, selfSessionId, subscribeHolders });
        if (leaderRefusal !== undefined) {
            return Either.ofLeft({ reason: 'unsupported', detail: leaderRefusal });
        }
        const signingRefusal = resolveRtcPublicationSigningRefusal({
            crypto: this.#publicationCrypto,
            snapshot,
            selfSessionId,
            nowEpochMs
        });
        if (signingRefusal !== undefined) {
            return Either.ofLeft({ reason: 'unsupported', detail: toRtcGrantedLegRefusalDetail(signingRefusal) });
        }
        const addresseeRefusal = resolveRtcGrantedAddresseeRefusal({ msg, selfSessionId, subscribeHolders });
        if (addresseeRefusal !== undefined) {
            return Either.ofLeft({ reason: 'unauthorized', detail: addresseeRefusal });
        }
        const admitted = toAdmittedMessage(toRtcGrantedListedLeg(msg), subscribeHolders);
        return computeRtcFrozenAudienceRefusal(admitted, msg).fold(
            (refusal) => Either.ofLeft({ reason: 'unsupported', detail: refusal.dropReason ?? '' }),
            () => Either.ofRight(admitted)
        );
    }

    /**
     * Signs the session's own frame that must carry a proof and carries none yet, as the dispatch that admits or first
     * freezes it carries it, after the read stamped its sequence and record. Any other frame passes as it is: one that
     * needs no proof, one already signed, a relayed one that keeps its origin's proof, and a receipted room send still
     * held unfrozen, which the dequeue that freezes it signs. Left: why it could not sign, which drops it `unsupported`.
     */
    async signAdmitted(msg: ALMessage): Promise<Either<string, ALMessage>> {
        const { selfSessionId, clock } = this.#dependencies;
        if (msg.proof !== undefined || msg.id.senderId !== selfSessionId || !this.isSignableNow(msg)) {
            return Either.ofRight(msg);
        }
        const signed = await signRtcPublication({
            crypto: this.#publicationCrypto,
            snapshot: this.readRoomSnapshot(msg),
            selfSessionId,
            nowEpochMs: clock.nowMs(),
            message: msg
        });
        return signed.mapLeft(toRtcGrantedLegRefusalDetail);
    }

    /**
     * A granted frame its leg froze is signed at once. A receipted room send is signed by the dispatch that holds both
     * its frozen audience and the room snapshot that attests the key; until then it is held unsigned, as a send without
     * its room snapshot is held (D585), and never sent.
     */
    private isSignableNow(msg: ALMessage): boolean {
        return this.isGrantedPublication(msg) ||
            (this.isProofRequired(msg) && !isRtcUnfrozenRoomMessage(msg) && this.readRoomSnapshot(msg) !== null);
    }

    /**
     * A repair of a granted publication: the origin serves its own only while it holds `publish`, and a repair serves
     * only targets the responder still admits; `plan` reads the same admission for the recipients it retries. A refused
     * requester gets no copy, never a widened one. Any other repair is planned as it is.
     */
    planRepair(
        msg: ALMessage,
        request: ALOutboundRepairRequest,
        plan: (isTargetAdmitted: RtcSignedPublicationCarrier.RepairTargetAdmission) => RtcRepairPlan
    ): RtcRepairPlan {
        const isTargetAdmitted: RtcSignedPublicationCarrier.RepairTargetAdmission = (peerId, receiptMode) =>
            this.isRepairTargetAdmitted({ msg, targetPeerId: peerId, receiptMode });
        return this.readOwnRepairRefusal(msg).fold(
            (refusal) => refusal,
            () => toRequesterAdmittedPlan(plan(isTargetAdmitted), request, isTargetAdmitted)
        );
    }

    /**
     * The origin re-sends its own stored granted publication only while its snapshot still grants it `publish` (S3-R8).
     * Any other message, and a snapshot that attests nothing, passes to the room-authority planning. Left: the drop the
     * re-send is planned as, which ends its handle as the dispatch's own refusal does.
     */
    private readOwnRepairRefusal(
        msg: ALMessage
    ): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
        const { selfSessionId, selfPrincipalId, clock } = this.#dependencies;
        if (msg.id.senderId !== selfSessionId || !this.isGrantedPublication(msg)) {
            return Either.ofRight(msg);
        }
        const refusal = computeRtcRepairRefusal({
            snapshot: this.readRoomSnapshot(msg),
            selfPrincipalId,
            topicId: msg.route.topicId,
            nowEpochMs: clock.nowMs()
        });
        return refusal === undefined ? Either.ofRight(msg) : Either.ofLeft(toRtcRepairRefusalPlan(msg, refusal));
    }

    private isRepairTargetAdmitted(input: RtcRepairTargetInput): boolean {
        const { msg } = input;
        if (!this.isGrantedPublication(msg)) {
            return true;
        }
        return computeRtcRepairTargetAdmission({
            snapshot: this.readRoomSnapshot(msg),
            frozenRecipientPeerIds: resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds ?? [],
            targetPeerId: input.targetPeerId,
            topicId: msg.route.topicId,
            receiptMode: input.receiptMode,
            nowEpochMs: this.#dependencies.clock.nowMs()
        }).fold(() => false, () => true);
    }

    /**
     * Awaited on each message object before it is planned, so the planner reads the verdict of a frame that must carry
     * a proof synchronously; any other frame costs no verify and carries no verdict the planner reads.
     */
    async verifyPublicationProof(msg: ALMessage): Promise<boolean> {
        return this.isProofRequired(msg) &&
            await this.#dependencies.publicationVerifier.verifyPublicationProof(msg, this.#dependencies.clock);
    }

    /**
     * A frame its room refused keeps the room's refusal. A frame that must carry a proof, and a proof on a frame that
     * needs none, is judged by the publication admission on a plan its room authorized, or with no readable snapshot (a
     * granted frame then fails closed, while a receipted room send keeps its room's not-yet-in-sync hold; a proof that
     * is not needed is held while the page's snapshot is behind the frame's and refused once it is not). Any other
     * frame keeps its room plan.
     */
    planIncomingPublication(input: RtcSignedPublicationCarrier.IncomingPlanInput): ALMessageHandlingPlan {
        const { msg, snapshot, admission } = input;
        const topicGranted = this.isGrantedPublication(msg);
        const proofRequired = isRtcPublisherProofRequired({ message: msg, topicGranted });
        if (keepsRoomPlan({ msg, snapshot, admission, topicGranted, proofRequired })) {
            return input.roomPlan;
        }
        const groupRef = readALTargetGroupRef(msg);
        const { publicationVerifier, topicSubscriptions, selfPrincipalId } = this.#dependencies;
        return toRtcPublicationHandlingPlan(
            admission.kind === 'authorized' ? input.roomPlan : input.plan,
            computeRtcPublicationAdmission({
                message: msg,
                topicGranted,
                proofRequired,
                snapshot: snapshot ?? null,
                selfPrincipalId,
                signatureValid: publicationVerifier.getVerifiedSignature(msg),
                ownSubscriptionActive: groupRef !== undefined &&
                    topicSubscriptions.isSubscriptionActive(groupRef, msg.route.topicId),
                frozenRecipient: admission.kind === 'authorized' && admission.deliversLocally,
                nowEpochMs: input.nowMs
            }),
            input.fromPeerId
        );
    }

    /** A programmer invariant: a plan that carries a signed message keeps every field its origin signed. */
    assertSignedPlanKept(original: ALMessage, planned: ALOutboundDispatchPlan<ALOutboundTransportMessage>): void {
        if (original.proof !== undefined && planned.dropReasonCode === undefined) {
            assertALPublicationProofSigningInputKept(original, planned.msg);
        }
    }

    private readRoomSnapshot(msg: ALMessage): GroupSnapshot | null {
        const groupRef = readALTargetGroupRef(msg);
        return (groupRef && readRtcGroupSnapshotByRef(this.#dependencies.groupCache, groupRef)) ?? null;
    }

    /**
     * The origin carries a granted publication only as a room multicast, a listed or principal room broadcast, or a
     * room unicast, re-sends a stored one only signed, only as the multicast its leg admission froze and only while it
     * holds `publish`. A receipted room broadcast it never freezes, one naming only its exclusions, is refused as
     * unsupported, since it could never be signed (D756); any other message passes.
     */
    computeOriginRefusal(
        input: RtcGrantedPublicationRefusalInput
    ): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
        const { carried } = input;
        if (!this.isGrantedPublication(carried)) {
            return toRtcOriginShapeRefusal(
                carried,
                input.original,
                resolveRtcReceiptedRoomShapeRefusal(input.original)
            );
        }
        return computeRtcGrantedPublicationRefusal(input).flatMap(
            (refusal) => Either.ofLeft(refusal),
            (signed) => input.storedSend ? this.readOwnRepairRefusal(signed) : Either.ofRight(signed)
        );
    }
}

interface RoomPlanKeepingInput {
    readonly msg: ALMessage;
    readonly snapshot: GroupSnapshot | undefined;
    readonly admission: RtcRoomSnapshotAdmission;
    readonly topicGranted: boolean;
    readonly proofRequired: boolean;
}

/**
 * The room's plan stands for a frame that neither needs nor carries a proof, for one its readable room refused, and
 * for a receipted room send with no readable snapshot, which the room holds not yet in sync until it can judge the key.
 */
function keepsRoomPlan(input: RoomPlanKeepingInput): boolean {
    const { snapshot, proofRequired } = input;
    if (!proofRequired && input.msg.proof === undefined) {
        return true;
    }
    return snapshot === undefined ? proofRequired && !input.topicGranted : input.admission.kind !== 'authorized';
}

/** A signing failure names its kind first. */
function toRtcGrantedLegRefusalDetail(failure: RtcPublicationSigningFailure): string {
    return `${failure.kind}: ${failure.message}`;
}

/** A repair plan, or none when nothing is owed. */
type RtcRepairPlan = ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined;

interface RtcRepairTargetInput {
    readonly msg: ALMessage;
    readonly targetPeerId: string;
    readonly receiptMode: ALAckAlgo;
}

/**
 * A requester-targeted repair serves its requester only while the responder admits, under the receipt it tracks, the
 * recipient it is for: the requester itself, or the recipient below a relay that asked for it (S4ii-R3). The copy
 * still goes to the requester; checking the recipient keeps a relay's repair to the audience its origin froze.
 */
function toRequesterAdmittedPlan(
    planned: RtcRepairPlan,
    request: ALOutboundRepairRequest,
    isTargetAdmitted: RtcSignedPublicationCarrier.RepairTargetAdmission
): RtcRepairPlan {
    const { requestedByPeerId, logicalRecipientPeerId } = request;
    return planned === undefined || requestedByPeerId === undefined ||
            isTargetAdmitted(logicalRecipientPeerId ?? requestedByPeerId, planned.ackTracking?.mode ?? 'none')
        ? planned
        : undefined;
}

function toRtcRepairRefusalPlan(
    msg: ALMessage,
    refusal: RtcRepairRefusal
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    return {
        msg,
        dropReason: `${RTC_GRANTED_PUBLICATION_REFUSALS.revokedPublisher} (${refusal.kind})`,
        dropReasonCode: 'no-publish-grant',
        lane: 'volatile',
        preparedMessages: []
    };
}

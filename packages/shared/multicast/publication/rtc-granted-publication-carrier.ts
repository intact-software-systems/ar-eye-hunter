import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALAckAlgo, ALMessageHandlingPlan, ALQosEffectivePolicy } from '../../al-contracts/al-policy.ts';
import { assertALPublicationProofSigningInputKept } from '../../al-contracts/publication-proof/al-publication-proof.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '../../alm/outbound/to-al-outbound-message.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import type { ReadableKeyedValues } from '../../cache/RepositoryInterfaces.ts';
import { Either } from '../../resilience/Either.ts';
import type { PublicationCrypto } from '../../signature/publication-crypto.ts';
import { readRtcGroupSnapshotByRef } from '../read-rtc-outbound-observation.ts';
import { toRtcPublicationHandlingPlan, type RtcRoomSnapshotAdmission } from '../rtc-room-snapshot-admission.ts';
import { toRtcOutboundMessage } from '../to-rtc-outbound-message.ts';
import { computeGrantedSubscribeHolders } from './compute-granted-subscribe-holders.ts';
import {
    computeRtcGrantedPublicationRefusal,
    resolveRtcGrantedLeaderRefusal,
    resolveRtcGrantedPublicationShapeRefusal,
    RTC_GRANTED_PUBLICATION_REFUSALS
} from './compute-rtc-granted-publication-refusal.ts';
import { computeRtcPublicationAdmission } from './compute-rtc-publication-admission.ts';
import { computeRtcRepairRefusal, type RtcRepairRefusal } from './compute-rtc-repair-refusal.ts';
import { computeRtcRepairTargetAdmission } from './compute-rtc-repair-target-admission.ts';
import type { RtcGrantedTopicReader } from './rtc-granted-topic-reader.ts';
import type { RtcPublicationProofVerifierPort } from './rtc-publication-proof-verifier-port.ts';
import type { RtcTopicSubscriptionReader } from './rtc-topic-subscription-reader.ts';
import { signRtcPublication, type RtcPublicationSigningFailure } from './sign-rtc-publication.ts';

/**
 * Why a granted leg is not signed: a shape RTC cannot carry (not a room multicast), or its origin could not sign it.
 */
type RtcGrantedLegRefusal = Readonly<{ kind: 'unsupported-shape'; message: string; }> | RtcPublicationSigningFailure;

export namespace RtcGrantedPublicationCarrier {
    export interface Dependencies {
        readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
        /** A publication on a granted topic is carried only signed by the page's key. */
        readonly grantedTopics: RtcGrantedTopicReader;
        readonly publicationCrypto: PublicationCrypto;
        /** A granted frame is forwarded or delivered only once this page's own verifier verified its proof. */
        readonly publicationVerifier: RtcPublicationProofVerifierPort;
        /** A granted frame is delivered only while this tab's token for its room and topic is active. */
        readonly topicSubscriptions: RtcTopicSubscriptionReader;
        /** The session's principal (its clientId), whose subscribe grant a granted frame's delivery reads. */
        readonly selfPrincipalId: string;
        readonly selfSessionId: string;
        /** The clock an origin reads its own session's lease by when it signs. */
        readonly clock: ALOutboundMessageRuntime.Clock;
    }

    /** The message an origin carries, the one its sender gave, and whether the plan re-sends a stored copy. */
    export interface OriginRefusalInput {
        readonly carried: ALMessage;
        readonly original: ALMessage;
        /** A re-plan or dequeue of a stored own message, which re-reads the origin's `publish` (S3-R8). */
        readonly storedSend: boolean;
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
 * The RTC carrier's granted publications: an origin signs one as its admission carries it, and a relay or receiver
 * verifies its proof before it plans it, forwarding or delivering only an admitted frame.
 */
export class RtcGrantedPublicationCarrier {
    readonly #dependencies: Omit<RtcGrantedPublicationCarrier.Dependencies, 'publicationCrypto'>;
    /** An ES private field: the advanced middleware hands app code the manager owning this carrier, never the page key. */
    readonly #publicationCrypto: PublicationCrypto;

    constructor({ publicationCrypto, ...dependencies }: RtcGrantedPublicationCarrier.Dependencies) {
        this.#dependencies = dependencies;
        this.#publicationCrypto = publicationCrypto;
    }

    /** By topic, whatever the target: a granted topic's frame naming no room is still judged, and refused unbound. */
    isGrantedPublication(msg: ALMessage): boolean {
        return this.#dependencies.grantedTopics.isGrantedTopic(readALTargetGroupRef(msg), msg.route.topicId);
    }

    /**
     * A granted leg is refused for the shape its sender gave before any freezing or signing work, else frozen to the
     * live sessions whose principal holds `subscribe` on its topic and signed as `toAdmittedMessage` carries it: the
     * signed audience is already the narrowed one. A `group-leader` leg whose leader holds no `subscribe` is refused
     * before freezing. Left: the refusal's detail, which a fallback carrier takes over.
     */
    async signLeg(
        msg: ALMessage,
        toAdmittedMessage: (msg: ALMessage, subscribeHolders: ReadonlySet<string>) => ALMessage
    ): Promise<Either<string, ALMessage>> {
        const shapeRefusal = resolveRtcGrantedPublicationShapeRefusal(msg);
        if (shapeRefusal !== undefined) {
            return Either.ofLeft(toRtcGrantedLegRefusalDetail({ kind: 'unsupported-shape', message: shapeRefusal }));
        }
        const snapshot = this.readRoomSnapshot(msg);
        const nowEpochMs = this.#dependencies.clock.nowMs();
        const subscribeHolders = snapshot === null
            ? new Set<string>()
            : computeGrantedSubscribeHolders(snapshot, msg.route.topicId, nowEpochMs);
        const leaderRefusal = resolveRtcGrantedLeaderRefusal({
            msg,
            snapshot,
            selfSessionId: this.#dependencies.selfSessionId,
            subscribeHolders
        });
        if (leaderRefusal !== undefined) {
            return Either.ofLeft(leaderRefusal);
        }
        const admitted = toAdmittedMessage(msg, subscribeHolders);
        const signed = await signRtcPublication({
            crypto: this.#publicationCrypto,
            snapshot,
            selfSessionId: this.#dependencies.selfSessionId,
            nowEpochMs,
            message: admitted
        });
        return signed.mapLeft(toRtcGrantedLegRefusalDetail);
    }

    /**
     * A repair of a granted publication: the origin serves its own only while it holds `publish`, and a repair serves
     * only targets the responder still admits; `plan` reads the same admission for the recipients it retries. A refused
     * requester gets no copy, never a widened one. Any other repair is planned as it is.
     */
    planRepair(
        msg: ALMessage,
        request: ALOutboundRepairRequest,
        plan: (isTargetAdmitted: RtcGrantedPublicationCarrier.RepairTargetAdmission) => RtcRepairPlan
    ): RtcRepairPlan {
        const isTargetAdmitted: RtcGrantedPublicationCarrier.RepairTargetAdmission = (peerId, receiptMode) =>
            this.isRepairTargetAdmitted({ msg, targetPeerId: peerId, receiptMode });
        return this.readOwnRepairRefusal(msg).fold(
            (refusal) => refusal,
            () => toRequesterAdmittedPlan(plan(isTargetAdmitted), request.requestedByPeerId, isTargetAdmitted)
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
     * Awaited on each message object before it is planned, so the planner reads a granted frame's verdict
     * synchronously; any other frame carries no verdict the planner reads.
     */
    async verifyPublicationProof(msg: ALMessage): Promise<boolean> {
        return this.isGrantedPublication(msg) &&
            await this.#dependencies.publicationVerifier.verifyPublicationProof(msg);
    }

    /**
     * A frame its room refused keeps the room's refusal, granted or not. A granted frame, and a proof on an ungranted
     * topic, is judged by the publication admission on a plan its room authorized, or with no readable snapshot (a
     * granted frame then fails closed; an ungranted proof is held while the page's snapshot is behind the frame's and
     * refused once it is not). Any other frame keeps its room plan.
     */
    planIncomingPublication(input: RtcGrantedPublicationCarrier.IncomingPlanInput): ALMessageHandlingPlan {
        const { msg, snapshot, admission } = input;
        const topicGranted = this.isGrantedPublication(msg);
        if ((!topicGranted && msg.proof === undefined) || (snapshot !== undefined && admission.kind !== 'authorized')) {
            return input.roomPlan;
        }
        const groupRef = readALTargetGroupRef(msg);
        const { publicationVerifier, topicSubscriptions, selfPrincipalId } = this.#dependencies;
        return toRtcPublicationHandlingPlan(
            admission.kind === 'authorized' ? input.roomPlan : input.plan,
            computeRtcPublicationAdmission({
                message: msg,
                topicGranted,
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

    /** Only a granted frame, which its incoming plan verified, keeps its signed fields; any other is normalized. */
    toForwardedMessage(msg: ALMessage, effective: ALQosEffectivePolicy): ALMessage {
        return this.isGrantedPublication(msg)
            ? toRtcOutboundMessage(msg, effective)
            : toALOutboundMessage(msg, effective);
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
     * The origin carries a granted publication only in the shape it signed, and re-sends a stored one only while it
     * holds `publish`; any other message passes.
     */
    computeOriginRefusal(
        input: RtcGrantedPublicationCarrier.OriginRefusalInput
    ): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
        const { carried } = input;
        if (!this.isGrantedPublication(carried)) {
            return Either.ofRight(carried);
        }
        return computeRtcGrantedPublicationRefusal(carried, input.original).flatMap(
            (refusal) => Either.ofLeft(refusal),
            (signed) => input.storedSend ? this.readOwnRepairRefusal(signed) : Either.ofRight(signed)
        );
    }
}

/** A shape refusal reads as its own text; a signing failure names its kind first. */
function toRtcGrantedLegRefusalDetail(refusal: RtcGrantedLegRefusal): string {
    return refusal.kind === 'unsupported-shape' ? refusal.message : `${refusal.kind}: ${refusal.message}`;
}

/** A repair plan, or none when nothing is owed. */
type RtcRepairPlan = ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined;

interface RtcRepairTargetInput {
    readonly msg: ALMessage;
    readonly targetPeerId: string;
    readonly receiptMode: ALAckAlgo;
}

/** A requester-targeted repair serves its requester only while the responder admits it under the receipt it tracks. */
function toRequesterAdmittedPlan(
    planned: RtcRepairPlan,
    requesterPeerId: string | undefined,
    isTargetAdmitted: RtcGrantedPublicationCarrier.RepairTargetAdmission
): RtcRepairPlan {
    return planned === undefined || requesterPeerId === undefined ||
            isTargetAdmitted(requesterPeerId, planned.ackTracking?.mode ?? 'none')
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

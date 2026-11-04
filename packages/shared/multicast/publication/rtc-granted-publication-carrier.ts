import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan, ALQosEffectivePolicy } from '../../al-contracts/al-policy.ts';
import { assertALPublicationProofSigningInputKept } from '../../al-contracts/publication-proof/al-publication-proof.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime
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
    resolveRtcGrantedPublicationShapeRefusal
} from './compute-rtc-granted-publication-refusal.ts';
import { computeRtcPublicationAdmission } from './compute-rtc-publication-admission.ts';
import type { RtcGrantedTopicReader } from './rtc-granted-topic-reader.ts';
import type { RtcPublicationProofVerifierPort } from './rtc-publication-proof-verifier-port.ts';
import type { RtcTopicSubscriptionReader } from './rtc-topic-subscription-reader.ts';
import { signRtcPublication, type RtcPublicationSigningFailure } from './sign-rtc-publication.ts';

/** Why a granted leg is not signed: a shape RTC cannot carry (not a room multicast), or its origin could not sign it. */
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
        const groupRef = readALTargetGroupRef(msg);
        const snapshot = (groupRef && readRtcGroupSnapshotByRef(this.#dependencies.groupCache, groupRef)) ?? null;
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

    /** The origin carries a granted publication only in the shape it signed; any other message passes. */
    computeOriginRefusal(
        carried: ALMessage,
        original: ALMessage
    ): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
        return this.isGrantedPublication(carried)
            ? computeRtcGrantedPublicationRefusal(carried, original)
            : Either.ofRight(carried);
    }
}

/** A shape refusal reads as its own text; a signing failure names its kind first. */
function toRtcGrantedLegRefusalDetail(refusal: RtcGrantedLegRefusal): string {
    return refusal.kind === 'unsupported-shape' ? refusal.message : `${refusal.kind}: ${refusal.message}`;
}

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
import {
    computeRtcGrantedPublicationRefusal,
    resolveRtcGrantedPublicationShapeRefusal
} from './compute-rtc-granted-publication-refusal.ts';
import { computeRtcPublicationAdmission } from './compute-rtc-publication-admission.ts';
import type { RtcGrantedTopicReader } from './rtc-granted-topic-reader.ts';
import type { RtcPublicationProofVerifierPort } from './rtc-publication-proof-verifier-port.ts';
import type { RtcTopicSubscriptionReader } from './rtc-topic-subscription-reader.ts';
import { signRtcPublication, type RtcPublicationSigningFailure } from './sign-rtc-publication.ts';

/** Why a granted leg is not carried: a shape RTC cannot carry, or its origin could not sign it. */
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
     * A granted leg is refused for the shape its sender gave before any freezing or signing work, else signed as
     * `toAdmittedMessage` carries it. Left: the refusal's detail, which a fallback carrier takes over.
     */
    async signLeg(
        msg: ALMessage,
        toAdmittedMessage: (msg: ALMessage) => ALMessage
    ): Promise<Either<string, ALMessage>> {
        const shapeRefusal = resolveRtcGrantedPublicationShapeRefusal(msg);
        if (shapeRefusal !== undefined) {
            return Either.ofLeft(toRtcGrantedLegRefusalDetail({ kind: 'unsupported-shape', message: shapeRefusal }));
        }
        const admitted = toAdmittedMessage(msg);
        const groupRef = readALTargetGroupRef(admitted);
        const signed = await signRtcPublication({
            crypto: this.#publicationCrypto,
            snapshot: (groupRef && readRtcGroupSnapshotByRef(this.#dependencies.groupCache, groupRef)) ?? null,
            selfSessionId: this.#dependencies.selfSessionId,
            nowEpochMs: this.#dependencies.clock.nowMs(),
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
     * A proof on an ungranted topic is refused whatever its room; a granted frame without a readable snapshot fails
     * closed, and one its room refused keeps the room's refusal. Any other frame keeps its room plan.
     */
    planIncomingPublication(input: RtcGrantedPublicationCarrier.IncomingPlanInput): ALMessageHandlingPlan {
        const { msg, snapshot, admission } = input;
        const topicGranted = this.isGrantedPublication(msg);
        if (topicGranted ? snapshot !== undefined && admission.kind !== 'authorized' : msg.proof === undefined) {
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

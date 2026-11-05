import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import { resolveGroupPublicationPermissions } from '../../api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import { resolveRoomObservationDenial } from '../rtc-room-snapshot-admission.ts';

export interface RtcPublicationAdmissionInput {
    readonly message: ALMessage;
    /**
     * Whether the receiving page classifies the frame's topic as granted: only a granted frame may carry a proof, and a
     * page whose snapshot is behind the frame's may not yet see the grant.
     */
    readonly topicGranted: boolean;
    /** The receiver's readable room snapshot: `null` when absent, or unrenewed for its cache's TTL. */
    readonly snapshot: GroupSnapshot | null;
    /** The receiving session's principal: the one field of the receiver the admission reads. */
    readonly selfPrincipalId: string;
    /** Whether the receiver's own verifier verified this message object's proof. */
    readonly signatureValid: boolean;
    /** Whether this tab's token for the message's room and topic is `active`. */
    readonly ownSubscriptionActive: boolean;
    /** Whether the frame's frozen audience names this session, so its origin counts it as a recipient. */
    readonly frozenRecipient: boolean;
    readonly nowEpochMs: number;
}

export type RtcPublicationRefusalCode =
    | 'proof-on-ungranted-topic'
    | 'no-authority'
    | 'missing-proof'
    | 'unbound-target'
    | 'unknown-key'
    | 'authority-ahead'
    | 'invalid-signature'
    | 'no-publish-grant';

/** What a relay or receiver refuses: the code its drop reason carries, and nothing of the frame. */
export interface RtcPublicationRefusal {
    readonly code: RtcPublicationRefusalCode;
}

/**
 * `forward-not-subscribed`: a recipient the origin froze into the audience that may not subscribe, or holds no active
 * token, forwards and answers that it is not subscribed; `forward-only`: a session outside the audience only forwards.
 */
export interface RtcPublicationAdmitted {
    readonly delivery: 'deliver' | 'forward-only' | 'forward-not-subscribed';
}

/**
 * A granted publication a relay or receiver judges against its own readable snapshot: it forwards only an admitted
 * frame, and delivers one only to a principal that may subscribe and holds an active token. A proof on a topic the
 * page does not grant is judged first, since no rule of a granted topic may read it: by snapshot freshness (S3-R4), then
 * refused. A frame naming no room is unbound next, since no snapshot of a room can attest it.
 */
export function computeRtcPublicationAdmission(
    input: RtcPublicationAdmissionInput
): Either<RtcPublicationRefusal, RtcPublicationAdmitted> {
    const { message, snapshot } = input;
    if (!input.topicGranted) {
        return toRefusal(isUngrantedProofAhead(input) ? 'authority-ahead' : 'proof-on-ungranted-topic');
    }
    const roomRef = readALTargetGroupRef(message);
    if (roomRef === undefined) {
        return toRefusal('unbound-target');
    }
    if (snapshot === null || resolveRoomObservationDenial(roomRef, snapshot, input.nowEpochMs) !== undefined) {
        return toRefusal('no-authority');
    }
    const proof = message.proof;
    if (proof === undefined) {
        return toRefusal('missing-proof');
    }
    const targets = message.targets;
    if (targets?.mode !== 'multicast' || targets.snapshotVersion === undefined) {
        return toRefusal('unbound-target');
    }
    if (resolvePublicationKey(snapshot, message.id.senderId, input.nowEpochMs)?.keyId !== proof.keyId) {
        return toRefusal('unknown-key');
    }
    if (snapshot.group.snapshotVersion < targets.snapshotVersion) {
        return toRefusal('authority-ahead');
    }
    if (!input.signatureValid) {
        return toRefusal('invalid-signature');
    }
    return toPublicationDelivery(input, snapshot);
}

/**
 * A page with no readable snapshot of the frame's room, or one older than the frame's, may not yet see the topic's
 * grant: its refresh judges the frame again. A frame naming no room can never be granted by a snapshot.
 */
function isUngrantedProofAhead({ message, snapshot }: RtcPublicationAdmissionInput): boolean {
    const targets = message.targets;
    if (readALTargetGroupRef(message) === undefined) {
        return false;
    }
    const frozenAt = targets?.mode === 'multicast' ? targets.snapshotVersion : undefined;
    return snapshot === null || (frozenAt !== undefined && snapshot.group.snapshotVersion < frozenAt);
}

/** After the proof and its key: the sender must hold publish, and the receiver delivers only what it may subscribe. */
function toPublicationDelivery(
    input: RtcPublicationAdmissionInput,
    snapshot: GroupSnapshot
): Either<RtcPublicationRefusal, RtcPublicationAdmitted> {
    const topicId = input.message.route.topicId;
    const senderPrincipalId = resolveSessionPrincipalId(snapshot, input.message.id.senderId);
    if (
        senderPrincipalId === undefined ||
        !resolveGroupPublicationPermissions(snapshot, senderPrincipalId, topicId).publish
    ) {
        return toRefusal('no-publish-grant');
    }
    const subscribed = resolveGroupPublicationPermissions(snapshot, input.selfPrincipalId, topicId).subscribe;
    if (subscribed && input.ownSubscriptionActive) {
        return Either.ofRight({ delivery: 'deliver' });
    }
    return Either.ofRight({ delivery: input.frozenRecipient ? 'forward-not-subscribed' : 'forward-only' });
}

function resolveSessionPrincipalId(snapshot: GroupSnapshot, sessionId: string): string | undefined {
    return snapshot.activeSessions.find((session) => session.sessionId === sessionId)?.principalId;
}

function toRefusal(code: RtcPublicationRefusalCode): Either<RtcPublicationRefusal, RtcPublicationAdmitted> {
    return Either.ofLeft({ code });
}

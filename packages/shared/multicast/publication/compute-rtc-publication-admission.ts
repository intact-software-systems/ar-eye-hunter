import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import { resolvePublicationKey } from '../../api/group-presence/resolve-publication-key.ts';
import { resolveGroupPublicationPermissions } from '../../api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';
import { resolveRoomObservationDenial } from '../rtc-room-snapshot-admission.ts';

export interface RtcPublicationAdmissionInput {
    readonly message: ALMessage;
    /** The receiver's readable room snapshot: `null` when absent, or unrenewed for its cache's TTL. */
    readonly snapshot: GroupSnapshot | null;
    /** The receiving session's principal: the one field of the receiver the admission reads. */
    readonly selfPrincipalId: string;
    /** Whether the receiver's own verifier verified this message object's proof. */
    readonly signatureValid: boolean;
    /** Whether this tab's token for the message's room and topic is `active`. */
    readonly ownSubscriptionActive: boolean;
    readonly nowEpochMs: number;
}

export type RtcPublicationRefusalCode =
    | 'no-authority'
    | 'missing-proof'
    | 'unbound-target'
    | 'unknown-key'
    | 'authority-ahead'
    | 'invalid-signature'
    | 'no-publish-grant';

export interface RtcPublicationRefusal {
    readonly code: RtcPublicationRefusalCode;
    readonly logMessage: string;
}

export interface RtcPublicationAdmitted {
    readonly delivery: 'deliver' | 'forward-only';
}

/**
 * A granted publication a relay or receiver judges against its own readable snapshot: it forwards only an admitted
 * frame, and delivers one only to a principal that may subscribe and holds an active token.
 */
export function computeRtcPublicationAdmission(
    input: RtcPublicationAdmissionInput
): Either<RtcPublicationRefusal, RtcPublicationAdmitted> {
    const { message, snapshot } = input;
    if (snapshot === null || resolveUnobservableRoom(message, snapshot, input.nowEpochMs)) {
        return toRefusal('no-authority', 'No readable, active room snapshot attests the publication.');
    }
    const proof = message.proof;
    if (proof === undefined) {
        return toRefusal('missing-proof', 'A granted publication carries no proof.');
    }
    const targets = message.targets;
    if (targets?.mode !== 'multicast' || targets.snapshotVersion === undefined) {
        return toRefusal('unbound-target', 'A granted publication is a multicast frozen at a snapshot version.');
    }
    if (resolvePublicationKey(snapshot, message.id.senderId)?.keyId !== proof.keyId) {
        return toRefusal('unknown-key', 'The room snapshot does not name the proof\'s key for its sender.');
    }
    if (snapshot.group.snapshotVersion < targets.snapshotVersion) {
        return toRefusal('authority-ahead', 'The publication was frozen at a newer snapshot than this one.');
    }
    if (!input.signatureValid) {
        return toRefusal('invalid-signature', 'The proof does not verify against the sender\'s key.');
    }
    const topicId = message.route.topicId;
    const senderPrincipalId = resolveSessionPrincipalId(snapshot, message.id.senderId);
    if (
        senderPrincipalId === undefined ||
        !resolveGroupPublicationPermissions(snapshot, senderPrincipalId, topicId).publish
    ) {
        return toRefusal('no-publish-grant', 'The sender holds no effective publish grant on the topic.');
    }
    const subscribed = resolveGroupPublicationPermissions(snapshot, input.selfPrincipalId, topicId).subscribe;
    return Either.ofRight({ delivery: subscribed && input.ownSubscriptionActive ? 'deliver' : 'forward-only' });
}

/** After an `authorized` room admission this never fires; a snapshot read without one is judged here alone. */
function resolveUnobservableRoom(message: ALMessage, snapshot: GroupSnapshot, nowEpochMs: number): boolean {
    const roomRef = readALTargetGroupRef(message);
    return roomRef === undefined || resolveRoomObservationDenial(roomRef, snapshot, nowEpochMs) !== undefined;
}

function resolveSessionPrincipalId(snapshot: GroupSnapshot, sessionId: string): string | undefined {
    return snapshot.activeSessions.find((session) => session.sessionId === sessionId)?.principalId;
}

function toRefusal(
    code: RtcPublicationRefusalCode,
    logMessage: string
): Either<RtcPublicationRefusal, RtcPublicationAdmitted> {
    return Either.ofLeft({ code, logMessage });
}

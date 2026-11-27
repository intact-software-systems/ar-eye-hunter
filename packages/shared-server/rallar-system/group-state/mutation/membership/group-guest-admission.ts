import { isGuestInvitationVerifier, isRoomGuestDisplayName } from '@shared/api/room-guests/invitation.ts';
import { isBase64UrlOfByteLength } from '@shared/encoding/base64url.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { JsonWireObject } from '../../../protocol/json-wire-identity.ts';
import { computeSha256CanonicalJson } from '../../../protocol/compute-sha256-canonical-json.ts';
import type { GroupMutationCommand, GroupMutationIngressFacts } from '../group-mutation-contracts.ts';

export interface GroupGuestAdmission {
    readonly roomRef: GroupRef;
    readonly principalId: string;
    readonly invitationVerifier: string;
    readonly displayName?: string;
    readonly guestTransport: GroupGuestAdmission.Transport;
    readonly requestId: string;
}

export namespace GroupGuestAdmission {
    export interface Transport {
        readonly sessionId: string;
        readonly accessTokenDigest: string;
    }
}

export function toGroupGuestAdmissionCommand(input: GroupGuestAdmission): GroupMutationCommand {
    return {
        operation: 'joinGroup',
        aggregateRef: input.roomRef,
        commandId: 'guest-admit:' + computeSha256CanonicalJson({ roomRef: input.roomRef, principalId: input.principalId, requestId: input.requestId }),
        requestId: input.requestId,
        targetPrincipalId: input.principalId,
        input: {
            actorPrincipalId: null, actorSessionId: null, reason: null, participation: 'player',
            joinCode: null, inviteToken: input.invitationVerifier, guestTransport: input.guestTransport,
            ...(input.displayName !== undefined && { guestDisplayName: input.displayName })
        }
    };
}

export function assertGuestAdmissionCommand(command: GroupMutationCommand): void {
    if (command.operation !== 'joinGroup' || !/^guest-[0-9a-f]{64}$/.test(command.targetPrincipalId) ||
        command.input.participation !== 'player' || command.input.joinCode !== null ||
        !(command.input.guestBookingRevision === undefined ? isGuestInvitationVerifier(command.input.inviteToken) :
            command.input.inviteToken === null && Number.isSafeInteger(command.input.guestBookingRevision) && command.input.guestBookingRevision > 0)) {
        throw new TypeError('Room guest redemption requires a scoped guest principal and invitation verifier.');
    }
    if (command.input.guestDisplayName !== undefined && !isRoomGuestDisplayName(command.input.guestDisplayName)) {
        throw new TypeError('Invalid room guest display name.');
    }
    assertGuestTransport(command.input.guestTransport);
}

export function assertGuestTransport(binding: GroupGuestAdmission.Transport | undefined): void {
    if (!binding || Object.keys(binding).length !== 2 || typeof binding.sessionId !== 'string' ||
        !/^guest-session-[0-9a-f]{64}$/u.test(binding.sessionId) || typeof binding.accessTokenDigest !== 'string' ||
        !isBase64UrlOfByteLength(binding.accessTokenDigest, 32)) {
        throw new TypeError('Guest admission requires a scoped transport binding.');
    }
}

export function assertGuestInvitationVerifier(verifier: JsonWireObject[string] | undefined): void {
    if (verifier !== undefined && !isGuestInvitationVerifier(verifier)) {
        throw new TypeError('Guest invitation verifier must be a SHA-256 digest in lowercase hexadecimal.');
    }
}

export function assertGuestAdmissionAuthority(command: GroupMutationCommand, facts: GroupMutationIngressFacts): void {
    if (command.operation === 'joinGroup' && (command.input.guestTransport || command.input.guestBookingRevision !== undefined || command.input.guestDisplayName !== undefined) && facts.internalAuthority !== 'guest-redemption') {
        throw new TypeError('A guest transport binding requires verified invitation redemption.');
    }
}

export function assertGuestExpiryCommand(command: GroupMutationCommand): void {
    if (command.operation !== 'removeGroupMember' || !/^guest-[0-9a-f]{64}$/.test(command.targetPrincipalId)) {
        throw new TypeError('Guest expiry requires a guest membership removal.');
    }
}

import type { GroupRef } from '@shared/api/group-types.ts';
import { computeSha256CanonicalJson } from '../../../protocol/compute-sha256-canonical-json.ts';
import type { GroupMutationCommand } from '../group-mutation-contracts.ts';

export interface RoomGuestAdmission {
    readonly roomRef: GroupRef;
    readonly principalId: string;
    readonly invitationVerifier: string;
    readonly displayName?: string;
    readonly guestTransport: RoomGuestAdmission.Transport;
    readonly requestId: string;
}

export namespace RoomGuestAdmission {
    export interface Transport {
        readonly sessionId: string;
        readonly accessTokenDigest: string;
    }
}

export function toRoomGuestAdmissionCommand(input: RoomGuestAdmission): GroupMutationCommand {
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

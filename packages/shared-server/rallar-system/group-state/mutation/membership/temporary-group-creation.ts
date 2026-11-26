import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { isGuestInvitationVerifier, isRoomGuestDisplayName, ROOM_GUEST_LIFETIME_MS } from '@shared/api/room-guests/invitation.ts';
import { GROUP_RETENTION_METADATA_KEY, readGroupRetentionState, toInitialGroupRetentionState } from '@shared/api/group-retention.ts';
import { computeSha256CanonicalJson } from '../../../protocol/compute-sha256-canonical-json.ts';
import type { GroupMutationCommand } from '../group-mutation-contracts.ts';
import { assertGuestTransport, type GroupGuestAdmission } from './group-guest-admission.ts';

export interface TemporaryGroupCreation {
    readonly roomRef: GroupRef;
    readonly principalId: string;
    readonly requestId: string;
    readonly capacity: number;
    readonly lifetimeMs: number;
    readonly emptyReturnWindowMs: number;
    readonly invitationVerifier: string;
    readonly guestTransport: GroupGuestAdmission.Transport;
    readonly displayName?: string;
}

export function toTemporaryGroupCreationCommand(creation: TemporaryGroupCreation): GroupMutationCommand {
    const retention = toInitialGroupRetentionState({ mode: 'temporary', reconnectGraceMs: creation.emptyReturnWindowMs, pausedTimelineRetentionMs: creation.emptyReturnWindowMs });
    return {
        operation: 'createGroup',
        aggregateRef: creation.roomRef,
        requestId: creation.requestId,
        commandId: 'temporary-room:' + computeSha256CanonicalJson({ roomRef: creation.roomRef, requestId: creation.requestId }),
        input: {
            actorPrincipalId: null, actorSessionId: null, reason: null,
            slug: null, displayName: creation.displayName ?? 'Private game', description: null,
            kind: 'room', joinMode: 'invite-only', directoryListing: 'unlisted',
            maxMembers: creation.capacity, maxSpectators: 0, maxSessionsPerMember: 1,
            createdByPrincipalId: creation.principalId, expiresAtEpochMs: null, purgeAfterEpochMs: null,
            metadata: { [GROUP_RETENTION_METADATA_KEY]: { ...retention } }, publicationGrants: {},
            temporaryCreator: { invitationVerifier: creation.invitationVerifier, lifetimeMs: creation.lifetimeMs, guestTransport: creation.guestTransport }
        }
    };
}

export function assertTemporaryGroupCreation(command: GroupMutationCommand): void {
    if (command.operation !== 'createGroup' || !command.requestId || !command.input.temporaryCreator ||
        !/^guest-[a-f0-9]{64}$/.test(command.input.createdByPrincipalId) ||
        !isGuestInvitationVerifier(command.input.temporaryCreator.invitationVerifier) ||
        !isRoomGuestDisplayName(command.input.displayName) ||
        !Number.isSafeInteger(command.input.temporaryCreator.lifetimeMs) || command.input.temporaryCreator.lifetimeMs < 1 ||
        command.input.kind !== 'room' || command.input.joinMode !== 'invite-only' || command.input.directoryListing !== 'unlisted') {
        throw new TypeError('Temporary guest creation requires a scoped creator and a bounded private room.');
    }
    const { temporaryCreator, maxMembers } = command.input;
    const retention = readGroupRetentionState(command.input.metadata);
    if (maxMembers === null || !Number.isSafeInteger(maxMembers) || maxMembers < 1 || !retention ||
        retention.reconnectGraceMs > temporaryCreator.lifetimeMs || temporaryCreator.lifetimeMs > ROOM_GUEST_LIFETIME_MS) {
        throw new TypeError('Guest creation exceeds the supported capacity or lifetime.');
    }
    assertGuestTransport(temporaryCreator.guestTransport);
    const canonical = toTemporaryGroupCreationCommand({ roomRef: command.aggregateRef, principalId: command.input.createdByPrincipalId,
        requestId: command.requestId, capacity: maxMembers, displayName: command.input.displayName, emptyReturnWindowMs: retention.reconnectGraceMs,
        lifetimeMs: temporaryCreator.lifetimeMs, invitationVerifier: temporaryCreator.invitationVerifier, guestTransport: temporaryCreator.guestTransport });
    if (!jsonEquals(command, canonical)) throw new TypeError('Guest creation must use the private player group configuration.');
}

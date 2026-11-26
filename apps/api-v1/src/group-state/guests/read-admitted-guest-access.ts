import { availableGuestSnapshot } from '@shared-server/http/available-guest-snapshot.ts';
import type { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import type { RoomGuestAccess } from '@shared/api/room-guests/invitation.ts';
import { ApiMutationRouteFailure, createApiMutationFailure } from '../../routes/api-mutation-route-failure.ts';
import type { GroupStateRouteDependencies } from '../group-state-route-contracts.ts';

export async function readAdmittedGuestAccess(
    dependencies: Pick<GroupStateRouteDependencies, 'groupStateService' | 'isTemporaryRoomAvailable' | 'nowEpochMs'>,
    roomRef: GroupRef,
    credential: Awaited<ReturnType<typeof toRoomGuestCredential>>
): Promise<RoomGuestAccess> {
    // Replayed successes describe the original admission. A removed guest must not regain a credential.
    const snapshot = await dependencies.groupStateService.readCurrentSnapshot(roomRef);
    const now = dependencies.nowEpochMs();
    const current = await availableGuestSnapshot(snapshot, now, dependencies.isTemporaryRoomAvailable);
    const member = current?.members.find(candidate => candidate.principalId === credential.clientId);
    if (!current || !member?.guestLease ||
        roomGuestAccessMode(current.group, member, now) === 'expired') {
        throw new ApiMutationRouteFailure(createApiMutationFailure({
            code: 'guest-access-ended', status: 403, message: 'Guest access to this room has ended.'
        }));
    }
    return { ...credential, issuedAtEpochMs: member.guestLease.admittedAtEpochMs, expiresAtEpochMs: member.guestLease.expiresAtEpochMs };
}

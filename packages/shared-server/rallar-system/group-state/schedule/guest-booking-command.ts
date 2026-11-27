import type { GroupRef } from '@shared/api/group-types.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import type { GroupMutationCommand } from '../mutation/group-mutation-contracts.ts';
import type { GroupGuestAdmission } from '../mutation/membership/group-guest-admission.ts';

export type GuestBookingCommand = {
    readonly roomRef: GroupRef;
    readonly principalId: string;
    readonly expectedScheduleRevision: number;
    readonly requestId: string;
} & ({ readonly action: 'reserve' | 'withdraw' } | { readonly action: 'claim'; readonly guestTransport: GroupGuestAdmission.Transport });

export function toGuestBookingCommand(booking: GuestBookingCommand): GroupMutationCommand {
    const requestId = computeSha256CanonicalJson({ room: booking.roomRef, principalId: booking.principalId, requestId: booking.requestId });
    const identity = { aggregateRef: booking.roomRef, requestId, commandId: 'guest-booking:' + requestId };
    const actor = { actorPrincipalId: null, actorSessionId: null, reason: null };
    if (booking.action === 'claim') {
        return { ...identity, operation: 'joinGroup', targetPrincipalId: booking.principalId,
            input: { ...actor, participation: 'player', inviteToken: null, joinCode: null, guestTransport: booking.guestTransport,
                guestBookingRevision: booking.expectedScheduleRevision } };
    }
    return { ...identity, operation: 'changeGroupSession', input: { ...actor, action: booking.action, startsAtEpochMs: null,
        expectedScheduleRevision: booking.expectedScheduleRevision, actorPrincipalId: booking.principalId } };
}

export function assertGuestBookingCommand(command: GroupMutationCommand): void {
    if (command.operation !== 'changeGroupSession' || command.input.actorSessionId !== null ||
        !/^guest-[a-f0-9]{64}$/.test(command.input.actorPrincipalId ?? '') ||
        (command.input.action !== 'reserve' && command.input.action !== 'withdraw')) {
        throw new TypeError('A guest booking requires a scoped identity and reservation decision.');
    }
}

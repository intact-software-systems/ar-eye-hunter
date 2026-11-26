import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { previewRoomGuestInvitation } from '@shared-web/browser/rooms/entry/temporary-room-creation.ts';
import { GRUMPY_TOWN_SCOPE } from './town-server.ts';

interface PreviewTownInvitationInput {
    readonly room: string;
    readonly invitationSecret: string;
    readonly signal: AbortSignal;
    readonly join: HTMLButtonElement;
    readonly message: HTMLElement;
    readonly availability: HTMLElement;
}

export async function previewTownInvitation(input: PreviewTownInvitationInput): Promise<void> {
    const { room, invitationSecret, signal, join, message, availability } = input;
    try {
        const preview = await previewRoomGuestInvitation({ ...GRUMPY_TOWN_SCOPE, groupId: room }, invitationSecret, signal);
        if (signal.aborted) return;
        availability.textContent = preview.availableSeats === null
            ? 'Seats available' : preview.availableSeats === 0
            ? 'Town is full. Try again when a seat opens.' : `${preview.availableSeats} of ${preview.capacity} seats available`;
        join.hidden = false;
    } catch (error) {
        if (signal.aborted) return;
        const denied = error instanceof ApiHttpError && [400, 401, 403, 404].includes(error.status);
        message.textContent = denied ? 'Ask the owner for a fresh invitation.' : 'Could not check availability. Try joining.';
        join.hidden = denied;
    }
}

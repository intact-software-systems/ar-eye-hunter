import { isApiJsonObject } from '../api-json-value.ts';
import type { GroupRef } from '../group-types.ts';
import { validateRallarGroupRef } from '../rallar-validation.ts';
import { isRoomGuestAccess, type RoomGuestAccess } from './invitation.ts';

export interface CreateTemporaryRoom {
    readonly guestSecret: string;
    readonly invitationVerifier: string;
    readonly displayName?: string;
    readonly capacity?: number;
}

export interface TemporaryRoomAdmission {
    readonly room: GroupRef;
    readonly access: RoomGuestAccess;
}

export interface RoomGuestPreview {
    readonly displayName: string;
    readonly capacity: number | null;
    readonly availableSeats: number | null;
}

export function isTemporaryRoomAdmission(value: unknown): value is TemporaryRoomAdmission {
    return isApiJsonObject(value) && validateRallarGroupRef(value.room).ok && isRoomGuestAccess(value.access);
}

export function isRoomGuestPreview(value: unknown): value is RoomGuestPreview {
    if (!isApiJsonObject(value) || typeof value.displayName !== 'string') return false;
    if (value.capacity === null) return value.availableSeats === null;
    return typeof value.capacity === 'number' && Number.isSafeInteger(value.capacity) && value.capacity > 0 &&
        typeof value.availableSeats === 'number' && Number.isSafeInteger(value.availableSeats) &&
        value.availableSeats >= 0 && value.availableSeats <= value.capacity;
}

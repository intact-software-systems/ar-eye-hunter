import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { isRoomGuestAccess, type RoomGuestAccess, type RoomGuestRedemption } from '@shared/api/room-guests/invitation.ts';

import { readApiBaseUrl } from '../../api-client-config.ts';
import { sendApiHttpRequest, type ApiMutationRequestOptions } from '../../api/send-api-http-request.ts';
import { toStateGroupHttpPath } from '../../api/state-http-path.ts';

export function createRoomGuestSecret(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function redeemRoomGuestInvitation(
    room: GroupRef,
    proof: RoomGuestRedemption,
    options: Pick<ApiMutationRequestOptions, 'requestId' | 'signal'>
): Promise<RoomGuestAccess> {
    const response = await sendApiHttpRequest<RoomGuestRedemption, ApiJsonValue>({
        baseUrl: readApiBaseUrl(),
        path: toApiMutationRequestPath(`${toStateGroupHttpPath(room, room.groupId)}/guests`, options.requestId),
        method: 'POST',
        body: proof,
        options: { signal: options.signal, authSession: null }
    });
    if (!isRoomGuestAccess(response)) {
        throw new TypeError('Invalid room guest admission response.');
    }
    return response;
}

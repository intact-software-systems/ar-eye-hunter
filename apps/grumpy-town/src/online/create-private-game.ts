import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { TemporaryRoomCreation } from '@shared-web/browser/rooms/entry/temporary-room-creation.ts';

import { guestVisitUrl, saveGuestVisit } from './guest-visit.ts';
import { GRUMPY_TOWN_SCOPE, townApiBaseUrl } from './town-server.ts';

export async function createPrivateGame(signal: AbortSignal): Promise<URL> {
    configureApiClient({ apiBaseUrl: townApiBaseUrl });
    const creation = new TemporaryRoomCreation(GRUMPY_TOWN_SCOPE, localStorage);
    const nickname = 'Captain Cabbage';
    const { room, invitationSecret, access } = await creation.start({ displayName: nickname }, signal);
    signal.throwIfAborted();
    saveGuestVisit({ room: room.groupId, access, nickname, invitationSecret });
    creation.clear();
    return guestVisitUrl(room.groupId);
}

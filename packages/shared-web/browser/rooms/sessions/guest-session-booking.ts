import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeGroupSessionPreview } from '@shared/api/group-sessions/decode-group-session-preview.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { isRoomGuestAccess, type RoomGuestAccess } from '@shared/api/room-guests/invitation.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { sendApiHttpRequest } from '../../api/send-api-http-request.ts';
import { toStateGroupHttpPath } from '../../api/state-http-path.ts';
import { browserCredentialStore } from '../../auth/browser-credential-store.ts';
import { createRoomGuestSecret } from '../entry/redeem-guest-invitation.ts';

/** The link selects the room; the encrypted, browser-local proof identifies the visitor. */
export class GuestSessionBooking {
    private readonly baseUrl = readApiBaseUrl();
    private readonly path: string;
    private readonly key: string;

    private readonly room: GroupRef;

    constructor(room: GroupRef) {
        this.room = room;
        this.path = toStateGroupHttpPath(room, room.groupId) + '/session/guest';
        this.key = 'rallar.session.guest.' + JSON.stringify([this.baseUrl, room.applicationId, room.workspaceId, room.groupId]);
    }

    async preview(signal?: AbortSignal) {
        try {
            const view = decodeGroupSessionPreview(await this.post(this.path + '/preview', {}, signal));
            if (!isSameGroupRef(view.roomRef, this.room) || !view.schedule.guestBooking) throw new TypeError('Invalid guest booking preview.');
            return view;
        } catch (error) {
            if (error instanceof ApiHttpError && (error.status === 403 || error.status === 404)) return null;
            throw error;
        }
    }

    async change(action: 'reserve' | 'withdraw', revision: number, signal?: AbortSignal): Promise<void> {
        const key = this.key + '.' + action + '.' + revision;
        const opposite = this.key + '.' + (action === 'reserve' ? 'withdraw' : 'reserve') + '.' + revision;
        const competing = await browserCredentialStore.read(opposite);
        const requestId = await browserCredentialStore.readOrCreate(key, crypto.randomUUID());
        const result = await this.submit(key, requestId, action, revision, signal);
        if (!result || typeof result !== 'object' || !('accepted' in result) || result.accepted !== true) throw new TypeError('Invalid guest reservation acknowledgement.');
        if (competing) await browserCredentialStore.removeIfEqual(opposite, competing);
        await browserCredentialStore.removeIfEqual(key, requestId);
    }

    async claim(revision: number, signal?: AbortSignal): Promise<RoomGuestAccess> {
        const key = this.key + '.claim.' + revision;
        const requestId = await browserCredentialStore.readOrCreate(key, crypto.randomUUID());
        const result = await this.submit(key, requestId, 'claim', revision, signal);
        if (!isRoomGuestAccess(result)) throw new TypeError('Invalid guest lobby admission.');
        return result;
    }

    private async submit(key: string, requestId: string, action: 'reserve' | 'withdraw' | 'claim', revision: number, signal?: AbortSignal) {
        try {
            return await this.post(toApiMutationRequestPath(this.path, requestId), { action, expectedScheduleRevision: revision }, signal);
        } catch (error) {
            if (error instanceof ApiHttpError && [400, 403, 404, 409, 410].includes(error.status)) {
                await browserCredentialStore.removeIfEqual(key, requestId);
            }
            throw error;
        }
    }

    private async post(path: string, fields: Record<string, string | number>, signal?: AbortSignal): Promise<ApiJsonValue> {
        const guestSecret = await browserCredentialStore.readOrCreate(this.key, createRoomGuestSecret());
        return await sendApiHttpRequest({ baseUrl: this.baseUrl, path, method: 'POST', body: { ...fields, guestSecret }, options: { authSession: null, signal } });
    }
}

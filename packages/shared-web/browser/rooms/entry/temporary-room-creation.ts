import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { hashRoomInvitationSecret, isGuestInvitationVerifier, isRoomGuestDisplayName } from '@shared/api/room-guests/invitation.ts';
import {
    isRoomGuestPreview, isTemporaryRoomAdmission, type CreateTemporaryRoom,
    type RoomGuestPreview, type TemporaryRoomAdmission
} from '@shared/api/room-guests/temporary-room.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { browserCredentialStore } from '../../auth/browser-credential-store.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { sendApiHttpRequest } from '../../api/send-api-http-request.ts';
import { toStateGroupHttpPath, toStateScopeHttpPath } from '../../api/state-http-path.ts';
import { createRoomGuestSecret } from './redeem-guest-invitation.ts';

export namespace TemporaryRoomCreation {
    export interface Options {
        readonly displayName?: string;
        readonly capacity?: number;
    }
    export interface Created extends TemporaryRoomAdmission {
        readonly invitationSecret: string;
    }
    export interface SavedAttempt extends Options {
        readonly requestId: string;
        readonly guestSecret: string;
        readonly invitationSecret: string;
    }
}

/** Persists the private request before sending so a reload can recover a lost creation response. */
export class TemporaryRoomCreation {
    private savedAttempt?: string;
    private readonly key: string;
    private readonly baseUrl = readApiBaseUrl();
    private readonly scope: StateScope;
    private readonly storage: Pick<typeof browserCredentialStore, 'readOrCreate' | 'removeIfEqual'>;

    constructor(scope: StateScope, storage: Pick<typeof browserCredentialStore, 'readOrCreate' | 'removeIfEqual'> = browserCredentialStore) {
        this.scope = scope;
        this.storage = storage;
        this.key = 'rallar.temporary-room.create.' + JSON.stringify([this.baseUrl, scope.applicationId, scope.workspaceId]);
    }

    async start(options: TemporaryRoomCreation.Options, signal?: AbortSignal): Promise<TemporaryRoomCreation.Created> {
        const candidate = { ...options, requestId: crypto.randomUUID(), guestSecret: createRoomGuestSecret(), invitationSecret: createRoomGuestSecret() };
        if (!isSavedAttempt(candidate)) throw new TypeError('Invalid temporary room creation options.');
        const raw = await this.storage.readOrCreate(this.key, JSON.stringify(candidate));
        const attempt: ApiJsonValue = JSON.parse(raw);
        if (!isSavedAttempt(attempt)) throw new TypeError('Invalid saved temporary room request.');
        this.savedAttempt = raw;
        try {
            return await this.admit(attempt, signal);
        } catch (error) {
            if (error instanceof ApiHttpError && [400, 403, 404, 410].includes(error.status)) await this.storage.removeIfEqual(this.key, raw);
            throw error;
        }
    }

    private async admit(attempt: TemporaryRoomCreation.SavedAttempt, signal?: AbortSignal): Promise<TemporaryRoomCreation.Created> {
        const { displayName, capacity, guestSecret, requestId, invitationSecret } = attempt;
        const path = toApiMutationRequestPath(toStateScopeHttpPath(this.scope) + '/temporary-rooms', requestId);
        const admission = await sendApiHttpRequest<CreateTemporaryRoom, ApiJsonValue>({
            baseUrl: this.baseUrl, path, method: 'POST',
            body: { displayName, capacity, guestSecret, invitationVerifier: await hashRoomInvitationSecret(invitationSecret) },
            options: { authSession: null, signal }
        });
        if (!isTemporaryRoomAdmission(admission) || admission.room.applicationId !== this.scope.applicationId ||
            admission.room.workspaceId !== this.scope.workspaceId) {
            throw new TypeError('Invalid temporary room admission.');
        }
        return { room: admission.room, access: admission.access, invitationSecret };
    }

    /** Call once the application has saved the returned seat and share link, or the player abandons the request. */
    async clear(): Promise<void> {
        const saved = this.savedAttempt;
        if (saved === undefined) return;
        await this.storage.removeIfEqual(this.key, saved);
        if (this.savedAttempt === saved) this.savedAttempt = undefined;
    }
}

function isSavedAttempt(value: unknown): value is TemporaryRoomCreation.SavedAttempt {
    return isApiJsonObject(value) && typeof value.requestId === 'string' && value.requestId.length > 0 &&
        isGuestInvitationVerifier(value.guestSecret) && isGuestInvitationVerifier(value.invitationSecret) &&
        (value.displayName === undefined || isRoomGuestDisplayName(value.displayName)) &&
        (value.capacity === undefined || (typeof value.capacity === 'number' && Number.isSafeInteger(value.capacity) && value.capacity > 0));
}

/** Reads availability using the link secret without claiming a seat or authenticating a previous account. */
export async function previewRoomGuestInvitation(room: GroupRef, invitationSecret: string, signal?: AbortSignal): Promise<RoomGuestPreview> {
    const preview = await sendApiHttpRequest<{ invitationSecret: string }, ApiJsonValue>({
        baseUrl: readApiBaseUrl(), path: toStateGroupHttpPath(room, room.groupId) + '/guests/preview', method: 'POST',
        body: { invitationSecret }, options: { authSession: null, signal }
    });
    if (!isRoomGuestPreview(preview)) throw new TypeError('Invalid room invitation preview.');
    return preview;
}

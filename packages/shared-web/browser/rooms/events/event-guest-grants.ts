import type { AuthSession } from '@shared/api/api-config.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { isGuestInvitationVerifier } from '@shared/api/room-guests/invitation.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { createRoomGuestSecret } from '../entry/redeem-guest-invitation.ts';

export namespace EventGuestGrants {
    export interface Storage {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
    }
    export interface Claim {
        readonly requestId: string;
        readonly courtSecret: string;
    }
}

/** Keeps the event bearer available while the current browser connection belongs to its court. */
export class EventGuestGrants {
    private readonly lobby: GroupRef;
    private readonly storage: EventGuestGrants.Storage;
    private readonly prefix: string;

    constructor(lobby: GroupRef, storage: EventGuestGrants.Storage) {
        this.lobby = lobby;
        this.storage = storage;
        this.prefix = 'rallar.event.' + JSON.stringify([readApiBaseUrl(), lobby.applicationId, lobby.workspaceId, lobby.groupId]);
    }

    lobbySession(active: AuthSession | undefined): AuthSession | undefined {
        if (!active?.guestRoom) return active;
        const key = this.prefix + '.lobby.' + active.clientId;
        if (isSameGroupRef(active.guestRoom, this.lobby)) {
            const saved = JSON.stringify(active);
            if (this.storage.getItem(key) !== saved) this.storage.setItem(key, saved);
            return active;
        }
        const raw = this.storage.getItem(key);
        if (!raw) return undefined;
        const saved: ApiJsonValue = JSON.parse(raw);
        if (!isApiJsonObject(saved) || saved.clientId !== active.clientId ||
            !isSameGroupRef(decodeExactGroupRef(saved.guestRoom, 'Saved event grant'), this.lobby) || typeof saved.username !== 'string' ||
            typeof saved.sessionId !== 'string' || typeof saved.accessToken !== 'string' || typeof saved.expiresAtEpochMs !== 'number') {
            throw new TypeError('Invalid saved event grant.');
        }
        return { clientId: active.clientId, username: saved.username, sessionId: saved.sessionId,
            accessToken: saved.accessToken, expiresAtEpochMs: saved.expiresAtEpochMs, guestRoom: this.lobby };
    }

    claim(principalId: string, offer: RoomEvent.Offer): EventGuestGrants.Claim {
        const key = this.prefix + '.claim.' + principalId;
        const occurrence = JSON.stringify([offer.groupId, offer.partyId, offer.occurrence, offer.offerRevision]);
        const raw = this.storage.getItem(key);
        if (raw) {
            const saved: ApiJsonValue = JSON.parse(raw);
            if (isApiJsonObject(saved) && saved.occurrence === occurrence && typeof saved.requestId === 'string' &&
                isGuestInvitationVerifier(saved.courtSecret)) return { requestId: saved.requestId, courtSecret: saved.courtSecret };
        }
        const claim = { courtSecret: createRoomGuestSecret(), requestId: crypto.randomUUID() };
        this.storage.setItem(key, JSON.stringify({ occurrence, ...claim }));
        return claim;
    }
}

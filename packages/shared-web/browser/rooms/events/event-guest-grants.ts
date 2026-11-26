import type { AuthSession } from '@shared/api/api-config.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { isGuestInvitationVerifier } from '@shared/api/room-guests/invitation.ts';
import { browserCredentialStore } from '../../auth/browser-credential-store.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { createRoomGuestSecret } from '../entry/redeem-guest-invitation.ts';

export namespace EventGuestGrants {
    export type Storage = Pick<typeof browserCredentialStore, 'read' | 'write' | 'readOrCreate'>;
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
    private savedLobby: AuthSession | undefined;
    private transition: { identity: AuthSession; source?: string; destination: string } | undefined;

    constructor(lobby: GroupRef, storage: EventGuestGrants.Storage) {
        this.lobby = lobby;
        this.storage = storage;
        this.prefix = 'rallar.event.' + JSON.stringify([readApiBaseUrl(), lobby.applicationId, lobby.workspaceId, lobby.groupId]);
    }

    /** Only an SDK-verified room switch belongs to the same resource operation. */
    identity(active: AuthSession | undefined): AuthSession | undefined {
        const key = active && toAuthSessionKey(active);
        if (key && this.transition && (key === this.transition.source || key === this.transition.destination)) return this.transition.identity;
        this.transition = undefined;
        if (active !== this.savedLobby) this.savedLobby = undefined;
        return active;
    }

    switchTo(identity: AuthSession, source: AuthSession | undefined, destination: Pick<AuthSession, 'clientId' | 'sessionId'>): void {
        this.transition = { identity, source: source && toAuthSessionKey(source), destination: toAuthSessionKey(destination) };
    }

    async lobbySession(active: AuthSession | undefined, signal: AbortSignal): Promise<AuthSession> {
        signal.throwIfAborted();
        if (!active) throw new Error('An active event session is required.');
        if (!active.guestRoom) return active;
        const key = this.prefix + '.lobby.' + active.clientId;
        if (isSameGroupRef(active.guestRoom, this.lobby)) {
            if (active !== this.savedLobby) {
                await this.storage.write(key, JSON.stringify(active));
                signal.throwIfAborted();
                this.savedLobby = active;
            }
            return active;
        }
        const raw = await this.storage.read(key);
        signal.throwIfAborted();
        if (!raw) throw new Error('The event lobby session is unavailable.');
        const saved: ApiJsonValue = JSON.parse(raw);
        if (!isApiJsonObject(saved) || saved.clientId !== active.clientId ||
            !isSameGroupRef(decodeExactGroupRef(saved.guestRoom, 'Saved event grant'), this.lobby) || typeof saved.username !== 'string' ||
            typeof saved.sessionId !== 'string' || typeof saved.accessToken !== 'string' || typeof saved.expiresAtEpochMs !== 'number') {
            throw new TypeError('Invalid saved event grant.');
        }
        return { clientId: active.clientId, username: saved.username, sessionId: saved.sessionId,
            accessToken: saved.accessToken, expiresAtEpochMs: saved.expiresAtEpochMs, guestRoom: this.lobby };
    }

    async claim(principalId: string, offer: RoomEvent.Offer): Promise<EventGuestGrants.Claim> {
        const key = this.prefix + '.claim.' + JSON.stringify([principalId, offer.groupId, offer.partyId, offer.occurrence, offer.offerRevision]);
        const raw = await this.storage.readOrCreate(key, JSON.stringify({ courtSecret: createRoomGuestSecret(), requestId: crypto.randomUUID() }));
        const saved: ApiJsonValue = JSON.parse(raw);
        if (!isApiJsonObject(saved) || typeof saved.requestId !== 'string' || !isGuestInvitationVerifier(saved.courtSecret)) {
            throw new TypeError('Invalid saved court claim.');
        }
        return { requestId: saved.requestId, courtSecret: saved.courtSecret };
    }
}

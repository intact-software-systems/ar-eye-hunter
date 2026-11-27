import type { AuthSession } from '@shared/api/api-config.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import { decodeRoomEventOrganizerView } from '@shared/api/room-events/room-event-organizer-view.ts';
import { decodeRoomEventView } from '@shared/api/room-events/decode-room-event-view.ts';
import { isTemporaryRoomAdmission } from '@shared/api/room-guests/temporary-room.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { AuthenticatedResource } from '../../api/authenticated-resource.ts';
import { readApiView } from '../../api/read-api-view.ts';
import { sendApiHttpRequest } from '../../api/send-api-http-request.ts';
import { toStateGroupHttpPath } from '../../api/state-http-path.ts';
import { subscribeViewInvalidations } from '../../api/subscribe-view-invalidations.ts';
import type { SubscribeViewRecovery } from '../../api/subscribe-view-recovery.ts';
import { browserCredentialStore } from '../../auth/browser-credential-store.ts';
import { BrowserActivity } from '../../browser-activity.ts';
import type { RallarFacade } from '../../rallar.ts';
import type { RallarAuthFacade } from '../../session/rallar-auth-facade.ts';
import { EventGuestGrants } from './event-guest-grants.ts';

export namespace RallarRoomEvent {
    export interface Browser extends SubscribeViewRecovery.Browser {
        readonly auth: Pick<RallarAuthFacade, 'activateGuest' | 'onChange'>;
        readonly connect: RallarFacade['connect'];
        readonly rooms: Pick<RallarFacade['rooms'], 'join'>;
    }
    export type Action = RoomEvent.Command & { readonly action: Exclude<RoomEvent.Command['action'], 'claim' | 'settle'> };
}

/** A private event view stays bound to its lobby identity while the player chooses which room to enter. */
export class RallarRoomEvent extends AuthenticatedResource<RoomEvent.View | null, RallarRoomEvent.Action> {
    private readonly lobby: GroupRef;
    private readonly browser: RallarRoomEvent.Browser;
    private readonly grants: EventGuestGrants;
    private readonly path: string;

    constructor(browser: RallarRoomEvent.Browser, lobby: GroupRef, storage: EventGuestGrants.Storage = browserCredentialStore) {
        const ref = decodeExactGroupRef(lobby, 'Event lobby');
        const path = toStateGroupHttpPath(ref, ref.groupId) + '/event';
        const grants = new EventGuestGrants(ref, storage);
        super({
            auth: { session: () => grants.identity(browser.session()), onChange: (listener, options) => browser.auth.onChange(listener, options) },
            activity: new BrowserActivity(), timers: createDefaultTimers(), createId: () => crypto.randomUUID()
        }, {
            scope: ref, changeResult: 'read',
            subscribeRefresh: changed => subscribeViewInvalidations({ browser, scope: ref, resource: 'room-event', changed: notice => {
                if (!notice || (notice.resource === 'room-event' && notice.groupId === ref.groupId)) void changed();
            } })
        }, {
            read: async input => readPrivateEventView(ref, path, { ...input, session: await grants.lobbySession(browser.session(), input.signal) }),
            change: async ({ request, requestId, signal }) => {
                const current = browser.session();
                const actor = request.action === 'release' && current?.guestRoom &&
                    isSameGroupRef(current.guestRoom, { ...ref, groupId: request.groupId }) ? current : await grants.lobbySession(current, signal);
                const result = await sendApiHttpRequest<typeof request, ApiJsonValue>({ baseUrl: readApiBaseUrl(),
                    path: toApiMutationRequestPath(path, requestId), method: 'POST', body: request, options: { authSession: actor, signal } });
                if (!isApiJsonObject(result) || !Number.isSafeInteger(result.revision)) throw new TypeError('Invalid event acknowledgement.');
                return null;
            }
        });
        this.browser = browser;
        this.lobby = ref;
        this.grants = grants;
        this.path = path;
    }

    /** Observe event-wide allocations while remaining in the selected room. */
    organizerView(): Pick<AuthenticatedResource<RoomEvent.OrganizerView, never>, 'start' | 'stop' | 'getState' | 'onChange' | 'refresh'> {
        const browser = this.browser;
        const lobby = this.lobby;
        return new AuthenticatedResource<RoomEvent.OrganizerView, never>({
            auth: { session: () => browser.session(), onChange: (listener, options) => browser.auth.onChange(listener, options) },
            activity: new BrowserActivity(), timers: createDefaultTimers(), createId: () => crypto.randomUUID()
        }, {
            scope: lobby, changeResult: 'read',
            subscribeRefresh: changed => subscribeViewInvalidations({ browser, scope: lobby, resource: 'room-event-organizer',
                changed: notice => {
                    if (!notice || (notice.resource === 'room-event-organizer' && notice.groupId === lobby.groupId)) void changed();
                } })
        }, {
            read: async ({ session, signal }) => {
                const raw = await readApiView({ baseUrl: readApiBaseUrl(), path: this.path + '/organizer', session, signal, timeoutMs: 10_000 });
                const view = decodeRoomEventOrganizerView(raw);
                if (view.organizerId !== session.clientId || !isSameGroupRef(view.lobby, lobby)) {
                    throw new TypeError('Organizer roster belongs to another account or event.');
                }
                return view;
            }
        });
    }

    async enterCourt(): Promise<void> {
        const offer = this.getState().view?.offer;
        if (!offer) throw new Error('A court offer is required.');
        const attempt = this.beginOperation();
        if (!attempt) throw new Error('The event session is unavailable or busy.');
        try {
            const { signal } = attempt;
            const session = await this.grants.lobbySession(this.browser.session(), signal);
            const room = { ...this.lobby, groupId: offer.groupId };
            const access = offer.deadline !== null || session.guestRoom
                ? await this.claimCourt(room, offer, session, signal)
                : undefined;
            if (!this.current(attempt)) throw new Error('The player has changed.');
            const observed = await readPrivateEventView(this.lobby, this.path, { ...attempt, session });
            const latest = this.getState().view;
            const currentView = observed && latest && latest.revision > observed.revision ? latest : observed;
            this.publishStreamView(attempt, currentView);
            const claimed = currentView?.offer;
            if (!this.current(attempt) || !claimed || claimed.deadline !== null || claimed.occurrence !== offer.occurrence ||
                claimed.offerRevision !== offer.offerRevision || claimed.partyId !== offer.partyId || claimed.groupId !== room.groupId) throw new Error('The court assignment has changed.');
            if (session.guestRoom && access) {
                this.grants.switchTo(attempt.session, this.browser.session(), access);
                await this.browser.auth.activateGuest({ room, access, username: session.username });
            }
            await this.selectRoom(room, signal);
        } finally { this.finishOperation(attempt); }
    }

    async returnToLobby(): Promise<void> {
        const attempt = this.beginOperation();
        if (!attempt) throw new Error('The event session is unavailable or busy.');
        try {
            const { signal } = attempt;
            const session = await this.grants.lobbySession(this.browser.session(), signal);
            if (session.guestRoom) {
                this.grants.switchTo(attempt.session, this.browser.session(), session);
                await this.browser.auth.activateGuest({ room: this.lobby, access: session, username: session.username });
            }
            await this.selectRoom(this.lobby, signal);
            await this.refresh();
        } finally { this.finishOperation(attempt); }
    }

    private async claimCourt(room: GroupRef, offer: RoomEvent.Offer, session: AuthSession, signal: AbortSignal) {
        const { requestId, courtSecret } = await this.grants.claim(session.clientId, offer);
        signal.throwIfAborted();
        const body = { action: 'claim', groupId: offer.groupId, occurrence: offer.occurrence, partyId: offer.partyId, offerRevision: offer.offerRevision,
            ...(session.guestRoom && { courtSecret }) };
        const result = await sendApiHttpRequest<typeof body, ApiJsonValue>({
            baseUrl: readApiBaseUrl(), path: toApiMutationRequestPath(this.path, requestId), method: 'POST', body,
            options: { signal, authSession: session }
        });
        if (!isApiJsonObject(result) || !Number.isSafeInteger(result.revision) ||
            !isSameGroupRef(decodeExactGroupRef(result.room, 'Court admission'), room)) throw new TypeError('Invalid court admission.');
        const access = isTemporaryRoomAdmission(result) ? result.access : undefined;
        if (session.guestRoom && access?.clientId !== session.clientId) throw new TypeError('Invalid court admission.');
        return access;
    }

    private async selectRoom(room: GroupRef, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        await this.browser.connect({ signal });
        signal.throwIfAborted();
        await this.browser.rooms.join(room, { signal, presenceOnly: true, preserveCurrentMembership: true });
    }
}

async function readPrivateEventView(lobby: GroupRef, path: string, { session, signal }: AuthenticatedResource.ReadInput): Promise<RoomEvent.View | null> {
    const response = await readApiView({ baseUrl: readApiBaseUrl(), path, session, signal, timeoutMs: 10000 });
    if (response === null) return null;
    const view = decodeRoomEventView(response);
    if (view.principalId !== session.clientId || !isSameGroupRef(view.lobby, lobby)) throw new TypeError('Event view belongs to another player or lobby.');
    return view;
}

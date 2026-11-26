import { trackAccountTownRecovery } from './track-account-town-recovery.ts';
import { issueTownInvitation } from './issue-town-invitation.ts';
import { leaveCurrentTown } from './leave-current-town.ts';
import type { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import { RallarFriends } from '@shared-web/browser/friends/rallar-friends.ts';
import { RallarMatchmaking } from '@shared-web/browser/matchmaking/rallar-matchmaking.ts';
import type { RallarFacade, RallarRoomState } from '@shared-web/browser/rallar.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { LoginRequest } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { FriendsView } from '@shared/api/friends/friends-view.ts';
import type { MatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

import { GRUMPY_TOWN_SCOPE, townGroupPresence } from './town-server.ts';

const START_OPTIONS = { connect: true, refreshRooms: true, refreshPeople: true } as const;

export namespace OnlineSession {
    export type MatchmakingAction = 'find' | 'confirm' | 'cancel' | 'retry';
    export interface State {
        readonly username: string | undefined;
        readonly ownsTown: boolean;
        readonly invitation: URL | null;
        readonly connected: boolean;
        readonly busy: boolean;
        readonly error: string;
        readonly rooms: RallarRoomState;
        readonly entry: RallarRoomEntry.State;
        readonly matchmaking: AuthenticatedResource.State<MatchmakingSnapshot>;
        readonly friends: AuthenticatedResource.State<FriendsView>;
    }
}

export class OnlineSession {
    readonly entry: RallarRoomEntry;
    readonly friends: RallarFriends;
    readonly matchmaking: RallarMatchmaking;
    private readonly browser: RallarFacade;
    private readonly apiBaseUrl: string;
    private readonly subscriptions = new SubscriptionScope();
    private readonly lifetime = new AbortController();
    private readonly changes = new SynchronousNotifications<void>((error) =>
        console.error('Lobby listener failed', error)
    );
    private rooms: RallarRoomState = { rooms: [], members: [] };
    private invitation: { groupId: string; owner: string; link: URL } | undefined;
    private invitationTimeout: ReturnType<typeof setTimeout> | undefined;
    private error = '';
    private busy = false;
    private connected = false;
    private cancelVisitRecovery: (() => void) | undefined;
    private matchmakingAction: Promise<void> | null = null;

    constructor(browser: RallarFacade, apiBaseUrl: string) {
        this.browser = browser;
        this.apiBaseUrl = apiBaseUrl;
        this.entry = RallarRoomEntry.createBrowser(browser, { scope: GRUMPY_TOWN_SCOPE });
        this.friends = RallarFriends.createBrowser(browser, this.entry, { scope: GRUMPY_TOWN_SCOPE });
        this.matchmaking = RallarMatchmaking.createBrowser(browser, this.entry, { scope: GRUMPY_TOWN_SCOPE });
    }

    onChange(listener: () => void): () => void {
        return this.changes.subscribeAndNotify(listener, undefined).unsubscribe;
    }

    getState(): OnlineSession.State {
        const room = this.rooms.currentRoom?.group;
        const principal = this.browser.session()?.clientId;
        const ownsTown = Boolean(room && principal && room.ownerPrincipalId === principal);
        return {
            ownsTown,
            invitation: ownsTown && this.invitation && this.invitation.owner === principal &&
                this.invitation.groupId === room?.groupId ? this.invitation.link : null,
            username: this.browser.session()?.username,
            connected: this.connected,
            busy: this.busy,
            error: this.error,
            rooms: this.rooms,
            entry: this.entry.getState(),
            matchmaking: this.matchmaking.getState(),
            friends: this.friends.getState()
        };
    }

    async start(): Promise<void> {
        this.cancelVisitRecovery = trackAccountTownRecovery(this.browser, this.lifetime.signal, error => {
            this.error = error?.message ?? '';
            this.publish();
        });
        this.entry.start();
        this.subscriptions.add(this.browser.rooms.onChange((state) => {
            this.rooms = state;
            this.publish();
        }, { emitCurrent: false }));
        this.subscriptions.add(this.browser.auth.onChange(() => this.publish()));
        this.subscriptions.add(this.entry.onChange(() => this.publish()));
        this.subscriptions.add(this.friends.onChange(() => this.publish()));
        this.subscriptions.add(this.matchmaking.onChange(() => this.publish()));
        await this.run(async () => {
            const started = await this.browser.setup({
                apiBaseUrl: this.apiBaseUrl,
                ...GRUMPY_TOWN_SCOPE,
                groupPresence: townGroupPresence,
                start: { ...START_OPTIONS, signal: this.lifetime.signal }
            });
            if (this.lifetime.signal.aborted) {
                return;
            }
            this.connected = started.connected;
            this.rooms = started.roomState ?? { rooms: [], members: [] };
            if (started.session) {
                await this.startAccount();
            }
        });
    }

    async authenticate(credentials: LoginRequest, register: boolean): Promise<void> {
        await this.run(async () => {
            const options = { signal: this.lifetime.signal };
            if (register) {
                await this.browser.auth.registerAndLogin(
                    { ...credentials, displayName: credentials.username },
                    options
                );
            }
            else {
                await this.browser.auth.login(credentials, options);
            }
            if (this.lifetime.signal.aborted) {
                return;
            }
            const started = await this.browser.start({ ...START_OPTIONS, signal: this.lifetime.signal });
            this.connected = started.connected;
            this.rooms = this.browser.rooms.state();
            await this.startAccount();
        });
    }

    async createTown(): Promise<void> {
        await this.run(async () => {
            this.cancelVisitRecovery?.();
            this.entry.cancel();
            await leaveCurrentTown(this.browser, this.lifetime.signal);
            await this.browser.rooms.createAndSwitch({
                ...GRUMPY_TOWN_SCOPE,
                displayName: 'Grumpy Town',
                joinMode: 'open',
                directoryListing: 'unlisted',
                maxMembers: 4,
                maxSessionsPerMember: 1,
                signal: this.lifetime.signal
            });
        });
    }

    async inviteGuests(): Promise<void> {
        await this.run(async () => {
            const room = this.rooms.currentRoomRef;
            const owner = this.browser.session()?.clientId;
            if (!room || !owner || !this.getState().ownsTown) {
                return;
            }
            clearTimeout(this.invitationTimeout);
            this.invitation = undefined;
            const issuedAt = performance.now();
            const { link } = await issueTownInvitation(this.browser, room, this.lifetime.signal);
            if (this.lifetime.signal.aborted) return;
            this.invitation = { groupId: room.groupId, owner, link };
            this.invitationTimeout = setTimeout(() => {
                this.invitation = undefined;
                this.publish();
            }, Math.max(0, 15 * 60_000 - (performance.now() - issuedAt)));
        });
    }

    async removeGuest(principalId: string): Promise<void> {
        await this.run(async () => {
            const { rooms, ownsTown } = this.getState();
            const room = rooms.currentRoomRef;
            const guest = rooms.currentRoom?.members.find(member => member.principalId === principalId);
            if (!ownsTown || !room || guest?.status !== 'active' || !guest.guestLease) {
                return;
            }
            await this.browser.rooms.removeMember(room, principalId, { signal: this.lifetime.signal });
            clearTimeout(this.invitationTimeout);
            this.invitation = undefined;
        });
    }

    async joinTown(groupId: string): Promise<void> {
        await this.run(async () => {
            this.cancelVisitRecovery?.();
            this.entry.enter({
                intent: 'join',
                roomRef: { ...GRUMPY_TOWN_SCOPE, groupId },
                joinCode: null,
                participation: 'player'
            });
            await this.resumeDestination();
        });
    }

    async enterMatchmaking(): Promise<void> {
        await this.run(async () => {
            this.cancelVisitRecovery?.();
            await this.matchmaking.enter();
            await this.resumeDestination();
        });
    }

    async actMatchmaking(action: OnlineSession.MatchmakingAction): Promise<void> {
        if (this.busy || this.matchmakingAction || this.lifetime.signal.aborted) {
            return;
        }
        this.matchmakingAction = this.run(async () => {
            switch (action) {
                case 'find':
                    await this.matchmaking.find();
                    break;
                case 'confirm':
                    await this.matchmaking.confirm();
                    break;
                case 'cancel':
                    await this.matchmaking.cancel();
                    break;
                case 'retry':
                    await this.matchmaking.retry();
                    break;
            }
        });
        await this.matchmakingAction;
        this.matchmakingAction = null;
    }

    async enterInvitation(invitationId: string): Promise<void> {
        await this.run(async () => {
            this.cancelVisitRecovery?.();
            await this.friends.openInvitation(invitationId);
            await this.resumeDestination();
        });
    }

    async leaveTown(): Promise<void> {
        await this.run(async () => {
            this.cancelVisitRecovery?.();
            this.entry.cancel();
            await leaveCurrentTown(this.browser, this.lifetime.signal);
            this.cancelVisitRecovery?.();
        });
    }

    async logout(): Promise<void> {
        await this.run(async () => {
            this.cancelVisitRecovery?.();
            this.entry.cancel();
            try {
                await this.finishSearch();
                await leaveCurrentTown(this.browser, this.lifetime.signal);
            }
            finally {
                await this.browser.auth.logout({ signal: this.lifetime.signal });
                this.connected = false;
            }
        });
    }

    async stop(): Promise<void> {
        if (this.lifetime.signal.aborted) {
            return;
        }
        clearTimeout(this.invitationTimeout);
        this.lifetime.abort();
        this.subscriptions.unsubscribe();
        this.entry.stop();
        try {
            await this.finishSearch();
        }
        finally {
            this.friends.stop();
            this.matchmaking.stop();
            await this.browser.disconnect();
        }
    }

    private async run(operation: () => Promise<void>): Promise<void> {
        if (this.busy || this.lifetime.signal.aborted) {
            return;
        }
        this.busy = true;
        this.error = '';
        this.publish();
        try {
            await operation();
        }
        catch (error) {
            if (!this.lifetime.signal.aborted) {
                this.error = error instanceof Error ? error.message : 'Could not reach Rallar. Try again.';
            }
        }
        finally {
            this.busy = false;
            this.publish();
        }
    }

    private async startAccount(): Promise<void> {
        if (this.lifetime.signal.aborted) {
            return;
        }
        await Promise.all([this.friends.start(), this.matchmaking.start()]);
        await this.resumeDestination();
    }

    private async resumeDestination(): Promise<void> {
        if (this.lifetime.signal.aborted) {
            return;
        }
        const destination = this.entry.getState().destination;
        const current = this.browser.rooms.state().currentRoomRef;
        if (destination && current && !isSameGroupRef(destination.roomRef, current)) {
            await leaveCurrentTown(this.browser, this.lifetime.signal);
            this.entry.enter(destination);
        }
        await this.entry.resume();
    }

    private async finishSearch(): Promise<void> {
        await this.matchmakingAction;
        if (this.matchmaking.getState().retryPending) {
            await this.matchmaking.retry();
        }
        if (this.browser.session() && !this.matchmaking.getState().view) {
            await this.matchmaking.refresh();
        }
        if (!this.matchmaking.getState().retryPending) {
            await this.matchmaking.cancel();
        }
        const state = this.matchmaking.getState();
        if (
            (this.browser.session() && !state.view) || state.retryPending ||
            state.view?.state.status === 'searching' || state.view?.state.status === 'confirming'
        ) {
            throw new Error('Search cancellation could not be confirmed. Reopen online play to retry.');
        }
    }

    private publish(): void {
        if (!this.lifetime.signal.aborted) {
            this.changes.publishLatest(undefined);
        }
    }
}

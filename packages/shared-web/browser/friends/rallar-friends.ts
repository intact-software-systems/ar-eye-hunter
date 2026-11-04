import type { FriendsMutationResult, FriendsRefusal, FriendsRequest } from '@shared/api/friends/friends-request.ts';
import { decodeFriendsView, type FriendsView } from '@shared/api/friends/friends-view.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { AuthenticatedResource } from '../api/authenticated-resource.ts';
import { subscribeViewDeadline } from '../api/subscribe-view-deadline.ts';
import { subscribeViewInvalidations, type SubscribeViewInvalidations } from '../api/subscribe-view-invalidations.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { friendsHttpApi } from './friends-http-api.ts';

const FRIENDS_REFUSAL_MESSAGES: Readonly<Record<FriendsRefusal, string>> = {
    'request-unavailable': 'This friend request is no longer available. Refresh to see the current status.',
    'person-unavailable': 'This person is unavailable for that request.',
    unauthorized: 'Sign in again to update your friends.',
    capacity: 'A friend list or invitation limit has been reached. Remove an old contact or invitation and try again.',
    'friend-required': 'Both people must accept friendship before sending invitations.',
    'destination-unavailable': 'This room or scheduled session is no longer available to invite people to.',
    'invitation-expired': 'This invitation has expired. Send a new invitation.'
};

export namespace RallarFriends {
    export interface Config {
        readonly scope: StateScope;
    }
    export interface Api {
        read(input: AuthenticatedResource.ReadInput): Promise<FriendsView>;
        change(input: AuthenticatedResource.ChangeInput<FriendsRequest>): Promise<FriendsMutationResult>;
    }
    export interface Dependencies extends AuthenticatedResource.Dependencies {
        readonly api: Api;
        onChanged(listener: () => Promise<void>): () => void;
        readonly entry: Pick<RallarRoomEntry, 'enter'>;
    }
}

/** Account-bound social consent. Entry and game owners retain admission and gameplay authority. */
export class RallarFriends extends AuthenticatedResource<FriendsView, FriendsRequest> {
    private readonly entry: Pick<RallarRoomEntry, 'enter'>;
    private readonly friendsDependencies: RallarFriends.Dependencies;

    static createBrowser(
        browser: SubscribeViewInvalidations.Browser & Pick<RallarRoomEntry.Browser, 'auth'>,
        entry: RallarRoomEntry,
        config: RallarFriends.Config
    ): RallarFriends {
        return new RallarFriends({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            onChanged: (changed) =>
                subscribeViewInvalidations({ browser, scope: config.scope, resource: 'friends', changed }),
            api: friendsHttpApi,
            entry,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    constructor(dependencies: RallarFriends.Dependencies, config: RallarFriends.Config) {
        super(dependencies, { scope: config.scope, subscribeRefresh: (refresh) => this.subscribeRefresh(refresh) }, {
            async read(attempt) {
                const view = decodeFriendsView(await dependencies.api.read(attempt));
                if (view.principalId !== attempt.session.clientId) {
                    throw new TypeError('Friends response belongs to another account');
                }
                return view;
            },
            async change(attempt) {
                const result = await dependencies.api.change(attempt);
                if (result.principalId !== attempt.session.clientId || result.requestId !== attempt.requestId) {
                    throw new TypeError('Friends result belongs to another command');
                }
                return result.status === 'refused' ? FRIENDS_REFUSAL_MESSAGES[result.code] : null;
            }
        });
        this.entry = dependencies.entry;
        this.friendsDependencies = dependencies;
    }

    private subscribeRefresh(refresh: () => Promise<void>): () => void {
        const subscriptions = new SubscriptionScope();
        subscriptions.add(this.friendsDependencies.onChanged(refresh));
        subscriptions.add(subscribeViewDeadline<FriendsView>({
            onChange: (listener) => this.onChange(listener),
            timers: this.friendsDependencies.timers,
            remainingMs: (view) =>
                view.invitations.length === 0
                    ? null
                    : Math.min(...view.invitations.map((invitation) => invitation.expiresAtEpochMs)) -
                        view.observedAtEpochMs,
            refresh
        }));
        return () => subscriptions.unsubscribe();
    }

    async openInvitation(invitationId: string): Promise<void> {
        const attempt = this.beginOperation();
        if (attempt === null) {
            return;
        }
        try {
            await this.refresh();
            if (!this.current(attempt)) {
                return;
            }
            const invitation = this.getState().view?.invitations.find((candidate) =>
                candidate.invitationId === invitationId
            );
            if (invitation === undefined) {
                this.setError('This invitation is no longer available.');
                return;
            }
            if (
                invitation.roomRef.applicationId !== attempt.scope.applicationId ||
                invitation.roomRef.workspaceId !== attempt.scope.workspaceId
            ) {
                this.setError('Open this invitation in its game and workspace.');
                return;
            }
            this.entry.enter({
                intent: invitation.kind === 'scheduled-session' ? 'preview-session' : 'join',
                roomRef: invitation.roomRef,
                joinCode: null,
                participation: 'player'
            });
        }
        catch (error) {
            if (this.current(attempt)) {
                this.setError(toError(error).message);
            }
        }
        finally {
            this.finishOperation(attempt);
        }
    }
}

import type { GroupRef } from '../group-types.ts';
import type { FriendshipAction, FriendshipRefusal } from './friendship.ts';

export type FriendsRequest =
    | { readonly action: 'request'; readonly username: string; }
    | { readonly action: Exclude<FriendshipAction, 'request'>; readonly principalId: string; }
    | { readonly action: 'visibility'; readonly shareOnline: boolean; }
    | {
        readonly action: 'invite';
        readonly principalId: string;
        readonly kind: 'room' | 'scheduled-session';
        readonly roomRef: GroupRef;
    }
    | { readonly action: 'dismiss'; readonly invitationId: string; };

export type FriendsRefusal =
    | FriendshipRefusal
    | 'unauthorized'
    | 'capacity'
    | 'friend-required'
    | 'destination-unavailable'
    | 'invitation-expired';

export type FriendsMutationResult =
    | { readonly principalId: string; readonly requestId: string; readonly status: 'applied'; }
    | {
        readonly principalId: string;
        readonly requestId: string;
        readonly status: 'refused';
        readonly code: FriendsRefusal;
    };

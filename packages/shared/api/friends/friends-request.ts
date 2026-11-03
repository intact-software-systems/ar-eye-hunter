import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { assertValidRallarGroupRef } from '../rallar-validation.ts';
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

export function decodeFriendsRequest(value: unknown): FriendsRequest {
    const request = requireRecord(value, 'Friends request');
    if (request.action === 'request') {
        requireExactKeys(request, ['action', 'username'], 'Friend request');
        requireString(request.username, 'Friend username');
        return { action: 'request', username: request.username };
    }
    if (request.action === 'visibility') {
        requireExactKeys(request, ['action', 'shareOnline'], 'Friends visibility');
        if (typeof request.shareOnline !== 'boolean') {
            throw new TypeError('Friends visibility must be boolean');
        }
        return { action: 'visibility', shareOnline: request.shareOnline };
    }
    if (request.action === 'dismiss') {
        requireExactKeys(request, ['action', 'invitationId'], 'Dismiss invitation');
        requireString(request.invitationId, 'Invitation identity');
        return { action: 'dismiss', invitationId: request.invitationId };
    }
    if (request.action === 'invite') {
        requireExactKeys(request, ['action', 'principalId', 'kind', 'roomRef'], 'Friend invitation');
        requireString(request.principalId, 'Invitation recipient');
        const kind = requireOneOf(request.kind, ['room', 'scheduled-session'], 'Invitation kind');
        const roomRef = requireRecord(request.roomRef, 'Invitation destination');
        requireExactKeys(roomRef, ['applicationId', 'workspaceId', 'groupId'], 'Invitation destination');
        return {
            action: 'invite',
            principalId: request.principalId,
            kind,
            roomRef: assertValidRallarGroupRef(roomRef)
        };
    }
    requireExactKeys(request, ['action', 'principalId'], 'Friendship change');
    requireString(request.principalId, 'Friendship principal');
    const action = requireOneOf(
        request.action,
        ['accept', 'decline', 'cancel', 'remove', 'block', 'unblock'],
        'Friendship action'
    );
    return { action, principalId: request.principalId };
}

export function decodeFriendsMutationResult(value: unknown): FriendsMutationResult {
    const result = requireRecord(value, 'Friends mutation result');
    requireString(result.principalId, 'Friends result principal');
    requireString(result.requestId, 'Friends result request');
    const status = requireOneOf(result.status, ['applied', 'refused'], 'Friends result status');
    if (status === 'applied') {
        requireExactKeys(result, ['principalId', 'requestId', 'status'], 'Friends result');
        return { principalId: result.principalId, requestId: result.requestId, status };
    }
    requireExactKeys(result, ['principalId', 'requestId', 'status', 'code'], 'Friends result');
    const code = requireOneOf(result.code, [
        'request-unavailable',
        'person-unavailable',
        'unauthorized',
        'capacity',
        'friend-required',
        'destination-unavailable',
        'invitation-expired'
    ], 'Friends refusal');
    return { principalId: result.principalId, requestId: result.requestId, status, code };
}

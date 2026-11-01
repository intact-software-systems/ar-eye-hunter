import type { FriendsMutationResult, FriendsRequest } from '@shared/api/friends/friends-request.ts';

import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import type { FriendsProfile } from './friends-profile.ts';

export interface FriendsCommand {
    readonly principalId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly sessionExpiresAtEpochMs: number;
    readonly requestId: string;
    readonly request: FriendsRequest;
    readonly capturedAtEpochMs: number | null;
}

export interface FriendsConfig {
    readonly maxContacts: number;
    readonly maxInvitations: number;
    readonly invitationLifetimeMs: number;
}

export interface FriendsProfileRead {
    readonly entry: RuntimeStateEntry | null;
    readonly profile: FriendsProfile;
}

export interface FriendsMutationRead {
    readonly input: FriendsCommand;
    readonly actor: FriendsProfileRead;
    readonly target: FriendsProfileRead | null;
    readonly authorized: boolean;
    readonly targetAvailable: boolean;
    readonly destinationAvailable: boolean;
    readonly nowEpochMs: number;
    readonly config: FriendsConfig;
}

export interface FriendsProfileWrite {
    readonly key: string;
    readonly expectedRevision: number | null;
    readonly value: string;
    readonly expireAtTimestamp: number;
}

export interface FriendsMutationComputed {
    readonly read: FriendsMutationRead;
    readonly profiles: readonly FriendsProfile[];
    readonly writes: readonly FriendsProfileWrite[];
    readonly result: FriendsMutationResult;
}

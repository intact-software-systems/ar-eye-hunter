import type { FriendsMutationResult, FriendsRequest } from '@shared/api/friends/friends-request.ts';
import type { RuntimeStateGuardedBatchUpdate } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { GroupStateAuthoritativeSnapshot } from '../group-state/persistence/group-state-persistence-contracts.ts';

import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
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
    readonly session: RuntimeStateEntryValue<PersistedAuthSession> | null;
    readonly targetAvailable: boolean;
    readonly destination: GroupStateAuthoritativeSnapshot | null;
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
    readonly guards: readonly RuntimeStateGuardedBatchUpdate[];
    readonly result: FriendsMutationResult;
}

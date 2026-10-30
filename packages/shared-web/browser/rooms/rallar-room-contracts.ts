import type {
    RallarRoomMessageChannelDefinition,
    RallarStateEventListener,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRoomRealtimeJsonChannel,
    RallarRoomRealtimeJsonDefaults
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarReadinessEvaluation, RallarReadinessExpectation } from '@shared-web/browser/readiness.ts';
import type {
    CreateStateGroupBody,
    GroupEvent,
    GroupEventType,
    GroupJoinMode,
    GroupMemberStatus,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    GroupStatus,
    RotateStateGroupJoinCodeBody,
    StateEventCursor,
    StateScope,
    UpdateStateGroupBody
} from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { QuickJoinGroupRequest } from '@shared/api/mutation/group-quick-join.ts';

import type { RallarRoomFormation } from './formation/rallar-room-formation-contracts.ts';

export interface RallarRoomSummary {
    readonly roomId: string;
    readonly roomRef: GroupRef;
    readonly name: string;
    readonly status: GroupStatus;
    readonly kind: GroupSnapshot['group']['kind'];
    readonly joinMode: GroupJoinMode;
    readonly memberCount: number;
    readonly onlineMemberCount: number;
    readonly isJoined: boolean;
    readonly isCurrent: boolean;
    readonly snapshot: GroupSnapshot;
}

export interface RallarRoomMember {
    readonly principalId: string;
    readonly username: string;
    readonly displayName?: string;
    readonly role: GroupRole;
    readonly status: GroupMemberStatus;
    readonly isOwner: boolean;
    readonly isOnline: boolean;
    readonly sessionIds: readonly string[];
    readonly client?: ClientSnapshot;
    /** The member's effective permission on each topic its grant row names; `{}` without a row. */
    readonly topicGrants: Readonly<Record<string, RallarRoomTopicGrant>>;
}

export type RallarRoomTopicRole = 'publisher' | 'subscriber' | 'publisher-subscriber' | 'none';

/** Effective, as the server decides: only an active member holds a permission, and a spectator never publishes. */
export interface RallarRoomTopicGrant extends GroupPublicationTopicPermissions {
    readonly role: RallarRoomTopicRole;
}

export interface RallarRoomState {
    readonly rooms: readonly RallarRoomSummary[];
    readonly currentRoomId?: string;
    readonly currentRoomRef?: GroupRef;
    readonly currentRoom?: GroupSnapshot;
    readonly members: readonly RallarRoomMember[];
}

export interface RallarRoomPresenceWaitOptions extends RallarScopedOperationOptions {
    readonly expect?: RallarReadinessExpectation;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export interface RallarRoomPresenceWaitResult extends RallarReadinessEvaluation {
    readonly roomId: string;
    readonly roomRef?: GroupRef;
    readonly activeSessionIds: readonly string[];
    readonly timedOut: boolean;
}

export interface RallarCreateRoomInput extends
    RallarScopedOperationOptions,
    Pick<
        CreateStateGroupBody,
        | 'description'
        | 'joinMode'
        | 'directoryListing'
        | 'retention'
        | 'maxMembers'
        | 'maxSpectators'
        | 'maxSessionsPerMember'
        | 'metadata'
        | 'expiresAtEpochMs'
        | 'purgeAfterEpochMs'
        | 'lifecyclePolicy'
    > {
    readonly groupId?: string;
    readonly displayName: string;
}

export interface RallarRoomTargetInput extends RallarScopedOperationOptions {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}

export interface RallarUpdateRoomInput extends
    RallarRoomTargetInput,
    Pick<
        UpdateStateGroupBody,
        | 'slug'
        | 'displayName'
        | 'description'
        | 'kind'
        | 'joinMode'
        | 'directoryListing'
        | 'maxMembers'
        | 'maxSpectators'
        | 'maxSessionsPerMember'
        | 'metadata'
        | 'expiresAtEpochMs'
        | 'purgeAfterEpochMs'
    > {}

export interface RallarRoomLifecycleOptions extends RallarScopedOperationOptions {
    readonly reason?: string;
}

export interface RallarRoomInviteOptions extends RallarScopedOperationOptions {
    readonly invitationExpiresAtEpochMs?: number;
    readonly reason?: string;
}

export interface RallarRoomJoinCodeOptions
    extends RallarRoomGovernanceOptions, Pick<RotateStateGroupJoinCodeBody, 'joinCode' | 'expiresAtEpochMs'> {}

export interface RallarRoomGovernanceOptions extends RallarScopedOperationOptions {
    readonly reason?: string;
}

export interface RallarSetRoomMemberRoleInput {
    readonly room: string | GroupRef | RallarRoomTargetInput;
    readonly principalId: string;
    readonly role: GroupRole;
    readonly options?: RallarRoomGovernanceOptions;
}

export interface RallarRoomTopicMember {
    readonly room: string | GroupRef | RallarRoomTargetInput;
    readonly principalId: string;
    readonly options?: RallarRoomGovernanceOptions;
}

export interface RallarJoinRoomOptions extends RallarScopedOperationOptions {
    /** Omit to recover existing membership without changing participation. */
    readonly participation?: 'player' | 'spectator';
    readonly roomRef?: GroupRef;
    readonly leaveCurrent?: boolean;
    readonly inviteToken?: string;
    readonly joinCode?: string;
}

export interface RallarJoinRoomInput extends RallarJoinRoomOptions {
    readonly roomId?: string;
}

export interface RallarQuickJoinRoomInput
    extends RallarScopedOperationOptions, Pick<QuickJoinGroupRequest, 'kind' | 'q' | 'includeEmpty'> {
    readonly leaveCurrent?: boolean;
}

/** Admission committed, but connecting or adopting the room failed. */
export interface RallarQuickJoinPartialFailureError extends Error {
    readonly name: 'RallarQuickJoinPartialFailureError';
    readonly joinedRoom: GroupSnapshot;
}

/** Admission committed, but presence or local adoption failed. */
export interface RallarRoomJoinPartialFailureError extends Error {
    readonly name: 'RallarRoomJoinPartialFailureError';
    readonly joinedRoom: GroupSnapshot;
}

export type RallarRoomSwitchOperation = 'join' | 'quick-join' | 'create-and-switch';

export interface RallarRoomSwitchPartialFailureError extends Error {
    readonly name: 'RallarRoomSwitchPartialFailureError';
    readonly operation: RallarRoomSwitchOperation;
    readonly joinedRoom: GroupSnapshot;
    readonly previousRoomRef: GroupRef;
    readonly leaveError: Error;
}

export interface RallarLeaveRoomOptions extends RallarScopedOperationOptions {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly clearCurrent?: boolean;
}

export interface RallarRoomEventOptions {
    readonly scope?: StateScope;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly eventTypes?: readonly GroupEventType[];
}

export interface RallarListRoomEventsOptions extends RallarScopedOperationOptions {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly eventTypes?: readonly GroupEventType[];
    readonly limit?: number;
    readonly after?: StateEventCursor;
}

export type RallarListRoomEventsInput = string | RallarListRoomEventsOptions;

export interface RallarReplayRoomEventsOptions extends RallarListRoomEventsOptions {
    readonly maxPages?: number;
    readonly listener?: RallarStateEventListener<GroupEvent>;
}

export type RallarReplayRoomEventsInput = string | RallarReplayRoomEventsOptions;

export type RallarRoomSessionRealtimeInput = string | RallarRoomRealtimeJsonDefaults;

export type RallarRoomSessionMessageDefinition = string | RallarRoomMessageChannelDefinition;

export interface RallarRoomSession {
    readonly roomId: string;
    readonly roomRef: GroupRef;
    readonly formation: RallarRoomFormation;
    snapshot(): GroupSnapshot | undefined;
    summary(): RallarRoomSummary | undefined;
    leave(
        options?: Omit<RallarLeaveRoomOptions, 'roomId' | 'roomRef'>
    ): Promise<GroupSnapshot | undefined>;
    refresh(options?: RallarScopedOperationOptions): Promise<RallarRoomSession>;
    realtime<T>(
        laneIdOrOptions?: RallarRoomSessionRealtimeInput
    ): RallarRoomRealtimeJsonChannel<T>;
    message<T>(
        nameOrDefinition: RallarRoomSessionMessageDefinition
    ): RallarTypedMessageChannel<T>;
    /** The session principal's effective role on the topic in the cached snapshot; `none` with no snapshot cached. */
    topicRole(topicId: string): RallarRoomTopicRole;
}

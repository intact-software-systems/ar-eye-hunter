import type {
  RallarRefreshOptions,
  RallarScopedOperationOptions,
} from '@shared-web/browser/rallar-connection-facade.ts';
import type {
  RallarRoomMessageChannel,
  RallarRoomMessageChannelDefinition,
  RallarStateEventListener,
} from '@shared-web/browser/rallar-messages-facade.ts';
import type {
  RallarRoomRealtimeJsonChannel,
  RallarRoomRealtimeJsonDefaults,
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
  RallarReadinessEvaluation,
  RallarReadinessExpectation,
} from '@shared-web/browser/readiness.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
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
  StateEventCursor,
  StateScope,
  UpdateStateGroupBody,
} from '@shared-web/browser/rooms/room-group-state-translation.ts';

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
}

export interface RallarRoomState {
  readonly rooms: readonly RallarRoomSummary[];
  readonly currentRoomId?: string;
  readonly currentRoomRef?: GroupRef;
  readonly currentRoom?: GroupSnapshot;
  readonly members: readonly RallarRoomMember[];
}

export type RallarRoomPresenceWaitOptions = RallarScopedOperationOptions &
  Readonly<{
    expect?: RallarReadinessExpectation;
    timeoutMs?: number;
    signal?: AbortSignal;
  }>;

export type RallarRoomPresenceWaitResult = RallarReadinessEvaluation &
  Readonly<{
    roomId: string;
    roomRef?: GroupRef;
    activeSessionIds: readonly string[];
    timedOut: boolean;
  }>;

export type RallarCreateRoomInput = RallarScopedOperationOptions &
  Readonly<{
    groupId?: string;
    displayName: string;
  }> &
  Readonly<
    Pick<
      CreateStateGroupBody,
      | 'description'
      | 'joinMode'
      | 'maxMembers'
      | 'maxSessionsPerMember'
      | 'metadata'
      | 'expiresAtEpochMs'
      | 'purgeAfterEpochMs'
    >
  >;

export type RallarRoomTargetInput = RallarScopedOperationOptions &
  Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
  }>;

export type RallarUpdateRoomInput = RallarRoomTargetInput &
  Readonly<
    Pick<
      UpdateStateGroupBody,
      | 'slug'
      | 'displayName'
      | 'description'
      | 'kind'
      | 'joinMode'
      | 'maxMembers'
      | 'maxSessionsPerMember'
      | 'metadata'
      | 'expiresAtEpochMs'
      | 'purgeAfterEpochMs'
    >
  >;

export type RallarRoomLifecycleOptions = RallarScopedOperationOptions &
  Readonly<{
    reason?: string;
  }>;

export type RallarRoomInviteOptions = RallarScopedOperationOptions &
  Readonly<{
    invitationExpiresAtEpochMs?: number;
    reason?: string;
  }>;

export type RallarRoomGovernanceOptions = RallarScopedOperationOptions &
  Readonly<{
    reason?: string;
  }>;

export type RallarJoinRoomOptions = RallarScopedOperationOptions &
  Readonly<{
    roomRef?: GroupRef;
    leaveCurrent?: boolean;
    inviteToken?: string;
    joinCode?: string;
  }>;

export type RallarJoinRoomInput = RallarJoinRoomOptions &
  Readonly<{
    roomId?: string;
  }>;

export type RallarRoomSwitchOperation = 'join' | 'create-and-switch';

export type RallarRoomSwitchPartialFailureError = Error &
  Readonly<{
    name: 'RallarRoomSwitchPartialFailureError';
    operation: RallarRoomSwitchOperation;
    joinedRoom: GroupSnapshot;
    previousRoomRef: GroupRef;
    leaveError: unknown;
  }>;

export type RallarLeaveRoomOptions = RallarScopedOperationOptions &
  Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    clearCurrent?: boolean;
  }>;

export interface RallarRoomEventOptions {
  readonly scope?: StateScope;
  readonly roomId?: string;
  readonly roomRef?: GroupRef;
  readonly eventTypes?: readonly GroupEventType[];
}

export type RallarListRoomEventsOptions = RallarScopedOperationOptions &
  Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    eventTypes?: readonly GroupEventType[];
    limit?: number;
    after?: StateEventCursor;
  }>;

export type RallarListRoomEventsInput = string | RallarListRoomEventsOptions;

export type RallarReplayRoomEventsOptions = RallarListRoomEventsOptions &
  Readonly<{
    maxPages?: number;
    listener?: RallarRoomEventListener;
  }>;

export type RallarReplayRoomEventsInput = string | RallarReplayRoomEventsOptions;

export type RallarRoomEventListener = RallarStateEventListener<GroupEvent>;

export type RallarRoomSessionRealtimeInput = string | RallarRoomRealtimeJsonDefaults;

export type RallarRoomSessionMessageDefinition = string | RallarRoomMessageChannelDefinition;

export type RallarRoomSession = Readonly<{
  roomId: string;
  roomRef: GroupRef;
  snapshot(): GroupSnapshot | undefined;
  summary(): RallarRoomSummary | undefined;
  leave(
    options?: Omit<RallarLeaveRoomOptions, 'roomId' | 'roomRef'>,
  ): Promise<GroupSnapshot | undefined>;
  refresh(options?: RallarRefreshOptions): Promise<RallarRoomSession>;
  realtime<T>(laneIdOrOptions?: RallarRoomSessionRealtimeInput): RallarRoomRealtimeJsonChannel<T>;
  message<T>(nameOrDefinition: RallarRoomSessionMessageDefinition): RallarRoomMessageChannel<T>;
}>;

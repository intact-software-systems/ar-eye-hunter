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
  GroupEvent,
  GroupEventType,
  GroupJoinMode,
  GroupMemberStatus,
  GroupRef,
  GroupRole,
  GroupSnapshot,
  GroupStatus,
} from '@shared/api/group-types.ts';
import type { StateEventCursor } from '@shared/api/state-event-types.ts';
import type {
  CreateGroupRequest,
  StateScope,
  UpdateGroupRequest,
} from '@shared/api/state-types.ts';

export type RallarRoomSummary = Readonly<{
  roomId: string;
  roomRef: GroupRef;
  name: string;
  status: GroupStatus;
  kind: GroupSnapshot['group']['kind'];
  joinMode: GroupJoinMode;
  memberCount: number;
  onlineMemberCount: number;
  isJoined: boolean;
  isCurrent: boolean;
  snapshot: GroupSnapshot;
}>;

export type RallarRoomMember = Readonly<{
  principalId: string;
  username: string;
  displayName?: string;
  role: GroupRole;
  status: GroupMemberStatus;
  isOwner: boolean;
  isOnline: boolean;
  sessionIds: readonly string[];
  client?: ClientSnapshot;
}>;

export type RallarRoomState = Readonly<{
  rooms: readonly RallarRoomSummary[];
  currentRoomId?: string;
  currentRoomRef?: GroupRef;
  currentRoom?: GroupSnapshot;
  members: readonly RallarRoomMember[];
}>;

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
      CreateGroupRequest,
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
      UpdateGroupRequest,
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

export type RallarRoomEventOptions = Readonly<{
  scope?: StateScope;
  roomId?: string;
  roomRef?: GroupRef;
  eventTypes?: readonly GroupEventType[];
}>;

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

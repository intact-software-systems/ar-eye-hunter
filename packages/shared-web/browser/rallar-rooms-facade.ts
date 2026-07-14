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
    RallarOnChangeOptions,
    RallarReplayEventsResult,
    RallarStateListener,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
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
import type {
    StateEventCursor,
    StateEventPage,
} from '@shared/api/state-event-types.ts';
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

export type RallarRoomPresenceWaitOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    expect?: RallarReadinessExpectation;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

export type RallarRoomPresenceWaitResult =
    & RallarReadinessEvaluation
    & Readonly<{
    roomId: string;
    roomRef?: GroupRef;
    activeSessionIds: readonly string[];
    timedOut: boolean;
}>;

export type RallarCreateRoomInput =
    & RallarScopedOperationOptions
    & Readonly<{
    groupId?: string;
    displayName: string;
}>
    & Readonly<
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

export type RallarRoomTargetInput =
    & RallarScopedOperationOptions
    & Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
}>;

export type RallarUpdateRoomInput =
    & RallarRoomTargetInput
    & Readonly<
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

export type RallarRoomLifecycleOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    reason?: string;
}>;

export type RallarRoomInviteOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    invitationExpiresAtEpochMs?: number;
    reason?: string;
}>;

export type RallarRoomGovernanceOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    reason?: string;
}>;

export type RallarJoinRoomOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    roomRef?: GroupRef;
    leaveCurrent?: boolean;
    inviteToken?: string;
    joinCode?: string;
}>;

export type RallarJoinRoomInput =
    & RallarJoinRoomOptions
    & Readonly<{
    roomId?: string;
}>;

export type RallarRoomSwitchOperation =
    | 'join'
    | 'create-and-switch';

export type RallarRoomSwitchPartialFailureError =
    & Error
    & Readonly<{
    name: 'RallarRoomSwitchPartialFailureError';
    operation: RallarRoomSwitchOperation;
    joinedRoom: GroupSnapshot;
    previousRoomRef: GroupRef;
    leaveError: unknown;
}>;

export type RallarLeaveRoomOptions =
    & RallarScopedOperationOptions
    & Readonly<{
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

export type RallarListRoomEventsOptions =
    & RallarScopedOperationOptions
    & Readonly<{
    roomId?: string;
    roomRef?: GroupRef;
    eventTypes?: readonly GroupEventType[];
    limit?: number;
    after?: StateEventCursor;
}>;

export type RallarListRoomEventsInput = string | RallarListRoomEventsOptions;

export type RallarReplayRoomEventsOptions =
    & RallarListRoomEventsOptions
    & Readonly<{
    maxPages?: number;
    listener?: RallarRoomEventListener;
}>;

export type RallarReplayRoomEventsInput =
    | string
    | RallarReplayRoomEventsOptions;

export type RallarRoomEventListener = RallarStateEventListener<GroupEvent>;

export type RallarRoomSessionRealtimeInput =
    | string
    | RallarRoomRealtimeJsonDefaults;

export type RallarRoomSessionMessageDefinition =
    | string
    | RallarRoomMessageChannelDefinition;

export type RallarRoomSession = Readonly<{
    roomId: string;
    roomRef: GroupRef;
    snapshot(): GroupSnapshot | undefined;
    summary(): RallarRoomSummary | undefined;
    leave(
        options?: Omit<RallarLeaveRoomOptions, 'roomId' | 'roomRef'>,
    ): Promise<GroupSnapshot | undefined>;
    refresh(options?: RallarRefreshOptions): Promise<RallarRoomSession>;
    realtime<T>(
        laneIdOrOptions?: RallarRoomSessionRealtimeInput,
    ): RallarRoomRealtimeJsonChannel<T>;
    message<T>(
        nameOrDefinition: RallarRoomSessionMessageDefinition,
    ): RallarRoomMessageChannel<T>;
}>;

export type RallarRoomsFacade = Readonly<{
    state(): RallarRoomState;
    list(): readonly RallarRoomSummary[];
    refresh(input?: StateScope | RallarRefreshOptions): Promise<RallarRoomState>;
    listEvents(
        input: RallarListRoomEventsInput,
    ): Promise<readonly GroupEvent[]>;
    listEventPage(
        input: RallarListRoomEventsInput,
    ): Promise<StateEventPage<GroupEvent>>;
    replayEvents(
        input: RallarReplayRoomEventsInput,
        listener?: RallarRoomEventListener,
    ): Promise<RallarReplayEventsResult<GroupEvent>>;
    create(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
    createAndSwitch(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
    join(
        room: string | GroupRef | RallarJoinRoomInput,
        options?: RallarJoinRoomOptions,
    ): Promise<GroupSnapshot>;
    enter(
        room: string | GroupRef | RallarJoinRoomInput,
        options?: RallarJoinRoomOptions,
    ): Promise<RallarRoomSession>;
    session(room?: string | GroupRef): RallarRoomSession;
    leave(
        input?: string | RallarLeaveRoomOptions,
    ): Promise<GroupSnapshot | undefined>;
    update(input: RallarUpdateRoomInput): Promise<GroupSnapshot>;
    archive(
        room: string | GroupRef | RallarRoomTargetInput,
        options?: RallarRoomLifecycleOptions,
    ): Promise<GroupSnapshot>;
    delete(
        room: string | GroupRef | RallarRoomTargetInput,
        options?: RallarRoomLifecycleOptions,
    ): Promise<GroupSnapshot>;
    invite(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomInviteOptions,
    ): Promise<GroupSnapshot>;
    acceptInvite(
        room: string | GroupRef | RallarRoomTargetInput,
        options?: RallarScopedOperationOptions,
    ): Promise<GroupSnapshot>;
    removeMember(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions,
    ): Promise<GroupSnapshot>;
    banMember(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions,
    ): Promise<GroupSnapshot>;
    unbanMember(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions,
    ): Promise<GroupSnapshot>;
    setMemberRole(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        role: GroupRole,
        options?: RallarRoomGovernanceOptions,
    ): Promise<GroupSnapshot>;
    transferOwnership(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions,
    ): Promise<GroupSnapshot>;
    updateMetadata(
        room: string | GroupRef,
        patch: Readonly<Record<string, unknown>>,
        options?: RallarScopedOperationOptions,
    ): Promise<GroupSnapshot>;
    waitForPresence(
        room: string | GroupRef,
        options?: RallarRoomPresenceWaitOptions,
    ): Promise<RallarRoomPresenceWaitResult>;
    current(): GroupSnapshot | undefined;
    onChange(
        listener: RallarStateListener<RallarRoomState>,
        options?: RallarOnChangeOptions,
    ): RallarUnsubscribe;
    onEvent(
        listener: RallarRoomEventListener,
        options?: RallarRoomEventOptions,
    ): RallarUnsubscribe;
}>;

export type CreateRallarRoomsFacadeOptions =
    & Omit<RallarRoomsFacade, 'createAndSwitch'>
    & Readonly<{
    createAndSwitch?: RallarRoomsFacade['createAndSwitch'];
}>;

export function createRallarRoomsFacade(
    operations: CreateRallarRoomsFacadeOptions,
): RallarRoomsFacade {
    return {
        state: (): RallarRoomState => operations.state(),
        list: (): readonly RallarRoomSummary[] => operations.list(),
        refresh: async (input): Promise<RallarRoomState> =>
            await operations.refresh(input),
        listEvents: async (
            input,
        ): Promise<readonly GroupEvent[]> =>
            await operations.listEvents(input),
        listEventPage: async (
            input,
        ): Promise<StateEventPage<GroupEvent>> =>
            await operations.listEventPage(input),
        replayEvents: async (
            input,
            listener,
        ): Promise<RallarReplayEventsResult<GroupEvent>> =>
            await operations.replayEvents(input, listener),
        create: async (
            input,
        ): Promise<GroupSnapshot> => await operations.create(input),
        createAndSwitch: async (
            input,
        ): Promise<GroupSnapshot> =>
            await (operations.createAndSwitch ?? operations.create)(input),
        join: async (
            room,
            options: RallarJoinRoomOptions = {},
        ): Promise<GroupSnapshot> => await operations.join(room, options),
        enter: async (
            room,
            options: RallarJoinRoomOptions = {},
        ): Promise<RallarRoomSession> =>
            await operations.enter(room, options),
        session: (room): RallarRoomSession => operations.session(room),
        leave: async (
            input,
        ): Promise<GroupSnapshot | undefined> => await operations.leave(input),
        update: async (
            input,
        ): Promise<GroupSnapshot> => await operations.update(input),
        archive: async (
            room,
            options: RallarRoomLifecycleOptions = {},
        ): Promise<GroupSnapshot> => await operations.archive(room, options),
        delete: async (
            room,
            options: RallarRoomLifecycleOptions = {},
        ): Promise<GroupSnapshot> => await operations.delete(room, options),
        invite: async (
            room,
            principalId,
            options: RallarRoomInviteOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.invite(room, principalId, options),
        acceptInvite: async (
            room,
            options: RallarScopedOperationOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.acceptInvite(room, options),
        removeMember: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.removeMember(room, principalId, options),
        banMember: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.banMember(room, principalId, options),
        unbanMember: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.unbanMember(room, principalId, options),
        setMemberRole: async (
            room,
            principalId,
            role,
            options: RallarRoomGovernanceOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.setMemberRole(room, principalId, role, options),
        transferOwnership: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.transferOwnership(room, principalId, options),
        updateMetadata: async (
            room,
            patch,
            options: RallarScopedOperationOptions = {},
        ): Promise<GroupSnapshot> =>
            await operations.updateMetadata(room, patch, options),
        waitForPresence: async (
            room,
            options: RallarRoomPresenceWaitOptions = {},
        ): Promise<RallarRoomPresenceWaitResult> =>
            await operations.waitForPresence(room, options),
        current: (): GroupSnapshot | undefined => operations.current(),
        onChange: (
            listener,
            options: RallarOnChangeOptions = {},
        ): RallarUnsubscribe => operations.onChange(listener, options),
        onEvent: (
            listener,
            options: RallarRoomEventOptions = {},
        ): RallarUnsubscribe => operations.onEvent(listener, options),
    };
}

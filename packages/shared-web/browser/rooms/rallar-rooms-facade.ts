import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarOnChangeOptions,
    RallarReplayEventsResult,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    RallarCreateRoomInput,
    RallarJoinRoomInput,
    RallarJoinRoomOptions,
    RallarLeaveRoomOptions,
    RallarListRoomEventsInput,
    RallarReplayRoomEventsInput,
    RallarRoomEventListener,
    RallarRoomEventOptions,
    RallarRoomGovernanceOptions,
    RallarRoomInviteOptions,
    RallarRoomLifecycleOptions,
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
    RallarRoomSession,
    RallarRoomState,
    RallarRoomSummary,
    RallarRoomTargetInput,
    RallarUpdateRoomInput
} from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type {
    GroupEvent,
    GroupRef,
    GroupRole,
    GroupSnapshot,
    StateEventPage,
    StateScope
} from '@shared-web/browser/rooms/room-group-state-translation.ts';

export type RallarRoomsFacade = Readonly<{
    state(): RallarRoomState;
    list(): readonly RallarRoomSummary[];
    refresh(input?: StateScope | RallarScopedOperationOptions): Promise<RallarRoomState>;
    listEvents(input: RallarListRoomEventsInput): Promise<readonly GroupEvent[]>;
    listEventPage(input: RallarListRoomEventsInput): Promise<StateEventPage<GroupEvent>>;
    replayEvents(
        input: RallarReplayRoomEventsInput,
        listener?: RallarRoomEventListener
    ): Promise<RallarReplayEventsResult<GroupEvent>>;
    create(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
    createAndSwitch(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
    join(
        room: string | GroupRef | RallarJoinRoomInput,
        options?: RallarJoinRoomOptions
    ): Promise<GroupSnapshot>;
    enter(
        room: string | GroupRef | RallarJoinRoomInput,
        options?: RallarJoinRoomOptions
    ): Promise<RallarRoomSession>;
    session(room?: string | GroupRef): RallarRoomSession;
    leave(input?: string | RallarLeaveRoomOptions): Promise<GroupSnapshot | undefined>;
    update(input: RallarUpdateRoomInput): Promise<GroupSnapshot>;
    archive(
        room: string | GroupRef | RallarRoomTargetInput,
        options?: RallarRoomLifecycleOptions
    ): Promise<GroupSnapshot>;
    delete(
        room: string | GroupRef | RallarRoomTargetInput,
        options?: RallarRoomLifecycleOptions
    ): Promise<GroupSnapshot>;
    invite(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomInviteOptions
    ): Promise<GroupSnapshot>;
    acceptInvite(
        room: string | GroupRef | RallarRoomTargetInput,
        options?: RallarScopedOperationOptions
    ): Promise<GroupSnapshot>;
    removeMember(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions
    ): Promise<GroupSnapshot>;
    banMember(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions
    ): Promise<GroupSnapshot>;
    unbanMember(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions
    ): Promise<GroupSnapshot>;
    setMemberRole(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        role: GroupRole,
        options?: RallarRoomGovernanceOptions
    ): Promise<GroupSnapshot>;
    transferOwnership(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions
    ): Promise<GroupSnapshot>;
    updateMetadata(
        room: string | GroupRef,
        patch: Readonly<Record<string, unknown>>,
        options?: RallarScopedOperationOptions
    ): Promise<GroupSnapshot>;
    waitForPresence(
        room: string | GroupRef,
        options?: RallarRoomPresenceWaitOptions
    ): Promise<RallarRoomPresenceWaitResult>;
    current(): GroupSnapshot | undefined;
    onChange(
        listener: RallarStateListener<RallarRoomState>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
    onEvent(listener: RallarRoomEventListener, options?: RallarRoomEventOptions): RallarUnsubscribe;
}>;

interface OptionalCreateAndSwitchRoomOperation {
    readonly createAndSwitch?: RallarRoomsFacade['createAndSwitch'];
}

export type CreateRallarRoomsFacadeOptions =
    & Omit<RallarRoomsFacade, 'createAndSwitch'>
    & OptionalCreateAndSwitchRoomOperation;

export function createRallarRoomsFacade(
    operations: CreateRallarRoomsFacadeOptions
): RallarRoomsFacade {
    return {
        ...createRoomQueryFacadeOperations(operations),
        ...createRoomEntryFacadeOperations(operations),
        ...createRoomUpdateFacadeOperations(operations),
        ...createRoomMembershipFacadeOperations(operations),
        ...createRoomStateFacadeOperations(operations)
    };
}

function createRoomQueryFacadeOperations(
    operations: CreateRallarRoomsFacadeOptions
): Pick<RallarRoomsFacade, 'state' | 'list' | 'refresh' | 'listEvents' | 'listEventPage' | 'replayEvents'> {
    return {
        state: (): RallarRoomState => operations.state(),
        list: (): readonly RallarRoomSummary[] => operations.list(),
        refresh: async (input): Promise<RallarRoomState> => await operations.refresh(input),
        listEvents: async (input): Promise<readonly GroupEvent[]> => await operations.listEvents(input),
        listEventPage: async (input): Promise<StateEventPage<GroupEvent>> => await operations.listEventPage(input),
        replayEvents: async (input, listener): Promise<RallarReplayEventsResult<GroupEvent>> =>
            await operations.replayEvents(input, listener)
    };
}

function createRoomEntryFacadeOperations(
    operations: CreateRallarRoomsFacadeOptions
): Pick<RallarRoomsFacade, 'create' | 'createAndSwitch' | 'join' | 'enter' | 'session' | 'leave'> {
    return {
        create: async (input): Promise<GroupSnapshot> => await operations.create(input),
        createAndSwitch: async (input): Promise<GroupSnapshot> =>
            await (operations.createAndSwitch ?? operations.create)(input),
        join: async (room, options: RallarJoinRoomOptions = {}): Promise<GroupSnapshot> =>
            await operations.join(room, options),
        enter: async (room, options: RallarJoinRoomOptions = {}): Promise<RallarRoomSession> =>
            await operations.enter(room, options),
        session: (room): RallarRoomSession => operations.session(room),
        leave: async (input): Promise<GroupSnapshot | undefined> => await operations.leave(input)
    };
}

function createRoomUpdateFacadeOperations(
    operations: CreateRallarRoomsFacadeOptions
): Pick<RallarRoomsFacade, 'update' | 'archive' | 'delete'> {
    return {
        update: async (input): Promise<GroupSnapshot> => await operations.update(input),
        archive: async (room, options: RallarRoomLifecycleOptions = {}): Promise<GroupSnapshot> =>
            await operations.archive(room, options),
        delete: async (room, options: RallarRoomLifecycleOptions = {}): Promise<GroupSnapshot> =>
            await operations.delete(room, options)
    };
}

function createRoomMembershipFacadeOperations(
    operations: CreateRallarRoomsFacadeOptions
): Pick<
    RallarRoomsFacade,
    | 'invite'
    | 'acceptInvite'
    | 'removeMember'
    | 'banMember'
    | 'unbanMember'
    | 'setMemberRole'
    | 'transferOwnership'
> {
    return {
        invite: async (
            room,
            principalId,
            options: RallarRoomInviteOptions = {}
        ): Promise<GroupSnapshot> => await operations.invite(room, principalId, options),
        acceptInvite: async (
            room,
            options: RallarScopedOperationOptions = {}
        ): Promise<GroupSnapshot> => await operations.acceptInvite(room, options),
        removeMember: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {}
        ): Promise<GroupSnapshot> => await operations.removeMember(room, principalId, options),
        banMember: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {}
        ): Promise<GroupSnapshot> => await operations.banMember(room, principalId, options),
        unbanMember: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {}
        ): Promise<GroupSnapshot> => await operations.unbanMember(room, principalId, options),
        setMemberRole: async (
            room,
            principalId,
            role,
            options: RallarRoomGovernanceOptions = {}
        ): Promise<GroupSnapshot> => await operations.setMemberRole(room, principalId, role, options),
        transferOwnership: async (
            room,
            principalId,
            options: RallarRoomGovernanceOptions = {}
        ): Promise<GroupSnapshot> => await operations.transferOwnership(room, principalId, options)
    };
}

function createRoomStateFacadeOperations(
    operations: CreateRallarRoomsFacadeOptions
): Pick<RallarRoomsFacade, 'updateMetadata' | 'waitForPresence' | 'current' | 'onChange' | 'onEvent'> {
    return {
        updateMetadata: async (
            room,
            patch,
            options: RallarScopedOperationOptions = {}
        ): Promise<GroupSnapshot> => await operations.updateMetadata(room, patch, options),
        waitForPresence: async (
            room,
            options: RallarRoomPresenceWaitOptions = {}
        ): Promise<RallarRoomPresenceWaitResult> => await operations.waitForPresence(room, options),
        current: (): GroupSnapshot | undefined => operations.current(),
        onChange: (listener, options: RallarOnChangeOptions = {}): RallarUnsubscribe =>
            operations.onChange(listener, options),
        onEvent: (listener, options: RallarRoomEventOptions = {}): RallarUnsubscribe =>
            operations.onEvent(listener, options)
    };
}

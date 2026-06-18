import type {
    GroupEvent,
    GroupRef,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type {
    RallarCreateRoomInput,
    RallarJoinRoomInput,
    RallarJoinRoomOptions,
    RallarLeaveRoomOptions,
    RallarListRoomEventsInput,
    RallarOnChangeOptions,
    RallarRefreshOptions,
    RallarReplayEventsResult,
    RallarReplayRoomEventsInput,
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
    RallarRoomEventListener,
    RallarRoomEventOptions,
    RallarRoomSession,
    RallarRoomState,
    RallarRoomSummary,
    RallarScopedOperationOptions,
    RallarStateListener,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar.ts';

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

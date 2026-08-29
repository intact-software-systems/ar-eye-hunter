import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarStateEventListener } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    toRallarCommandOptions,
    toRallarWorkflowPolicies,
    type RallarOperationOptions
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarOnChangeOptions,
    RallarReplayEventsResult,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import { throwRallarValidationIssue } from '@shared-web/browser/rooms/rallar-room-validation.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import { emitBrowserStateReadDiagnostic } from '@shared-web/browser/state-read/diagnostics.ts';
import { hydrateGroupTopologyOverlays } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';
import { readStateGroupSnapshot, type StateGroupSnapshotRead } from '@shared-web/browser/state-read/point-read.ts';
import { refreshStateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { toGroupRefFromScope, toStateScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { Command } from '@shared/cache/Command.ts';
import {
    findGroupStateSnapshotByRef,
    removeGroupStateSnapshotIfUnchanged,
    waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';

import { createAndJoinRoom, createAndSwitchRoom } from './create-and-join-room.ts';
import { enterRoom, joinRoom } from './join-room.ts';
import { leaveRoom } from './leave-room.ts';
import type {
    RallarCreateRoomInput,
    RallarJoinRoomInput,
    RallarJoinRoomOptions,
    RallarLeaveRoomOptions,
    RallarListRoomEventsInput,
    RallarReplayRoomEventsInput,
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
    RallarSetRoomMemberRoleInput,
    RallarUpdateRoomInput
} from './rallar-room-contracts.ts';
import type { RallarRoomEventsPort } from './room-events.ts';
import type {
    GroupEvent,
    GroupRef,
    GroupSnapshot,
    StateEventPage,
    StateScope
} from './room-group-state-translation.ts';
import {
    acceptRoomInvite,
    banRoomMember,
    createRoomInvite,
    removeRoomMember,
    setRoomMemberRole,
    transferRoomOwnership,
    unbanRoomMember
} from './room-membership.ts';
import { waitForRoomPresence } from './room-presence.ts';
import { createRoomSession } from './room-session.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';
import { archiveRoom, deleteRoom, updateRoom, updateRoomMetadata } from './update-room.ts';

export interface CreateBrowserRallarRoomsInput {
    readonly stateStore: RallarRoomStateStorePort;
    readonly roomEvents: RallarRoomEventsPort;
    readonly messages: RallarMessagesOperations;
    readonly realtime: RallarRealtimeFacade;
    readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
    readonly requireSession: () => AuthSession;
    readonly resolveOperationOptions: <T extends RallarOperationOptions>(options: T) => T & RallarOperationOptions;
    readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
    readonly resolveDefaultRoom: () => string | GroupRef | undefined;
    readonly resolveDefaultRoomRef: () => GroupRef | undefined;
    readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly acceptSnapshots: (input: RallarStateSnapshotAcceptanceInput) => Promise<void>;
}

export interface BrowserRallarRooms {
    state(): RallarRoomState;
    list(): readonly RallarRoomSummary[];
    refresh(input?: StateScope | RallarScopedOperationOptions): Promise<RallarRoomState>;
    listEvents(input: RallarListRoomEventsInput): Promise<readonly GroupEvent[]>;
    listEventPage(input: RallarListRoomEventsInput): Promise<StateEventPage<GroupEvent>>;
    replayEvents(
        input: RallarReplayRoomEventsInput,
        listener?: RallarStateEventListener<GroupEvent>
    ): Promise<RallarReplayEventsResult<GroupEvent>>;
    create(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
    createAndSwitch(input: string | RallarCreateRoomInput): Promise<GroupSnapshot>;
    join(room: string | GroupRef | RallarJoinRoomInput, options?: RallarJoinRoomOptions): Promise<GroupSnapshot>;
    enter(room: string | GroupRef | RallarJoinRoomInput, options?: RallarJoinRoomOptions): Promise<RallarRoomSession>;
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
    setMemberRole(input: RallarSetRoomMemberRoleInput): Promise<GroupSnapshot>;
    transferOwnership(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        options?: RallarRoomGovernanceOptions
    ): Promise<GroupSnapshot>;
    updateMetadata(
        room: string | GroupRef,
        patch: ApiJsonObject,
        options?: RallarScopedOperationOptions
    ): Promise<GroupSnapshot>;
    waitForPresence(
        room: string | GroupRef,
        options?: RallarRoomPresenceWaitOptions
    ): Promise<RallarRoomPresenceWaitResult>;
    current(): GroupSnapshot | undefined;
    onChange(listener: RallarStateListener<RallarRoomState>, options?: RallarOnChangeOptions): RallarUnsubscribe;
    onEvent(listener: RallarStateEventListener<GroupEvent>, options?: RallarRoomEventOptions): RallarUnsubscribe;
}

interface CreateRoomEntryOperationsInput {
    readonly rooms: CreateBrowserRallarRoomsInput;
    readonly createSession: (roomRef: GroupRef) => RallarRoomSession;
    readonly resolveRoomRef: (room: string | GroupRef, scope?: StateScope) => GroupRef | undefined;
    readonly onCacheChange: (listener: () => void | Promise<void>) => RallarUnsubscribe;
}

export function createBrowserRallarRooms(
    input: CreateBrowserRallarRoomsInput
): BrowserRallarRooms {
    const resolveRoomRef = (
        room: string | GroupRef,
        scope?: StateScope
    ): GroupRef | undefined =>
        typeof room === 'string'
            ? (toGroupRefFromScope(room, input.resolveOperationScope(scope)) ??
                input.stateStore.findGroupSnapshot(room)?.group)
            : room;
    const onCacheChange = (
        listener: () => void | Promise<void>
    ): RallarUnsubscribe => input.stateStore.onCacheChange(listener);
    const refresh = async (
        refreshInput?: StateScope | RallarScopedOperationOptions
    ): Promise<RallarRoomState> => await refreshRooms(input, refreshInput);
    const createSession = (roomRef: GroupRef): RallarRoomSession =>
        createRoomSession({
            roomRef,
            stateStore: input.stateStore,
            messages: input.messages,
            realtime: input.realtime,
            leaveRoom: async (leaveInput) => await leaveRoom({ ...input, input: leaveInput }),
            refreshRoom: async (roomRef, options) => await refreshRoom(input, roomRef, options)
        });

    return {
        ...createRoomReadOperations(input, refresh),
        ...createRoomEntryOperations({
            rooms: input,
            createSession,
            resolveRoomRef,
            onCacheChange
        }),
        ...createRoomMembershipOperations(input),
        ...createRoomUpdateOperations(input)
    };
}

function createRoomReadOperations(
    input: CreateBrowserRallarRoomsInput,
    refresh: (
        input?: StateScope | RallarScopedOperationOptions
    ) => Promise<RallarRoomState>
): Pick<
    BrowserRallarRooms,
    | 'state'
    | 'list'
    | 'refresh'
    | 'listEvents'
    | 'listEventPage'
    | 'replayEvents'
    | 'current'
    | 'onChange'
    | 'onEvent'
> {
    return {
        state: () => input.stateStore.state(),
        list: () => input.stateStore.state().rooms,
        refresh,
        listEvents: async (eventInput) => await input.roomEvents.list(eventInput),
        listEventPage: async (eventInput) => await input.roomEvents.listPage(eventInput),
        replayEvents: async (eventInput, listener) => await input.roomEvents.replay(eventInput, listener),
        current: () => input.stateStore.state().currentRoom,
        onChange: (
            listener: RallarStateListener<RallarRoomState>,
            options: RallarOnChangeOptions = {}
        ) => input.stateStore.onChange(listener, options),
        onEvent: (listener, options = {}) => input.roomEvents.onEvent(listener, options)
    };
}

function createRoomEntryOperations(
    input: CreateRoomEntryOperationsInput
): Pick<
    BrowserRallarRooms,
    | 'create'
    | 'createAndSwitch'
    | 'join'
    | 'enter'
    | 'session'
    | 'leave'
    | 'waitForPresence'
> {
    return {
        create: async (room) => await createAndJoinRoom({ ...input.rooms, room }),
        createAndSwitch: async (room) => await createAndSwitchRoom({ ...input.rooms, room, leaveRoom }),
        join: async (room, options = {}) =>
            await joinRoom({
                ...input.rooms,
                room,
                options,
                createRoomSession: input.createSession
            }),
        enter: async (room, options = {}) =>
            await enterRoom({
                ...input.rooms,
                room,
                options,
                createRoomSession: input.createSession
            }),
        session: (room) =>
            input.createSession(
                resolveRoomSessionRef(input.rooms, room, input.resolveRoomRef)
            ),
        leave: async (leaveInput) => await leaveRoom({ ...input.rooms, input: leaveInput }),
        waitForPresence: async (room, options = {}) =>
            await waitForRoomPresence({
                room,
                options,
                stateStore: input.rooms.stateStore,
                resolveOperationOptions: input.rooms.resolveOperationOptions,
                resolveRoomRef: input.resolveRoomRef,
                onCacheChange: input.onCacheChange
            })
    };
}

function createRoomMembershipOperations(
    input: CreateBrowserRallarRoomsInput
): Pick<
    BrowserRallarRooms,
    | 'invite'
    | 'acceptInvite'
    | 'removeMember'
    | 'banMember'
    | 'unbanMember'
    | 'setMemberRole'
    | 'transferOwnership'
> {
    return {
        invite: async (room, principalId, options = {}) =>
            await createRoomInvite({ ...input, room, principalId, options }),
        acceptInvite: async (room, options = {}) => await acceptRoomInvite({ ...input, room, options }),
        removeMember: async (room, principalId, options = {}) =>
            await removeRoomMember({ ...input, room, principalId, options }),
        banMember: async (room, principalId, options = {}) =>
            await banRoomMember({ ...input, room, principalId, options }),
        unbanMember: async (room, principalId, options = {}) =>
            await unbanRoomMember({ ...input, room, principalId, options }),
        setMemberRole: async (memberRoleInput) =>
            await setRoomMemberRole({
                ...input,
                room: memberRoleInput.room,
                principalId: memberRoleInput.principalId,
                role: memberRoleInput.role,
                options: memberRoleInput.options ?? {}
            }),
        transferOwnership: async (room, principalId, options = {}) =>
            await transferRoomOwnership({ ...input, room, principalId, options })
    };
}

function createRoomUpdateOperations(
    input: CreateBrowserRallarRoomsInput
): Pick<BrowserRallarRooms, 'update' | 'archive' | 'delete' | 'updateMetadata'> {
    return {
        update: async (updateInput) => await updateRoom({ ...input, input: updateInput }),
        archive: async (room, options = {}) => await archiveRoom({ ...input, room, options }),
        delete: async (room, options = {}) => await deleteRoom({ ...input, room, options }),
        updateMetadata: async (room, patch, options = {}) =>
            await updateRoomMetadata({ ...input, room, patch, options })
    };
}

async function refreshRooms(
    input: CreateBrowserRallarRoomsInput,
    refreshInput?: StateScope | RallarScopedOperationOptions
): Promise<RallarRoomState> {
    return await input.runAuthAwareOperation(async () => {
        const options = toRallarScopedOperationOptions(refreshInput);
        const operationOptions = input.resolveOperationOptions(options);
        const context = await input.connect(operationOptions);
        const scope = input.resolveOperationScope(options.scope);
        const { clients, groups } = await refreshStateSnapshots(
            scope,
            toRallarWorkflowPolicies(operationOptions)
        );
        await input.acceptSnapshots({ context, clients, groups, scope });
        return input.stateStore.state();
    });
}

async function refreshRoom(
    input: CreateBrowserRallarRoomsInput,
    roomRef: GroupRef,
    refreshInput: RallarScopedOperationOptions = {}
): Promise<void> {
    await input.runAuthAwareOperation(async () => {
        const scope = toStateScope(roomRef);
        const operationOptions = input.resolveOperationOptions({
            ...refreshInput,
            scope
        });
        const context = await input.connect(operationOptions);
        const observed = findGroupStateSnapshotByRef(roomRef);
        try {
            const response = await new Command<StateGroupSnapshotRead>(
                (signal) =>
                    readStateGroupSnapshot(roomRef.groupId, scope, {
                        signal,
                        authSession: input.requireSession()
                    }),
                toRallarCommandOptions(operationOptions)
            ).run();
            await input.acceptSnapshots({ context, clients: [], groups: [response.snapshot], scope });
            await hydrateGroupTopologyOverlays({
                groupSnapshots: [response.snapshot],
                sessionId: context.session.sessionId,
                webRtcGroupManager: context.middleware.webRtcGroupManager,
                scope,
                apiRequest: {
                    ...toRallarCommandOptions(operationOptions),
                    authSession: context.session
                }
            });
        }
        catch (error) {
            if (error instanceof ApiHttpError && error.status === 404 && observed) {
                const removed = removeGroupStateSnapshotIfUnchanged(roomRef, observed);
                emitBrowserStateReadDiagnostic({
                    name: 'rallar.browser.state-read',
                    feature: 'group',
                    operation: 'point',
                    result: removed ? 'removed' : 'preserved',
                    durationMs: 0
                });
                await waitForGroupStateSnapshotChangesIdle();
            }
            throw error;
        }
    });
}

function resolveRoomSessionRef(
    input: CreateBrowserRallarRoomsInput,
    room: string | GroupRef | undefined,
    resolveRoomRef: (
        room: string | GroupRef,
        scope?: StateScope
    ) => GroupRef | undefined
): GroupRef {
    const target = room ??
        input.resolveDefaultRoomRef() ??
        input.stateStore.resolveCurrentRoomRef() ??
        input.resolveDefaultRoom();
    const roomRef = target === undefined ? undefined : resolveRoomRef(target);
    if (!roomRef) {
        throwRallarValidationIssue(
            '$.roomRef',
            'missing-room-ref',
            'Cannot create room session: no scoped room reference.'
        );
    }
    return roomRef;
}

function toRallarScopedOperationOptions(
    input?: StateScope | RallarScopedOperationOptions
): RallarScopedOperationOptions {
    if (!input) {
        return {};
    }
    return isStateScope(input) ? { scope: input } : input;
}

function isStateScope(
    input: StateScope | RallarScopedOperationOptions
): input is StateScope {
    return (
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input) &&
        'applicationId' in input &&
        typeof input.applicationId === 'string'
    );
}

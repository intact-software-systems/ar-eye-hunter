import * as apiWorkflows from '@shared-web/browser/api-workflows.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarRefreshOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarMessagesFacade } from '@shared-web/browser/rallar-messages-facade.ts';
import {
  toRallarWorkflowPolicies,
  type RallarOperationOptions,
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
  RallarRoomEventsPort,
  RallarRoomStateStorePort,
} from '@shared-web/browser/rallar-runtime/contracts.ts';
import { throwRallarValidationIssue } from '@shared-web/browser/rallar-runtime/validation.ts';
import type {
  RallarOnChangeOptions,
  RallarStateListener,
  RallarUnsubscribe,
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toGroupRefFromScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';

import { createAndJoinRoom, createAndSwitchRoom } from './create-and-join-room.ts';
import { enterRoom, joinRoom } from './join-room.ts';
import { leaveRoom } from './leave-room.ts';
import {
  acceptRoomInvite,
  banRoomMember,
  createRoomInvite,
  removeRoomMember,
  setRoomMemberRole,
  transferRoomOwnership,
  unbanRoomMember,
} from './room-membership.ts';
import { waitForRoomPresence } from './room-presence.ts';
import { createRoomSession } from './room-session.ts';
import type { GroupRef, GroupSnapshot, StateScope } from './room-group-state-translation.ts';
import type { RallarRoomSession, RallarRoomState } from './rallar-room-contracts.ts';
import type { CreateRallarRoomsFacadeOptions } from './rallar-rooms-facade.ts';
import { archiveRoom, deleteRoom, updateRoom, updateRoomMetadata } from './update-room.ts';

export interface CreateBrowserRallarRoomsInput {
  readonly stateStore: RallarRoomStateStorePort;
  readonly roomEvents: RallarRoomEventsPort;
  readonly messages: RallarMessagesFacade;
  readonly realtime: RallarRealtimeFacade;
  readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
  readonly requireSession: () => AuthSession;
  readonly resolveOperationOptions: <T extends RallarOperationOptions>(
    options: T,
  ) => T & RallarOperationOptions;
  readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
  readonly resolveDefaultRoom: () => string | GroupRef | undefined;
  readonly resolveDefaultRoomRef: () => GroupRef | undefined;
  readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly acceptSnapshots: (
    context: ApiMiddleware,
    clients: readonly ClientSnapshot[],
    groups: readonly GroupSnapshot[],
    scope?: StateScope,
  ) => Promise<void>;
}

export function createBrowserRallarRooms(
  input: CreateBrowserRallarRoomsInput,
): CreateRallarRoomsFacadeOptions {
  const resolveRoomRef = (room: string | GroupRef, scope?: StateScope): GroupRef | undefined =>
    typeof room === 'string'
      ? (toGroupRefFromScope(room, input.resolveOperationScope(scope)) ??
        input.stateStore.findGroupSnapshot(room)?.group)
      : room;
  const onCacheChange = (listener: () => void | Promise<void>): RallarUnsubscribe =>
    input.stateStore.onCacheChange(listener);
  const refresh = async (
    refreshInput?: StateScope | RallarRefreshOptions,
  ): Promise<RallarRoomState> => await refreshRooms(input, refreshInput);
  const createSession = (roomRef: GroupRef): RallarRoomSession =>
    createRoomSession({
      roomRef,
      stateStore: input.stateStore,
      messages: input.messages,
      realtime: input.realtime,
      leaveRoom: async (leaveInput) => await leaveRoom({ ...input, input: leaveInput }),
      refreshRooms: refresh,
    });

  return {
    ...createRoomReadOperations(input, refresh),
    ...createRoomEntryOperations(input, createSession, resolveRoomRef, onCacheChange),
    ...createRoomMembershipOperations(input),
    ...createRoomUpdateOperations(input),
  };
}

function createRoomReadOperations(
  input: CreateBrowserRallarRoomsInput,
  refresh: (input?: StateScope | RallarRefreshOptions) => Promise<RallarRoomState>,
): Pick<
  CreateRallarRoomsFacadeOptions,
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
    replayEvents: async (eventInput, listener) =>
      await input.roomEvents.replay(eventInput, listener),
    current: () => input.stateStore.state().currentRoom,
    onChange: (
      listener: RallarStateListener<RallarRoomState>,
      options: RallarOnChangeOptions = {},
    ) => input.stateStore.onChange(listener, options),
    onEvent: (listener, options = {}) => input.roomEvents.onEvent(listener, options),
  };
}

function createRoomEntryOperations(
  input: CreateBrowserRallarRoomsInput,
  createSession: (roomRef: GroupRef) => RallarRoomSession,
  resolveRoomRef: (room: string | GroupRef, scope?: StateScope) => GroupRef | undefined,
  onCacheChange: (listener: () => void | Promise<void>) => RallarUnsubscribe,
): Pick<
  CreateRallarRoomsFacadeOptions,
  'create' | 'createAndSwitch' | 'join' | 'enter' | 'session' | 'leave' | 'waitForPresence'
> {
  return {
    create: async (room) => await createAndJoinRoom({ ...input, room }),
    createAndSwitch: async (room) => await createAndSwitchRoom({ ...input, room, leaveRoom }),
    join: async (room, options = {}) =>
      await joinRoom({ ...input, room, options, createRoomSession: createSession }),
    enter: async (room, options = {}) =>
      await enterRoom({ ...input, room, options, createRoomSession: createSession }),
    session: (room) => createSession(resolveRoomSessionRef(input, room, resolveRoomRef)),
    leave: async (leaveInput) => await leaveRoom({ ...input, input: leaveInput }),
    waitForPresence: async (room, options = {}) =>
      await waitForRoomPresence({
        room,
        options,
        stateStore: input.stateStore,
        resolveOperationOptions: input.resolveOperationOptions,
        resolveRoomRef,
        onCacheChange,
      }),
  };
}

function createRoomMembershipOperations(
  input: CreateBrowserRallarRoomsInput,
): Pick<
  CreateRallarRoomsFacadeOptions,
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
    setMemberRole: async (room, principalId, role, options = {}) =>
      await setRoomMemberRole({ ...input, room, principalId, role, options }),
    transferOwnership: async (room, principalId, options = {}) =>
      await transferRoomOwnership({ ...input, room, principalId, options }),
  };
}

function createRoomUpdateOperations(
  input: CreateBrowserRallarRoomsInput,
): Pick<CreateRallarRoomsFacadeOptions, 'update' | 'archive' | 'delete' | 'updateMetadata'> {
  return {
    update: async (updateInput) => await updateRoom({ ...input, input: updateInput }),
    archive: async (room, options = {}) => await archiveRoom({ ...input, room, options }),
    delete: async (room, options = {}) => await deleteRoom({ ...input, room, options }),
    updateMetadata: async (room, patch, options = {}) =>
      await updateRoomMetadata({ ...input, room, patch, options }),
  };
}

async function refreshRooms(
  input: CreateBrowserRallarRoomsInput,
  refreshInput?: StateScope | RallarRefreshOptions,
): Promise<RallarRoomState> {
  return await input.runAuthAwareOperation(async () => {
    const options = toRallarRefreshOptions(refreshInput);
    const operationOptions = input.resolveOperationOptions(options);
    const context = await input.connect(operationOptions);
    const scope = input.resolveOperationScope(options.scope);
    const { clients, groups } = await apiWorkflows.refreshStateSnapshots(
      scope,
      toRallarWorkflowPolicies(operationOptions),
    );
    await input.acceptSnapshots(context, clients, groups, scope);
    return input.stateStore.state();
  });
}

function resolveRoomSessionRef(
  input: CreateBrowserRallarRoomsInput,
  room: string | GroupRef | undefined,
  resolveRoomRef: (room: string | GroupRef, scope?: StateScope) => GroupRef | undefined,
): GroupRef {
  const target =
    room ??
    input.resolveDefaultRoomRef() ??
    input.stateStore.resolveCurrentRoomRef() ??
    input.resolveDefaultRoom();
  const roomRef = target === undefined ? undefined : resolveRoomRef(target);
  if (!roomRef) {
    throwRallarValidationIssue(
      '$.roomRef',
      'missing-room-ref',
      'Cannot create room session: no scoped room reference.',
    );
  }
  return roomRef;
}

function toRallarRefreshOptions(input?: StateScope | RallarRefreshOptions): RallarRefreshOptions {
  if (!input) {
    return {};
  }
  return isStateScope(input) ? { scope: input } : input;
}

function isStateScope(input: StateScope | RallarRefreshOptions): input is StateScope {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { applicationId?: unknown }).applicationId === 'string'
  );
}

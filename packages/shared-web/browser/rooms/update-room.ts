import * as api from '@shared-web/browser/api-integration.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import {
  toRallarWorkflowPolicies,
  type RallarOperationOptions,
} from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toGroupRefFromScope, toStateScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import type {
  RallarRoomLifecycleOptions,
  RallarRoomTargetInput,
  RallarUpdateRoomInput,
} from './rallar-room-contracts.ts';
import {
  archiveStateGroup,
  deleteStateGroup,
  updateStateGroupDetails,
  updateStateGroupMetadata,
} from './room-group-state-mutation-workflows.ts';
import type { StateGroupWorkflowValue } from './room-group-state-workflows.ts';
import type {
  GroupRef,
  GroupSnapshot,
  StateScope,
  UpdateGroupRequest,
} from './room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';
import { toRoomTarget } from './room-target.ts';

export interface RunRoomTargetMutationInput {
  readonly room: string | GroupRef | RallarRoomTargetInput;
  readonly options: RallarScopedOperationOptions;
  readonly stateStore: RallarRoomStateStorePort;
  readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
  readonly requireSession: () => AuthSession;
  readonly resolveOperationOptions: <T extends RallarOperationOptions>(
    options: T,
  ) => T & RallarOperationOptions;
  readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
  readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly acceptSnapshots: (
    context: ApiMiddleware,
    clients: readonly ClientSnapshot[],
    groups: readonly GroupSnapshot[],
    scope?: StateScope,
  ) => Promise<void>;
  readonly execute: (
    roomId: string,
    session: AuthSession,
    scope: StateScope,
    policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>,
    generationId: string,
  ) => Promise<GroupSnapshot>;
}

export async function runRoomTargetMutation(
  input: RunRoomTargetMutationInput,
): Promise<GroupSnapshot> {
  return await input.runAuthAwareOperation(async () => {
    const target = toRoomTarget(input.room, input.options);
    const operationOptions = input.resolveOperationOptions(target.options);
    const context = await input.connect(operationOptions);
    const session = input.requireSession();
    const scope =
      target.options.scope ??
      (target.roomRef
        ? toStateScope(target.roomRef)
        : (input.resolveOperationScope(target.options.scope) ?? api.defaultStateScope()));
    const snapshot = await input.execute(
      target.roomId,
      session,
      scope,
      toRallarWorkflowPolicies<StateGroupWorkflowValue>(operationOptions),
      context.middleware.heartbeat.generationId,
    );
    await input.acceptSnapshots(context, [], [snapshot], scope);
    return snapshot;
  });
}

export async function updateRoom(
  input: Omit<RunRoomTargetMutationInput, 'room' | 'options' | 'execute'> & {
    readonly input: RallarUpdateRoomInput;
  },
): Promise<GroupSnapshot> {
  const request = toUpdateRoomRequest(input.input);
  return await runRoomTargetMutation({
    ...input,
    room: input.input,
    options: input.input,
    execute: async (roomId, session, scope, policies) =>
      await updateStateGroupDetails(
        roomId,
        request,
        session.clientId,
        session.sessionId,
        scope,
        policies,
      ),
  });
}

export async function archiveRoom(
  input: Omit<RunRoomTargetMutationInput, 'options' | 'execute'> & {
    readonly options?: RallarRoomLifecycleOptions;
  },
): Promise<GroupSnapshot> {
  return await changeRoomLifecycle({ ...input, status: 'archived' });
}

export async function deleteRoom(
  input: Omit<RunRoomTargetMutationInput, 'options' | 'execute'> & {
    readonly options?: RallarRoomLifecycleOptions;
  },
): Promise<GroupSnapshot> {
  return await changeRoomLifecycle({ ...input, status: 'deleted' });
}

export async function updateRoomMetadata(
  input: Omit<RunRoomTargetMutationInput, 'execute'> & {
    readonly room: string | GroupRef;
    readonly patch: Readonly<Record<string, unknown>>;
  },
): Promise<GroupSnapshot> {
  return await input.runAuthAwareOperation(async () => {
    const operationOptions = input.resolveOperationOptions(input.options);
    const context = await input.connect(operationOptions);
    const session = input.requireSession();
    const roomRef =
      typeof input.room === 'string'
        ? (toGroupRefFromScope(input.room, input.resolveOperationScope()) ??
          input.stateStore.findGroupSnapshot(input.room)?.group)
        : input.room;
    const roomId = typeof input.room === 'string' ? input.room : input.room.groupId;
    const scope =
      input.options.scope ?? (roomRef ? toStateScope(roomRef) : input.resolveOperationScope());
    if (!roomId) {
      throw new Error('Cannot update room metadata: room is required.');
    }
    const snapshot = await updateStateGroupMetadata(
      roomId,
      input.patch,
      session.clientId,
      session.sessionId,
      scope,
      toRallarWorkflowPolicies(operationOptions),
    );
    await input.acceptSnapshots(context, [], [snapshot], scope);
    return snapshot;
  });
}

async function changeRoomLifecycle(
  input: Omit<RunRoomTargetMutationInput, 'options' | 'execute'> & {
    readonly options?: RallarRoomLifecycleOptions;
    readonly status: 'archived' | 'deleted';
  },
): Promise<GroupSnapshot> {
  const options = input.options ?? {};
  const request = options.reason === undefined ? {} : { reason: options.reason };
  return await runRoomTargetMutation({
    ...input,
    options,
    execute: async (roomId, session, scope, policies) =>
      input.status === 'archived'
        ? await archiveStateGroup(
            roomId,
            request,
            session.clientId,
            session.sessionId,
            scope,
            policies,
          )
        : await deleteStateGroup(
            roomId,
            request,
            session.clientId,
            session.sessionId,
            scope,
            policies,
          ),
  });
}

function toUpdateRoomRequest(input: RallarUpdateRoomInput): UpdateGroupRequest {
  return {
    ...(input.slug === undefined ? {} : { slug: input.slug }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.joinMode === undefined ? {} : { joinMode: input.joinMode }),
    ...(input.maxMembers === undefined ? {} : { maxMembers: input.maxMembers }),
    ...(input.maxSessionsPerMember === undefined
      ? {}
      : { maxSessionsPerMember: input.maxSessionsPerMember }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs: input.expiresAtEpochMs }),
    ...(input.purgeAfterEpochMs === undefined
      ? {}
      : { purgeAfterEpochMs: input.purgeAfterEpochMs }),
  };
}

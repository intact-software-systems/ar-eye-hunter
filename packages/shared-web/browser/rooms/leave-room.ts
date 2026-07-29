import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import {
  toRallarWorkflowPolicies,
  type RallarOperationOptions,
} from '@shared-web/browser/rallar-operation-options.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toGroupRefFromScope, toStateScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';

import type { RallarLeaveRoomOptions } from './rallar-room-contracts.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';
import { leaveStateGroup, type StateGroupWorkflowValue } from './room-group-state-workflows.ts';
import type { GroupRef, GroupSnapshot, StateScope } from './room-group-state-translation.ts';

export interface LeaveRoomInput {
  readonly input?: string | RallarLeaveRoomOptions;
  readonly stateStore: RallarRoomStateStorePort;
  readonly connect: (options?: RallarOperationOptions) => Promise<ApiMiddleware>;
  readonly requireSession: () => AuthSession;
  readonly resolveOperationOptions: <T extends RallarOperationOptions>(
    options: T,
  ) => T & RallarOperationOptions;
  readonly resolveOperationScope: (scope?: StateScope) => StateScope | undefined;
  readonly resolveDefaultRoomRef: () => GroupRef | undefined;
  readonly runAuthAwareOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly acceptSnapshots: (
    context: ApiMiddleware,
    clients: readonly ClientSnapshot[],
    groups: readonly GroupSnapshot[],
    scope?: StateScope,
  ) => Promise<void>;
}

export async function leaveRoom(input: LeaveRoomInput): Promise<GroupSnapshot | undefined> {
  return await input.runAuthAwareOperation(async () => {
    const leaveOptions =
      typeof input.input === 'string' ? { roomId: input.input } : (input.input ?? {});
    const operationOptions = input.resolveOperationOptions(leaveOptions);
    const context = await input.connect(operationOptions);
    const session = input.requireSession();
    const explicitScope = input.resolveOperationScope(leaveOptions.scope);
    const roomRef =
      leaveOptions.roomRef ??
      (leaveOptions.roomId
        ? (toGroupRefFromScope(
            leaveOptions.roomId,
            input.resolveOperationScope(leaveOptions.scope),
          ) ?? input.stateStore.findGroupSnapshot(leaveOptions.roomId)?.group)
        : (input.resolveDefaultRoomRef() ?? input.stateStore.resolveCurrentRoomRef()));
    const roomId = leaveOptions.roomId ?? roomRef?.groupId;
    const scope = leaveOptions.scope ?? (roomRef ? toStateScope(roomRef) : explicitScope);
    if (!roomId) {
      return undefined;
    }
    const snapshot = await leaveStateGroup(
      roomId,
      session.clientId,
      session.sessionId,
      context.middleware.heartbeat.generationId,
      scope,
      toRallarWorkflowPolicies<StateGroupWorkflowValue>(operationOptions),
    );
    input.stateStore.clearCurrentRoomIfMatches(
      roomRef ?? roomId,
      leaveOptions.clearCurrent ?? true,
    );
    await input.acceptSnapshots(context, [], [snapshot], scope);
    return snapshot;
  });
}

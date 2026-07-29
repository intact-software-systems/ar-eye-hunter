import { expect, expectTypeOf, it } from 'vitest';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { createRallarRoomsFacade as createCompatibilityRallarRoomsFacade } from '@shared-web/browser/rallar-rooms-facade.ts';
import type * as CompatibilityRoomSurface from '@shared-web/browser/rallar-rooms-facade.ts';
import type {
  RallarReplayEventsResult,
  RallarRoomPresenceWaitResult,
  RallarRoomSession,
  RallarRoomState,
  RallarRoomSummary,
  RallarRoomsFacade,
  RallarUnsubscribe,
} from '@shared-web/browser/rallar-rooms-facade.ts';
import type * as OwningRoomContracts from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { createRallarRoomsFacade as createOwningRallarRoomsFacade } from '@shared-web/browser/rooms/rallar-rooms-facade.ts';
import type * as OwningRoomFacade from '@shared-web/browser/rooms/rallar-rooms-facade.ts';

type CompatibilityRoomContracts = Readonly<{
  summary: CompatibilityRoomSurface.RallarRoomSummary;
  member: CompatibilityRoomSurface.RallarRoomMember;
  state: CompatibilityRoomSurface.RallarRoomState;
  presenceWaitOptions: CompatibilityRoomSurface.RallarRoomPresenceWaitOptions;
  presenceWaitResult: CompatibilityRoomSurface.RallarRoomPresenceWaitResult;
  createInput: CompatibilityRoomSurface.RallarCreateRoomInput;
  targetInput: CompatibilityRoomSurface.RallarRoomTargetInput;
  updateInput: CompatibilityRoomSurface.RallarUpdateRoomInput;
  lifecycleOptions: CompatibilityRoomSurface.RallarRoomLifecycleOptions;
  inviteOptions: CompatibilityRoomSurface.RallarRoomInviteOptions;
  governanceOptions: CompatibilityRoomSurface.RallarRoomGovernanceOptions;
  joinOptions: CompatibilityRoomSurface.RallarJoinRoomOptions;
  joinInput: CompatibilityRoomSurface.RallarJoinRoomInput;
  switchOperation: CompatibilityRoomSurface.RallarRoomSwitchOperation;
  switchError: CompatibilityRoomSurface.RallarRoomSwitchPartialFailureError;
  leaveOptions: CompatibilityRoomSurface.RallarLeaveRoomOptions;
  eventOptions: CompatibilityRoomSurface.RallarRoomEventOptions;
  listEventsOptions: CompatibilityRoomSurface.RallarListRoomEventsOptions;
  listEventsInput: CompatibilityRoomSurface.RallarListRoomEventsInput;
  replayEventsOptions: CompatibilityRoomSurface.RallarReplayRoomEventsOptions;
  replayEventsInput: CompatibilityRoomSurface.RallarReplayRoomEventsInput;
  eventListener: CompatibilityRoomSurface.RallarRoomEventListener;
  sessionRealtimeInput: CompatibilityRoomSurface.RallarRoomSessionRealtimeInput;
  sessionMessageDefinition: CompatibilityRoomSurface.RallarRoomSessionMessageDefinition;
  session: CompatibilityRoomSurface.RallarRoomSession;
}>;

type OwningContracts = Readonly<{
  summary: OwningRoomContracts.RallarRoomSummary;
  member: OwningRoomContracts.RallarRoomMember;
  state: OwningRoomContracts.RallarRoomState;
  presenceWaitOptions: OwningRoomContracts.RallarRoomPresenceWaitOptions;
  presenceWaitResult: OwningRoomContracts.RallarRoomPresenceWaitResult;
  createInput: OwningRoomContracts.RallarCreateRoomInput;
  targetInput: OwningRoomContracts.RallarRoomTargetInput;
  updateInput: OwningRoomContracts.RallarUpdateRoomInput;
  lifecycleOptions: OwningRoomContracts.RallarRoomLifecycleOptions;
  inviteOptions: OwningRoomContracts.RallarRoomInviteOptions;
  governanceOptions: OwningRoomContracts.RallarRoomGovernanceOptions;
  joinOptions: OwningRoomContracts.RallarJoinRoomOptions;
  joinInput: OwningRoomContracts.RallarJoinRoomInput;
  switchOperation: OwningRoomContracts.RallarRoomSwitchOperation;
  switchError: OwningRoomContracts.RallarRoomSwitchPartialFailureError;
  leaveOptions: OwningRoomContracts.RallarLeaveRoomOptions;
  eventOptions: OwningRoomContracts.RallarRoomEventOptions;
  listEventsOptions: OwningRoomContracts.RallarListRoomEventsOptions;
  listEventsInput: OwningRoomContracts.RallarListRoomEventsInput;
  replayEventsOptions: OwningRoomContracts.RallarReplayRoomEventsOptions;
  replayEventsInput: OwningRoomContracts.RallarReplayRoomEventsInput;
  eventListener: OwningRoomContracts.RallarRoomEventListener;
  sessionRealtimeInput: OwningRoomContracts.RallarRoomSessionRealtimeInput;
  sessionMessageDefinition: OwningRoomContracts.RallarRoomSessionMessageDefinition;
  session: OwningRoomContracts.RallarRoomSession;
}>;

it('retains the current public facade return types through the existing path', () => {
  expectTypeOf<RallarRoomsFacade['state']>().returns.toEqualTypeOf<RallarRoomState>();
  expectTypeOf<RallarRoomsFacade['list']>().returns.toEqualTypeOf<readonly RallarRoomSummary[]>();
  expectTypeOf<RallarRoomsFacade['refresh']>().returns.toEqualTypeOf<Promise<RallarRoomState>>();
  expectTypeOf<RallarRoomsFacade['listEvents']>().returns.toEqualTypeOf<
    Promise<readonly GroupEvent[]>
  >();
  expectTypeOf<RallarRoomsFacade['listEventPage']>().returns.toEqualTypeOf<
    Promise<StateEventPage<GroupEvent>>
  >();
  expectTypeOf<RallarRoomsFacade['replayEvents']>().returns.toEqualTypeOf<
    Promise<RallarReplayEventsResult<GroupEvent>>
  >();
  expectTypeOf<RallarRoomsFacade['create']>().returns.toEqualTypeOf<Promise<GroupSnapshot>>();
  expectTypeOf<RallarRoomsFacade['createAndSwitch']>().returns.toEqualTypeOf<
    Promise<GroupSnapshot>
  >();
  expectTypeOf<RallarRoomsFacade['join']>().returns.toEqualTypeOf<Promise<GroupSnapshot>>();
  expectTypeOf<RallarRoomsFacade['enter']>().returns.toEqualTypeOf<Promise<RallarRoomSession>>();
  expectTypeOf<RallarRoomsFacade['session']>().returns.toEqualTypeOf<RallarRoomSession>();
  expectTypeOf<RallarRoomsFacade['leave']>().returns.toEqualTypeOf<
    Promise<GroupSnapshot | undefined>
  >();
  expectTypeOf<RallarRoomsFacade['waitForPresence']>().returns.toEqualTypeOf<
    Promise<RallarRoomPresenceWaitResult>
  >();
  expectTypeOf<RallarRoomsFacade['current']>().returns.toEqualTypeOf<GroupSnapshot | undefined>();
  expectTypeOf<RallarRoomsFacade['onChange']>().returns.toEqualTypeOf<RallarUnsubscribe>();
  expectTypeOf<RallarRoomsFacade['onEvent']>().returns.toEqualTypeOf<RallarUnsubscribe>();
});

it('exposes the existing room facade surface through the owning paths', () => {
  expect(createOwningRallarRoomsFacade).toBe(createCompatibilityRallarRoomsFacade);
  expectTypeOf<OwningRoomFacade.RallarRoomsFacade>().toEqualTypeOf<CompatibilityRoomSurface.RallarRoomsFacade>();
  expectTypeOf<OwningRoomFacade.CreateRallarRoomsFacadeOptions>().toEqualTypeOf<CompatibilityRoomSurface.CreateRallarRoomsFacadeOptions>();
  expectTypeOf<OwningContracts>().toEqualTypeOf<CompatibilityRoomContracts>();
});

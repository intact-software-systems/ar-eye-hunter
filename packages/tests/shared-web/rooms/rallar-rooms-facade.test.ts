import { expectTypeOf, it } from 'vitest';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type {
  RallarReplayEventsResult,
  RallarRoomPresenceWaitResult,
  RallarRoomSession,
  RallarRoomState,
  RallarRoomSummary,
  RallarRoomsFacade,
  RallarUnsubscribe,
} from '@shared-web/browser/rallar-rooms-facade.ts';

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

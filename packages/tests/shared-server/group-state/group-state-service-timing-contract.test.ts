import { describe, expect, expectTypeOf, it } from 'vitest';

import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createTimedGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import {
  createGroupStateServiceTimingFake,
  invokeEveryTimedGroupStateOperation,
  invokeTimedGroupStateOperation,
  type PromiseReturningGroupStateServiceKey,
  type PromiseReturningMethodKey,
  TIMED_ASYNC_OPERATION_COVERAGE,
  TIMED_ASYNC_OPERATIONS,
  TIMED_OPERATION_ARGUMENTS,
  type TimedAsyncOperation,
} from './group-state-service-timing-fixture.ts';

interface OptionalAsyncCoverageProbe {
  readonly value: string;
  required(): Promise<string>;
  optional?(): Promise<number>;
  synchronous(): boolean;
}

describe('group-state service timing contract', () => {
  it('covers every required and optional Promise-returning service method exactly once', () => {
    expectTypeOf<TimedAsyncOperation>().toEqualTypeOf<PromiseReturningGroupStateServiceKey>();
    expectTypeOf<PromiseReturningMethodKey<OptionalAsyncCoverageProbe>>().toEqualTypeOf<
      'required' | 'optional'
    >();
    expect(TIMED_ASYNC_OPERATION_COVERAGE).toBe(true);
    expect(new Set(TIMED_ASYNC_OPERATIONS).size).toBe(TIMED_ASYNC_OPERATIONS.length);
  });

  it('passes the exact argument tuple to every underlying service method', async () => {
    const fake = createGroupStateServiceTimingFake();
    const timed = createTimedGroupStateService({
      service: fake.service,
      serviceId: 'timing-service',
      timing: () => undefined,
    });

    await invokeEveryTimedGroupStateOperation(timed);

    expect(fake.invocations.map((invocation) => invocation.operation)).toEqual([
      ...TIMED_ASYNC_OPERATIONS,
    ]);
    for (const invocation of fake.invocations) {
      expectExactArgumentIdentity(
        invocation.arguments,
        TIMED_OPERATION_ARGUMENTS[invocation.operation],
      );
    }
  });

  it('preserves the optional listRecentEvents method when present', async () => {
    const timeline: string[] = [];
    const fake = createGroupStateServiceTimingFake(undefined, (operation) =>
      timeline.push(`call:${operation}`),
    );
    const timingEvents: RallarTimingEvent[] = [];
    const timed = createTimedGroupStateService({
      service: fake.service,
      serviceId: 'timing-service',
      timing: (event) => {
        timingEvents.push(event);
        timeline.push(`event:${event.operation}`);
      },
    });

    await expect(invokeTimedGroupStateOperation(timed, 'listRecentEvents')).resolves.toBe(
      fake.sentinels.listRecentEvents,
    );
    expectExactArgumentIdentity(
      fake.invocations[0]?.arguments ?? [],
      TIMED_OPERATION_ARGUMENTS.listRecentEvents,
    );
    expect(timeline).toEqual(['call:listRecentEvents', 'event:listRecentEvents']);
    expect(timingEvents).toEqual([
      {
        type: 'rallar.timing',
        component: 'group-state-service',
        operation: 'listRecentEvents',
        serviceId: 'timing-service',
        requestId: undefined,
        applicationId: 'timing-app',
        workspaceId: 'timing-workspace',
        groupId: undefined,
        principalId: undefined,
        sessionId: undefined,
        status: 'ok',
        durationMs: expect.any(Number),
        atEpochMs: expect.any(Number),
      },
    ]);
  });

  it('preserves optional listRecentEvents absence without a method or timing event', () => {
    const fake = createGroupStateServiceTimingFake();
    const { listRecentEvents, ...serviceWithoutRecentEvents } = fake.service;
    const timingEvents: RallarTimingEvent[] = [];
    const timed = createTimedGroupStateService({
      service: serviceWithoutRecentEvents as GroupStateService,
      serviceId: 'timing-service',
      timing: (event) => timingEvents.push(event),
    });

    expect(listRecentEvents).toBeTypeOf('function');
    expect(timed.listRecentEvents).toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(fake.invocations).toEqual([]);
    expect(timingEvents).toEqual([]);
  });
});

function expectExactArgumentIdentity(
  actual: readonly unknown[],
  expected: readonly unknown[],
): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, value] of expected.entries()) {
    expect(actual[index], `argument ${index}`).toBe(value);
  }
}

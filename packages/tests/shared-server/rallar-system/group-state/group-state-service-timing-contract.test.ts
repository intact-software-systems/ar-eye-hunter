import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createTimedGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    createGroupStateServiceTimingFake,
    invokeEveryTimedGroupStateOperation,
    invokeTimedGroupStateOperation,
    invokeUntimedGroupStateOperations,
    invokeUntimedGroupStateWrite,
    TIMED_ASYNC_OPERATION_COVERAGE,
    TIMED_ASYNC_OPERATIONS,
    TIMED_OPERATION_ARGUMENTS,
    type PromiseReturningGroupStateServiceKey,
    type PromiseReturningMethodKey,
    type TimedAsyncOperation,
    type TimedOperationArgument
} from './group-state-service-timing-fixture.ts';

interface OptionalAsyncCoverageProbe {
    readonly value: string;
    required(): Promise<string>;
    optional?(): Promise<number>;
    synchronous(): boolean;
}

describe('group-state service timing contract', () => {
    it('covers every Promise-returning service method except transaction-bound write', () => {
        expectTypeOf<TimedAsyncOperation>().toEqualTypeOf<Exclude<PromiseReturningGroupStateServiceKey, 'write'>>();
        expectTypeOf<PromiseReturningMethodKey<OptionalAsyncCoverageProbe>>().toEqualTypeOf<'required' | 'optional'>();
        expect(TIMED_ASYNC_OPERATION_COVERAGE).toBe(true);
        expect(new Set(TIMED_ASYNC_OPERATIONS).size).toBe(TIMED_ASYNC_OPERATIONS.length);
    });

    it('preserves each service operation result type through the generic timing harness', async () => {
        const fake = createGroupStateServiceTimingFake();
        const recentEvents = invokeTimedGroupStateOperation(fake.service, 'listRecentEvents');
        const everyResult = invokeEveryTimedGroupStateOperation(fake.service);
        const computed = invokeUntimedGroupStateOperations(fake.service);
        const written = invokeUntimedGroupStateWrite(fake.service);

        expectTypeOf(recentEvents).toEqualTypeOf<ReturnType<GroupStateService['listRecentEvents']>>();
        expectTypeOf<Awaited<typeof everyResult>['listRecentEvents']>().toEqualTypeOf<Awaited<ReturnType<GroupStateService['listRecentEvents']>>>();
        expectTypeOf(computed).toEqualTypeOf<ReturnType<GroupStateService['compute']>>();
        expectTypeOf(written).toEqualTypeOf<ReturnType<GroupStateService['write']>>();

        await Promise.all([recentEvents, everyResult, written]);
    });

    it('forwards transaction-bound writes without reading a timing clock', async () => {
        const fake = createGroupStateServiceTimingFake();
        const timingEvents: RallarTimingEvent[] = [];
        const timed = createTimedGroupStateService({
            service: fake.service,
            serviceId: 'timing-service',
            timing: (event) => timingEvents.push(event)
        });

        await expect(invokeUntimedGroupStateWrite(timed)).resolves.toBe(fake.sentinels.write);
        expect(fake.calls).toEqual(['write']);
        expect(timingEvents).toEqual([]);
    });

    it('passes the exact argument tuple to every underlying service method', async () => {
        const fake = createGroupStateServiceTimingFake();
        const timed = createTimedGroupStateService({
            service: fake.service,
            serviceId: 'timing-service',
            timing: () => undefined
        });

        await invokeEveryTimedGroupStateOperation(timed);

        expect(fake.invocations.map((invocation) => invocation.operation)).toEqual([
            ...TIMED_ASYNC_OPERATIONS
        ]);
        for (const invocation of fake.invocations) {
            expectExactArgumentIdentity(
                invocation.arguments,
                TIMED_OPERATION_ARGUMENTS[invocation.operation]
            );
        }
    });

    it('times the required listRecentEvents method', async () => {
        const timeline: string[] = [];
        const fake = createGroupStateServiceTimingFake(undefined, (operation) => timeline.push(`call:${operation}`));
        const timingEvents: RallarTimingEvent[] = [];
        const timed = createTimedGroupStateService({
            service: fake.service,
            serviceId: 'timing-service',
            timing: (event) => {
                timingEvents.push(event);
                timeline.push(`event:${event.operation}`);
            }
        });

        await expect(invokeTimedGroupStateOperation(timed, 'listRecentEvents')).resolves.toBe(
            fake.sentinels.listRecentEvents
        );
        expectExactArgumentIdentity(
            fake.invocations[0]?.arguments ?? [],
            TIMED_OPERATION_ARGUMENTS.listRecentEvents
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
                atEpochMs: expect.any(Number)
            }
        ]);
    });
});

function expectExactArgumentIdentity(
    actual: readonly TimedOperationArgument[],
    expected: readonly TimedOperationArgument[]
): void {
    expect(actual).toHaveLength(expected.length);
    for (const [index, value] of expected.entries()) {
        expect(actual[index], `argument ${index}`).toBe(value);
    }
}

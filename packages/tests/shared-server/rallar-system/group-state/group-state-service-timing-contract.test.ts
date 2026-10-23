import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createTimedGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-timing.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import {
    createGroupStateServiceTimingFake,
    invokeEveryTimedGroupStateOperation,
    invokeTimedGroupStateOperation,
    invokeUntimedGroupStateOperations,
    invokeUntimedGroupStateWrite,
    TIMED_ASYNC_OPERATION_COVERAGE,
    TIMED_ASYNC_OPERATIONS,
    TIMED_OPERATION_ARGUMENTS,
    type PromiseReturningMethodKey,
    type TimedAsyncOperation,
    type TimedOperationArgument
} from './group-state-service-timing-fixture.ts';
import { activateMember, presenceConnectEnqueue } from './inbox/group-state-inbox-presence-fixtures.ts';
import { createAuthorityHarness, createRoom, processAuthenticated } from './inbox/group-state-inbox-test-runtime.ts';
import { createGroupDeltaProducer } from './presence/group-delta-producer-fixture.ts';

interface OptionalAsyncCoverageProbe {
    readonly value: string;
    required(): Promise<string>;
    optional?(): Promise<number>;
    synchronous(): boolean;
}

describe('group-state service timing contract', () => {
    it('covers every Promise-returning service method except transaction-bound write', () => {
        expectTypeOf<TimedAsyncOperation>().toEqualTypeOf<Exclude<PromiseReturningMethodKey<GroupStateService>, 'write'>>();
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

describe('group mutation lane phase timing', () => {
    it('captures the ingress before its enqueue spans start and leaves the lane no capture or persist phase', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const harness = await createAuthorityHarness(['owner', 'alice'], {
            serviceOptions: { phaseTiming: true },
            timing: (event) => timingEvents.push(event)
        });
        await createRoom(harness, 'lane-timing-room', 'Lane timing room');
        await activateMember(harness, 'lane-timing-room', 'alice');
        const recordedBefore = timingEvents.length;

        const connected = await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: harness.sessions.alice,
            input: presenceConnectEnqueue('lane-timing-room', 'alice', harness.nowEpochMs)
        });
        expect(connected.right).toMatchObject({ commandId: expect.any(String) });

        const connectEvents = timingEvents.slice(recordedBefore);
        const order = connectEvents.map((event) => `${event.component}:${event.operation}`);
        const phaseOrder = connectEvents
            .filter((event) => event.component === 'app-inbox-phase' && event.requestId === 'connect-alice')
            .map((event) => event.operation);
        expect(phaseOrder).not.toContain('ingress-capture');
        expect(phaseOrder).not.toContain('ingress-persist');
        const capture = connectEvents.find((event) => event.operation === 'captureAppInboxMutationIngress');
        const spans = connectEvents.filter((event) =>
            event.requestId === 'connect-alice' &&
            (event.operation === 'enqueue' || event.operation === 'enqueueAndWaitForResult')
        );
        expect(capture).toBeDefined();
        expect(spans.map((event) => event.operation).sort()).toEqual(['enqueue', 'enqueueAndWaitForResult']);
        for (const span of spans) {
            // A line's end is a whole wall-clock millisecond and its duration a monotonic one, hence the 1 ms slack.
            expect(capture?.atEpochMs).toBeLessThanOrEqual(span.atEpochMs - span.durationMs + 1);
        }
        expect(phaseOrder.indexOf('enqueue')).toBeLessThan(phaseOrder.indexOf('transaction'));
        expect(connectEvents.find((event) => event.operation === 'enqueue')).toEqual({
            type: 'rallar.timing',
            component: 'app-inbox-phase',
            operation: 'enqueue',
            serviceId: 'server-12345678',
            requestId: 'connect-alice',
            status: 'ok',
            durationMs: expect.any(Number),
            atEpochMs: expect.any(Number),
            details: {
                type: AppInboxType.GROUP_PRESENCE_CONNECT,
                contextId: expect.any(String),
                resourceId: 'connect-alice',
                senderId: 'alice'
            }
        });
    });

    it('emits no lane phases while phase timing is off', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const harness = await createAuthorityHarness(['owner'], {
            timing: (event) => timingEvents.push(event)
        });
        await createRoom(harness, 'silent-lane-room', 'Silent lane room');

        expect(
            timingEvents.filter((event) => event.component === 'app-inbox-phase').map((event) => event.operation)
        ).not.toContain('enqueue');
        expect(timingEvents.map((event) => event.component)).toContain('group-state-service');
    });
});

describe('group presence summary phase timing', () => {
    it('times the read, compute and write of one summary expansion with its recipient count', async () => {
        const producer = await createGroupDeltaProducer();
        const timingEvents: RallarTimingEvent[] = [];
        const worker = new GroupPresenceSummaryWork({
            database: producer.database,
            runtimeRepository: producer.repository,
            outboxQueueReader: new OutboxQueueReader(new PSqlQueueBox(producer.resources, Temporal.Now.instant)),
            recomputeDebounceMs: 0,
            recomputeMaxWaitMs: 0,
            serviceId: 'producer-api',
            now: () => producer.now,
            timing: (event) => timingEvents.push(event)
        });

        await worker.processReservedEntry(producer.message, producer.entry);

        const identity = {
            type: 'rallar.timing',
            component: 'group-presence-summary',
            serviceId: 'producer-api',
            requestId: `connect-${producer.ref.groupId}`,
            applicationId: producer.ref.applicationId,
            workspaceId: producer.ref.workspaceId,
            groupId: producer.ref.groupId,
            status: 'ok',
            durationMs: expect.any(Number),
            atEpochMs: expect.any(Number)
        };
        const summaryTiming = timingEvents.filter((event) => event.component === 'group-presence-summary');
        expect(summaryTiming).toEqual([
            { ...identity, operation: 'claim', details: { coalescedWorkCount: 1 } },
            { ...identity, operation: 'read', details: { coalescedWorkCount: 1 } },
            { ...identity, operation: 'compute', details: { coalescedWorkCount: 1, recipientCount: 1, deltaCount: 1 } },
            { ...identity, operation: 'write', details: { coalescedWorkCount: 1, recipientCount: 1, deltaCount: 1 } },
            {
                ...identity,
                operation: 'committed-output-observed',
                durationMs: 0,
                details: {
                    outcome: 'written',
                    acceptedGroupRevision: 1,
                    acceptedPresenceRevision: 0,
                    topicId: 'group-state.event',
                    resourceId: expect.any(String),
                    contextId: expect.any(String)
                }
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

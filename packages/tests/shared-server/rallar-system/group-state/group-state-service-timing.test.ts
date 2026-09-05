import { describe, expect, it } from 'vitest';

import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createGroupStateServiceTimingFake,
    invokeEveryTimedGroupStateOperation,
    invokeTimedGroupStateOperation,
    invokeUntimedGroupStateOperations,
    invokeUntimedGroupStateWrite,
    TIMED_ASYNC_OPERATIONS,
    type TimedAsyncOperation
} from './group-state-service-timing-fixture.ts';
import { createTestGroupStateRuntime } from './group-state-test-runtime.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('group-state service timing boundary', () => {
    it('times one asynchronous service call with its exact return value and details', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const runtime = createTestGroupStateRuntime({
            runtimeRepository: new FakeRuntimeStateRepository(),
            now: () => 1_000,
            serviceId: 'timing-service',
            timing: (event) => timingEvents.push(event)
        });

        await expect(runtime.durable.listSnapshots(scope)).resolves.toEqual([]);
        expect(timingEvents).toEqual([
            expect.objectContaining({
                component: 'group-state-service',
                operation: 'listSnapshots',
                serviceId: 'timing-service',
                applicationId: scope.applicationId,
                workspaceId: scope.workspaceId,
                status: 'ok'
            })
        ]);
    });

    it('characterizes every asynchronous service operation and leaves compute/validate untimed', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const runtime = createTestGroupStateRuntime({
            runtimeRepository: new FakeRuntimeStateRepository(),
            now: () => 1_000,
            serviceId: 'timing-service',
            timing: (event) => timingEvents.push(event)
        });
        const snapshot = await createTimingSnapshot(runtime);

        await invokePreparationOperations(runtime);
        await invokeStateReadOperations(runtime, snapshot);
        expectTimingInventory(timingEvents);
        expectTimingDetails(timingEvents);
    });

    it('propagates a service rejection and records one matching error timing event', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const runtime = createTestGroupStateRuntime({
            runtimeRepository: new FakeRuntimeStateRepository(),
            now: () => 1_000,
            serviceId: 'timing-service',
            timing: (event) => timingEvents.push(event)
        });

        await expect(
            runtime.durable.prepareSessionCleanupMutations({
                scope,
                authSession: {
                    clientId: 'missing-owner',
                    sessionId: 'missing-owner-session',
                    username: 'missing-owner',
                    issuedAtEpochMs: 1,
                    expiresAtEpochMs: 253_402_300_799_999
                },
                principalId: 'missing-owner',
                disconnectedAtEpochMs: 1_000
            })
        ).rejects.toThrow('Group session cleanup authority is no longer valid');
        expect(timingEvents).toEqual([
            expect.objectContaining({
                component: 'group-state-service',
                operation: 'prepareSessionCleanupMutations',
                serviceId: 'timing-service',
                applicationId: undefined,
                workspaceId: undefined,
                principalId: 'missing-owner',
                sessionId: undefined,
                requestId: undefined,
                groupId: undefined,
                status: 'error'
            })
        ]);
    });

    it('maps every future timed operation to its exact fake service call', async () => {
        for (const operation of TIMED_ASYNC_OPERATIONS) {
            const fake = createGroupStateServiceTimingFake(operation);

            await expect(invokeTimedGroupStateOperation(fake.service, operation)).rejects.toBe(
                fake.rejection
            );
            expect(fake.calls).toEqual([operation]);
        }
    });

    it('keeps untimed service identity and times each explicit asynchronous operation', async () => {
        const { createTimedGroupStateService } = await import('@shared-server/rallar-system/group-state/group-state-service-timing.ts');
        expectNoTimingServiceIdentity(createTimedGroupStateService);
        await expectEveryTimedSuccess(createTimedGroupStateService);
        await expectEveryTimedRejection(createTimedGroupStateService);
    });
});

type ServiceTimingRuntime = ReturnType<typeof createTestGroupStateRuntime>;

interface CreateTimedGroupStateServiceInput {
    readonly service: GroupStateService;
    readonly serviceId: string;
    readonly timing: RallarTimingSink | undefined;
}

type CreateTimedGroupStateService = (input: CreateTimedGroupStateServiceInput) => GroupStateService;

async function createTimingSnapshot(runtime: ServiceTimingRuntime) {
    const created = await runtime.service.createGroup(scope, {
        groupId: 'timing-room',
        displayName: 'Timing room',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'owner',
        requestId: 'timing-create'
    });
    const snapshot = created.result?.snapshot;
    if (!snapshot) {
        throw new Error('Expected a created group snapshot');
    }
    return snapshot;
}

async function invokePreparationOperations(runtime: ServiceTimingRuntime) {
    await expect(runtime.durable.prepareExpiredPresenceMutations(1_000)).resolves.toEqual([]);
    await expect(
        runtime.durable.prepareSessionCleanupMutations({
            scope,
            authSession: {
                clientId: 'owner',
                sessionId: 'owner-session',
                username: 'owner',
                issuedAtEpochMs: 1,
                expiresAtEpochMs: 253_402_300_799_999
            },
            principalId: 'owner',
            disconnectedAtEpochMs: 1_000
        })
    ).resolves.toEqual([]);
}

async function invokeStateReadOperations(
    runtime: ServiceTimingRuntime,
    snapshot: Awaited<ReturnType<typeof createTimingSnapshot>>
) {
    const ref = { ...scope, groupId: 'timing-room' };
    await expect(runtime.durable.listSnapshots(scope)).resolves.toEqual([snapshot]);
    await expect(runtime.durable.listSnapshotsPage(scope, { limit: 1 })).resolves.toEqual({
        snapshots: [snapshot],
        scannedGroupCount: 1,
        hasMore: false,
        nextGroupKey: 'app=app-1:ws=workspace-1:group=timing-room'
    });
    await expect(runtime.durable.readSnapshot(ref)).resolves.toEqual(snapshot);
    await expect(runtime.durable.readCausalRevision(ref)).resolves.toEqual({
        groupRevision: 1,
        presenceRevision: 0
    });
    await expect(runtime.durable.readIssuedAuthSession('owner-session')).resolves.toMatchObject({
        clientId: 'owner',
        sessionId: 'owner-session'
    });
    await expect(runtime.durable.listEvents(ref)).resolves.toHaveLength(1);
    await expect(runtime.durable.listRecentEvents!(ref, { limit: 1 })).resolves.toHaveLength(1);
    await expect(runtime.durable.listEventPage(ref, { limit: 1 })).resolves.toMatchObject({
        hasMore: false
    });
    await expect(runtime.durable.observeSnapshot(snapshot)).resolves.toBe(snapshot);
}

function expectTimingInventory(timingEvents: readonly RallarTimingEvent[]): void {
    const operationCounts = Map.groupBy(timingEvents, (event) => event.operation);
    expect([...operationCounts.keys()]).toEqual([
        'prepareMutation',
        'read',
        'prepareExpiredPresenceMutations',
        'prepareSessionCleanupMutations',
        'listSnapshots',
        'listSnapshotsPage',
        'readSnapshot',
        'readCausalRevision',
        'readIssuedAuthSession',
        'listEvents',
        'listRecentEvents',
        'listEventPage',
        'observeSnapshot'
    ]);
    for (const operation of operationCounts.keys()) {
        expect(operationCounts.get(operation), operation).toHaveLength(1);
    }
    expect(operationCounts.has('compute')).toBe(false);
    expect(operationCounts.has('validate')).toBe(false);
}

function expectTimingDetails(timingEvents: readonly RallarTimingEvent[]): void {
    const operationCounts = Map.groupBy(timingEvents, (event) => event.operation);
    expect(operationCounts.get('prepareMutation')?.[0]).toMatchObject({
        component: 'group-state-service',
        operation: 'prepareMutation',
        serviceId: 'timing-service',
        ...expectedTimingIdentity('prepareMutation'),
        status: 'ok'
    });
    expect(operationCounts.get('listSnapshots')?.[0]).toMatchObject({
        component: 'group-state-service',
        operation: 'listSnapshots',
        serviceId: 'timing-service',
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        status: 'ok'
    });
}

function expectNoTimingServiceIdentity(createTimed: CreateTimedGroupStateService): void {
    const fake = createGroupStateServiceTimingFake();
    expect(
        createTimed({ service: fake.service, serviceId: 'timing-service', timing: undefined })
    ).toBe(fake.service);
}

async function expectEveryTimedSuccess(createTimed: CreateTimedGroupStateService): Promise<void> {
    const timeline: string[] = [];
    const fake = createGroupStateServiceTimingFake(undefined, (operation) => timeline.push(`call:${operation}`));
    const timingEvents: RallarTimingEvent[] = [];
    const timed = createTimed({
        service: fake.service,
        serviceId: 'timing-service',
        timing: (event) => {
            timingEvents.push(event);
            timeline.push(`event:${event.operation}`);
        }
    });
    expect(timed.compute).toBe(fake.service.compute);
    expect(timed.validate).toBe(fake.service.validate);
    expect(timed.sessionGenerationLifecycle).toBe(fake.service.sessionGenerationLifecycle);

    const results = await invokeEveryTimedGroupStateOperation(timed);
    for (const operation of TIMED_ASYNC_OPERATIONS) {
        expect(results[operation], operation).toBe(fake.sentinels[operation]);
    }
    expect(invokeUntimedGroupStateOperations(timed)).toBe(fake.sentinels.compute);
    await expect(invokeUntimedGroupStateWrite(timed)).resolves.toBe(fake.sentinels.write);
    expect(fake.calls).toEqual([...TIMED_ASYNC_OPERATIONS, 'compute', 'validate', 'write']);
    expect(timingEvents).toHaveLength(TIMED_ASYNC_OPERATIONS.length);
    expect(timeline).toEqual([
        ...TIMED_ASYNC_OPERATIONS.flatMap((operation) => [`call:${operation}`, `event:${operation}`]),
        'call:write'
    ]);
    for (const [index, operation] of TIMED_ASYNC_OPERATIONS.entries()) {
        expect(timingEvents[index], operation).toMatchObject({
            type: 'rallar.timing',
            component: 'group-state-service',
            operation,
            serviceId: 'timing-service',
            status: 'ok',
            ...expectedTimingIdentity(operation)
        });
    }
}

async function expectEveryTimedRejection(createTimed: CreateTimedGroupStateService): Promise<void> {
    for (const operation of TIMED_ASYNC_OPERATIONS) {
        await expectTimedOperationRejection(createTimed, operation);
    }
}

async function expectTimedOperationRejection(
    createTimed: CreateTimedGroupStateService,
    operation: TimedAsyncOperation
): Promise<void> {
    const timeline: string[] = [];
    const fake = createGroupStateServiceTimingFake(operation, (called) => timeline.push(`call:${called}`));
    const timingEvents: RallarTimingEvent[] = [];
    const timed = createTimed({
        service: fake.service,
        serviceId: 'timing-service',
        timing: (event) => {
            timingEvents.push(event);
            timeline.push(`event:${event.operation}`);
        }
    });

    await expect(invokeTimedGroupStateOperation(timed, operation)).rejects.toBe(fake.rejection);
    expect(fake.calls).toEqual([operation]);
    expect(timeline).toEqual([`call:${operation}`, `event:${operation}`]);
    expect(timingEvents).toEqual([
        {
            type: 'rallar.timing',
            component: 'group-state-service',
            operation,
            serviceId: 'timing-service',
            status: 'error',
            durationMs: expect.any(Number),
            atEpochMs: expect.any(Number),
            error: { name: 'Error', message: `controlled ${operation} rejection` },
            ...expectedTimingIdentity(operation)
        }
    ]);
}

function expectedTimingIdentity(operation: TimedAsyncOperation) {
    const empty = {
        requestId: undefined,
        applicationId: undefined,
        workspaceId: undefined,
        groupId: undefined,
        principalId: undefined,
        sessionId: undefined
    };
    if (operation === 'read') {
        return {
            ...empty,
            requestId: 'timing-read-request',
            applicationId: 'timing-app',
            workspaceId: 'timing-workspace',
            groupId: 'timing-group'
        };
    }
    if (operation === 'prepareSessionCleanupMutations') {
        return { ...empty, principalId: 'cleanup-principal' };
    }
    if (SCOPE_TIMING_OPERATIONS.has(operation)) {
        return { ...empty, applicationId: 'timing-app', workspaceId: 'timing-workspace' };
    }
    return empty;
}

const SCOPE_TIMING_OPERATIONS: ReadonlySet<TimedAsyncOperation> = new Set([
    'listSnapshots',
    'listSnapshotsPage',
    'readSnapshot',
    'readCausalRevision',
    'listEvents',
    'listRecentEvents',
    'listEventPage'
]);

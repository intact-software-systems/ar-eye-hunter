import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';

export type PromiseReturningMethodKey<Service> = {
    [Key in keyof Service]-?: Exclude<Service[Key], undefined> extends (
        ...arguments_: infer Arguments
    ) => Promise<infer Result> ? Key :
        never;
}[keyof Service];

export type PromiseReturningGroupStateServiceKey = PromiseReturningMethodKey<GroupStateService>;
type PromiseReturningTimedGroupStateServiceKey = Exclude<PromiseReturningGroupStateServiceKey, 'write'>;

export const TIMED_ASYNC_OPERATIONS = [
    'authorizeMutation',
    'prepareMutation',
    'prepareAppInboxMutation',
    'prepareExpiredPresenceMutations',
    'prepareSessionCleanupMutations',
    'prepareFormationCriterionMutation',
    'prepareFormationAutomationMutation',
    'prepareTopologyPublicationMutation',
    'prepareActivationStatusMutation',
    'listSnapshots',
    'listSnapshotsPage',
    'readSnapshot',
    'readCausalRevision',
    'readIssuedAuthSession',
    'listEvents',
    'listRecentEvents',
    'listEventPage',
    'observeSnapshot',
    'read'
] as const satisfies readonly PromiseReturningTimedGroupStateServiceKey[];

export type TimedAsyncOperation = (typeof TIMED_ASYNC_OPERATIONS)[number];

type MissingTimedAsyncOperation = Exclude<PromiseReturningTimedGroupStateServiceKey, TimedAsyncOperation>;
type ExtraTimedAsyncOperation = Exclude<TimedAsyncOperation, PromiseReturningTimedGroupStateServiceKey>;
type HasExactTimedAsyncOperationCoverage = [
    MissingTimedAsyncOperation | ExtraTimedAsyncOperation
] extends [never] ? true :
    false;

export const TIMED_ASYNC_OPERATION_COVERAGE: HasExactTimedAsyncOperationCoverage = true;

type GroupStateServiceOperationArguments<Operation extends PromiseReturningGroupStateServiceKey> = Exclude<GroupStateService[Operation], undefined> extends (
    ...arguments_: infer Arguments
) => Promise<infer Result> ? Arguments :
    never;

type GroupStateServiceOperationResult<Operation extends PromiseReturningGroupStateServiceKey> = Exclude<GroupStateService[Operation], undefined> extends
    (...arguments_: never[]) => Promise<infer Result> ? Result :
    never;

export type TimedOperationArguments<Operation extends TimedAsyncOperation> = GroupStateServiceOperationArguments<Operation>;
export type TimedOperationResult<Operation extends TimedAsyncOperation> = GroupStateServiceOperationResult<Operation>;

export type TimedOperationArgument = {
    readonly [Operation in TimedAsyncOperation]: TimedOperationArguments<Operation>[number];
}[TimedAsyncOperation];

type FakeAsyncOperation = TimedAsyncOperation | 'write';
type TimingSentinelOperation = FakeAsyncOperation | 'compute';

export type TimedOperationInvocation = {
    readonly [Operation in TimedAsyncOperation]: Readonly<{
        operation: Operation;
        arguments: TimedOperationArguments<Operation>;
    }>;
}[TimedAsyncOperation];

type FakeAsyncOperationInvocation = {
    readonly [Operation in FakeAsyncOperation]: Readonly<{
        operation: Operation;
        arguments: GroupStateServiceOperationArguments<Operation>;
    }>;
}[FakeAsyncOperation];

interface TimingSentinel<Operation extends TimingSentinelOperation> {
    readonly operation: Operation;
    readonly sentinel: true;
}

type TimingSentinels = {
    readonly [Operation in TimingSentinelOperation]: TimingSentinel<Operation>;
};

type FakeAsyncOperationSentinel = {
    readonly [Operation in FakeAsyncOperation]: TimingSentinel<Operation>;
}[FakeAsyncOperation];

type RecordTimedOperation = (
    invocation: FakeAsyncOperationInvocation
) => Promise<FakeAsyncOperationSentinel>;

export interface GroupStateServiceTimingFake {
    readonly service: GroupStateService;
    readonly calls: readonly string[];
    readonly invocations: readonly TimedOperationInvocation[];
    readonly sentinels: TimingSentinels;
    readonly rejection: Error;
}

export function createGroupStateServiceTimingFake(
    rejectOperation?: FakeAsyncOperation,
    onCall?: (operation: FakeAsyncOperation) => void
): GroupStateServiceTimingFake {
    const calls: string[] = [];
    const invocations: TimedOperationInvocation[] = [];
    const rejection = new Error(`controlled ${rejectOperation ?? 'unused'} rejection`);
    const sentinels = createTimingSentinels();
    const record: RecordTimedOperation = async (invocation) => {
        const { operation } = invocation;
        calls.push(operation);
        if (operation !== 'write') {
            invocations.push(invocation);
        }
        onCall?.(operation);
        if (operation === rejectOperation) {
            throw rejection;
        }
        return sentinels[operation];
    };
    const service: GroupStateService = {
        sessionGenerationLifecycle: Object.freeze({}) as never,
        ...createPreparationFake(record),
        ...createQueryFake(record),
        ...createMutationFake(record, calls, sentinels.compute)
    };
    return { service, calls, invocations, sentinels, rejection };
}

function createTimingSentinels(): TimingSentinels {
    return Object.fromEntries(
        [...TIMED_ASYNC_OPERATIONS, 'write', 'compute'].map((operation) => [
            operation,
            Object.freeze({ operation, sentinel: true })
        ])
    ) as TimingSentinels;
}

function createPreparationFake(
    record: RecordTimedOperation
): Pick<
    GroupStateService,
    | 'authorizeMutation'
    | 'prepareMutation'
    | 'prepareAppInboxMutation'
    | 'prepareExpiredPresenceMutations'
    | 'prepareSessionCleanupMutations'
    | 'prepareFormationCriterionMutation'
    | 'prepareFormationAutomationMutation'
    | 'prepareTopologyPublicationMutation'
    | 'prepareActivationStatusMutation'
> {
    return {
        authorizeMutation: async (...arguments_) => (await record({ operation: 'authorizeMutation', arguments: arguments_ })) as never,
        prepareMutation: async (...arguments_) => (await record({ operation: 'prepareMutation', arguments: arguments_ })) as never,
        prepareAppInboxMutation: async (...arguments_) => (await record({ operation: 'prepareAppInboxMutation', arguments: arguments_ })) as never,
        prepareExpiredPresenceMutations: async (...arguments_) =>
            (await record({ operation: 'prepareExpiredPresenceMutations', arguments: arguments_ })) as never,
        prepareFormationCriterionMutation: async (...arguments_) =>
            (await record({ operation: 'prepareFormationCriterionMutation', arguments: arguments_ })) as never,
        prepareFormationAutomationMutation: async (...arguments_) =>
            (await record({ operation: 'prepareFormationAutomationMutation', arguments: arguments_ })) as never,
        prepareTopologyPublicationMutation: async (...arguments_) =>
            (await record({ operation: 'prepareTopologyPublicationMutation', arguments: arguments_ })) as never,
        prepareActivationStatusMutation: async (...arguments_) =>
            (await record({ operation: 'prepareActivationStatusMutation', arguments: arguments_ })) as never,
        prepareSessionCleanupMutations: async (...arguments_) => (await record({ operation: 'prepareSessionCleanupMutations', arguments: arguments_ })) as never
    };
}

function createQueryFake(
    record: RecordTimedOperation
): Pick<
    GroupStateService,
    | 'listSnapshots'
    | 'listSnapshotsPage'
    | 'readSnapshot'
    | 'readCausalRevision'
    | 'readIssuedAuthSession'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listEventPage'
    | 'observeSnapshot'
> {
    return {
        listSnapshots: async (...arguments_) => (await record({ operation: 'listSnapshots', arguments: arguments_ })) as never,
        listSnapshotsPage: async (...arguments_) => (await record({ operation: 'listSnapshotsPage', arguments: arguments_ })) as never,
        readSnapshot: async (...arguments_) => (await record({ operation: 'readSnapshot', arguments: arguments_ })) as never,
        readCausalRevision: async (...arguments_) => (await record({ operation: 'readCausalRevision', arguments: arguments_ })) as never,
        readIssuedAuthSession: async (...arguments_) => (await record({ operation: 'readIssuedAuthSession', arguments: arguments_ })) as never,
        listEvents: async (...arguments_) => (await record({ operation: 'listEvents', arguments: arguments_ })) as never,
        listRecentEvents: async (...arguments_) => (await record({ operation: 'listRecentEvents', arguments: arguments_ })) as never,
        listEventPage: async (...arguments_) => (await record({ operation: 'listEventPage', arguments: arguments_ })) as never,
        observeSnapshot: async (...arguments_) => (await record({ operation: 'observeSnapshot', arguments: arguments_ })) as never
    };
}

function createMutationFake(
    record: RecordTimedOperation,
    calls: string[],
    computeSentinel: TimingSentinel<'compute'>
): Pick<GroupStateService, 'read' | 'compute' | 'validate' | 'write'> {
    return {
        read: async (...arguments_) => (await record({ operation: 'read', arguments: arguments_ })) as never,
        compute: () => {
            calls.push('compute');
            return computeSentinel as never;
        },
        validate: () => {
            calls.push('validate');
            return [];
        },
        write: async (...arguments_) => (await record({ operation: 'write', arguments: arguments_ })) as never
    };
}

export type TimedOperationResults = {
    readonly [Operation in TimedAsyncOperation]: TimedOperationResult<Operation>;
};

export async function invokeEveryTimedGroupStateOperation(
    service: GroupStateService
): Promise<TimedOperationResults> {
    const results: Partial<TimedOperationResults> = {};
    for (const operation of TIMED_ASYNC_OPERATIONS) {
        Object.assign(results, {
            [operation]: await invokeTimedGroupStateOperation(service, operation)
        });
    }
    return results as TimedOperationResults;
}

export async function invokeTimedGroupStateOperation<Operation extends TimedAsyncOperation>(
    service: GroupStateService,
    operation: Operation
): Promise<TimedOperationResult<Operation>> {
    return await TIMED_OPERATION_INVOCATIONS[operation](service);
}

export function invokeUntimedGroupStateOperations(service: GroupStateService): ReturnType<GroupStateService['compute']> {
    const command = timingCommand;
    const read = {} as never;
    const computed = service.compute(command, read);
    assertTimedGroupStateMutationValid({ service, command, read, computed });
    return computed;
}

interface AssertTimedGroupStateMutationValidInput {
    readonly service: GroupStateService;
    readonly command: Parameters<GroupStateService['compute']>[0];
    readonly read: Parameters<GroupStateService['compute']>[1];
    readonly computed: ReturnType<GroupStateService['compute']>;
}

function assertTimedGroupStateMutationValid(
    input: AssertTimedGroupStateMutationValidInput
): void {
    const issue = input.service.validate(input.command, input.read, input.computed)[0];
    if (issue !== undefined) {
        throw issue.cause;
    }
}

const timingScope = { applicationId: 'timing-app', workspaceId: 'timing-workspace' };
const timingGroupRef = { ...timingScope, groupId: 'timing-group' };
const timingDescriptor = {
    operation: 'updateGroup' as const,
    scope: timingScope,
    groupId: 'timing-group',
    targetPrincipalId: null,
    sessionId: null,
    request: { requestId: 'timing-prepare-request' }
} as never;
const timingCommand = {
    command: {
        requestId: 'timing-read-request',
        aggregateRef: timingGroupRef
    }
} as never;
const timingAuthority = {} as never;
const timingCleanup = {
    scope: timingScope,
    authSession: {} as never,
    principalId: 'cleanup-principal',
    disconnectedAtEpochMs: 1_000
};
const timingSnapshotPageOptions = { limit: 1 };
const timingRecentEventsQuery = { limit: 1 };
const timingEventPageQuery = { limit: 1 };
const timingSnapshot = { marker: 'snapshot' } as never;
const timingTransaction = (() => undefined) as never;
const timingComputed = {} as never;

type TimedOperationArgumentsByOperation = {
    readonly [Operation in TimedAsyncOperation]: TimedOperationArguments<Operation>;
};

export const TIMED_OPERATION_ARGUMENTS: TimedOperationArgumentsByOperation = {
    authorizeMutation: [timingDescriptor, timingAuthority],
    prepareMutation: [timingDescriptor, timingAuthority],
    prepareAppInboxMutation: [timingDescriptor, timingAuthority],
    prepareExpiredPresenceMutations: [1_000],
    prepareSessionCleanupMutations: [timingCleanup],
    prepareFormationCriterionMutation: [{} as never, 1_000],
    prepareFormationAutomationMutation: [{} as never, 1_000],
    prepareTopologyPublicationMutation: [{} as never, 1_000],
    prepareActivationStatusMutation: [{} as never, 1_000],
    listSnapshots: [timingScope],
    listSnapshotsPage: [timingScope, timingSnapshotPageOptions],
    readSnapshot: [timingGroupRef],
    readCausalRevision: [timingGroupRef],
    readIssuedAuthSession: ['timing-session'],
    listEvents: [timingGroupRef],
    listRecentEvents: [timingGroupRef, timingRecentEventsQuery],
    listEventPage: [timingGroupRef, timingEventPageQuery],
    observeSnapshot: [timingSnapshot],
    read: [timingCommand]
};

export const UNTIMED_WRITE_ARGUMENTS: Parameters<GroupStateService['write']> = [
    timingTransaction,
    timingComputed
];

type TimedOperationInvocations = {
    readonly [Operation in TimedAsyncOperation]: (
        service: GroupStateService
    ) => Promise<TimedOperationResult<Operation>>;
};

const TIMED_OPERATION_INVOCATIONS: TimedOperationInvocations = {
    authorizeMutation: async (service) => await service.authorizeMutation(...TIMED_OPERATION_ARGUMENTS.authorizeMutation),
    prepareMutation: async (service) => await service.prepareMutation(...TIMED_OPERATION_ARGUMENTS.prepareMutation),
    prepareAppInboxMutation: async (service) =>
        await service.prepareAppInboxMutation(
            ...TIMED_OPERATION_ARGUMENTS.prepareAppInboxMutation
        ),
    prepareExpiredPresenceMutations: async (service) =>
        await service.prepareExpiredPresenceMutations(
            ...TIMED_OPERATION_ARGUMENTS.prepareExpiredPresenceMutations
        ),
    prepareSessionCleanupMutations: async (service) =>
        await service.prepareSessionCleanupMutations(
            ...TIMED_OPERATION_ARGUMENTS.prepareSessionCleanupMutations
        ),
    prepareFormationCriterionMutation: async (service) =>
        await service.prepareFormationCriterionMutation(
            ...TIMED_OPERATION_ARGUMENTS.prepareFormationCriterionMutation
        ),
    prepareFormationAutomationMutation: async (service) =>
        await service.prepareFormationAutomationMutation(
            ...TIMED_OPERATION_ARGUMENTS.prepareFormationAutomationMutation
        ),
    prepareTopologyPublicationMutation: async (service) =>
        await service.prepareTopologyPublicationMutation(
            ...TIMED_OPERATION_ARGUMENTS.prepareTopologyPublicationMutation
        ),
    prepareActivationStatusMutation: async (service) =>
        await service.prepareActivationStatusMutation(
            ...TIMED_OPERATION_ARGUMENTS.prepareActivationStatusMutation
        ),
    listSnapshots: async (service) => await service.listSnapshots(...TIMED_OPERATION_ARGUMENTS.listSnapshots),
    listSnapshotsPage: async (service) => await service.listSnapshotsPage(...TIMED_OPERATION_ARGUMENTS.listSnapshotsPage),
    readSnapshot: async (service) => await service.readSnapshot(...TIMED_OPERATION_ARGUMENTS.readSnapshot),
    readCausalRevision: async (service) => await service.readCausalRevision(...TIMED_OPERATION_ARGUMENTS.readCausalRevision),
    readIssuedAuthSession: async (service) => await service.readIssuedAuthSession(...TIMED_OPERATION_ARGUMENTS.readIssuedAuthSession),
    listEvents: async (service) => await service.listEvents(...TIMED_OPERATION_ARGUMENTS.listEvents),
    listRecentEvents: async (service) => await service.listRecentEvents!(...TIMED_OPERATION_ARGUMENTS.listRecentEvents),
    listEventPage: async (service) => await service.listEventPage(...TIMED_OPERATION_ARGUMENTS.listEventPage),
    observeSnapshot: async (service) => await service.observeSnapshot(...TIMED_OPERATION_ARGUMENTS.observeSnapshot),
    read: async (service) => await service.read(...TIMED_OPERATION_ARGUMENTS.read)
};

export async function invokeUntimedGroupStateWrite(
    service: GroupStateService
): ReturnType<GroupStateService['write']> {
    return await service.write(...UNTIMED_WRITE_ARGUMENTS);
}

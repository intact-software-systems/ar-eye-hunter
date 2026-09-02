import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';

export type PromiseReturningMethodKey<Service> = {
    [Key in keyof Service]-?: Exclude<Service[Key], undefined> extends (
        ...arguments_: infer Arguments
    ) => infer Result ? Result extends Promise<unknown> ? Key :
        never :
        never;
}[keyof Service];

export type PromiseReturningGroupStateServiceKey = PromiseReturningMethodKey<GroupStateService>;

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
    'readEvent',
    'listEvents',
    'listRecentEvents',
    'listEventPage',
    'observeSnapshot',
    'read',
    'write'
] as const satisfies readonly PromiseReturningGroupStateServiceKey[];

export type TimedAsyncOperation = (typeof TIMED_ASYNC_OPERATIONS)[number];

type MissingTimedAsyncOperation = Exclude<PromiseReturningGroupStateServiceKey, TimedAsyncOperation>;
type ExtraTimedAsyncOperation = Exclude<TimedAsyncOperation, PromiseReturningGroupStateServiceKey>;
type HasExactTimedAsyncOperationCoverage = [
    MissingTimedAsyncOperation | ExtraTimedAsyncOperation
] extends [never] ? true :
    false;

export const TIMED_ASYNC_OPERATION_COVERAGE: HasExactTimedAsyncOperationCoverage = true;

export type TimedOperationArguments<Operation extends TimedAsyncOperation> = Exclude<GroupStateService[Operation], undefined> extends (
    ...arguments_: infer Arguments
) => Promise<unknown> ? Arguments :
    never;

export interface TimedOperationInvocation {
    readonly operation: TimedAsyncOperation;
    readonly arguments: readonly unknown[];
}

type RecordTimedOperation = <Operation extends TimedAsyncOperation>(
    operation: Operation,
    arguments_: TimedOperationArguments<Operation>
) => Promise<unknown>;

export interface GroupStateServiceTimingFake {
    readonly service: GroupStateService;
    readonly calls: readonly string[];
    readonly invocations: readonly TimedOperationInvocation[];
    readonly sentinels: Readonly<Record<TimedAsyncOperation | 'compute', unknown>>;
    readonly rejection: Error;
}

export function createGroupStateServiceTimingFake(
    rejectOperation?: TimedAsyncOperation,
    onCall?: (operation: TimedAsyncOperation) => void
): GroupStateServiceTimingFake {
    const calls: string[] = [];
    const invocations: TimedOperationInvocation[] = [];
    const rejection = new Error(`controlled ${rejectOperation ?? 'unused'} rejection`);
    const sentinels = Object.fromEntries(
        [...TIMED_ASYNC_OPERATIONS, 'compute'].map((operation) => [
            operation,
            Object.freeze({ operation, sentinel: true })
        ])
    ) as Readonly<Record<TimedAsyncOperation | 'compute', unknown>>;
    const record: RecordTimedOperation = async (operation, arguments_) => {
        calls.push(operation);
        invocations.push({ operation, arguments: arguments_ });
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
        authorizeMutation: async (...arguments_) => (await record('authorizeMutation', arguments_)) as never,
        prepareMutation: async (...arguments_) => (await record('prepareMutation', arguments_)) as never,
        prepareAppInboxMutation: async (...arguments_) => (await record('prepareAppInboxMutation', arguments_)) as never,
        prepareExpiredPresenceMutations: async (...arguments_) => (await record('prepareExpiredPresenceMutations', arguments_)) as never,
        prepareFormationCriterionMutation: async (...arguments_) => (await record('prepareFormationCriterionMutation', arguments_)) as never,
        prepareFormationAutomationMutation: async (...arguments_) => (await record('prepareFormationAutomationMutation', arguments_)) as never,
        prepareTopologyPublicationMutation: async (...arguments_) => (await record('prepareTopologyPublicationMutation', arguments_)) as never,
        prepareActivationStatusMutation: async (...arguments_) => (await record('prepareActivationStatusMutation', arguments_)) as never,
        prepareSessionCleanupMutations: async (...arguments_) => (await record('prepareSessionCleanupMutations', arguments_)) as never
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
    | 'readEvent'
    | 'listEvents'
    | 'listRecentEvents'
    | 'listEventPage'
    | 'observeSnapshot'
> {
    return {
        listSnapshots: async (...arguments_) => (await record('listSnapshots', arguments_)) as never,
        listSnapshotsPage: async (...arguments_) => (await record('listSnapshotsPage', arguments_)) as never,
        readSnapshot: async (...arguments_) => (await record('readSnapshot', arguments_)) as never,
        readCausalRevision: async (...arguments_) => (await record('readCausalRevision', arguments_)) as never,
        readIssuedAuthSession: async (...arguments_) => (await record('readIssuedAuthSession', arguments_)) as never,
        readEvent: async (...arguments_) => (await record('readEvent', arguments_)) as never,
        listEvents: async (...arguments_) => (await record('listEvents', arguments_)) as never,
        listRecentEvents: async (...arguments_) => (await record('listRecentEvents', arguments_)) as never,
        listEventPage: async (...arguments_) => (await record('listEventPage', arguments_)) as never,
        observeSnapshot: async (...arguments_) => (await record('observeSnapshot', arguments_)) as never
    };
}

function createMutationFake(
    record: RecordTimedOperation,
    calls: string[],
    computeSentinel: unknown
): Pick<GroupStateService, 'read' | 'compute' | 'validate' | 'write'> {
    return {
        read: async (...arguments_) => (await record('read', arguments_)) as never,
        compute: () => {
            calls.push('compute');
            return computeSentinel as never;
        },
        validate: () => {
            calls.push('validate');
            return [];
        },
        write: async (...arguments_) => (await record('write', arguments_)) as never
    };
}

export async function invokeEveryTimedGroupStateOperation(
    service: GroupStateService
): Promise<Readonly<Record<TimedAsyncOperation, unknown>>> {
    const results: Partial<Record<TimedAsyncOperation, unknown>> = {};
    for (const operation of TIMED_ASYNC_OPERATIONS) {
        results[operation] = await invokeTimedGroupStateOperation(service, operation);
    }
    return results as Readonly<Record<TimedAsyncOperation, unknown>>;
}

export async function invokeTimedGroupStateOperation(
    service: GroupStateService,
    operation: TimedAsyncOperation
): Promise<unknown> {
    return await TIMED_OPERATION_INVOCATIONS[operation](service);
}

export function invokeUntimedGroupStateOperations(service: GroupStateService): unknown {
    const command = timingCommand;
    const read = {} as never;
    const computed = service.compute(command, read);
    const issues = service.validate(command, read, computed);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    return computed;
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
    readEvent: [timingGroupRef, 'timing-event'],
    listEvents: [timingGroupRef],
    listRecentEvents: [timingGroupRef, timingRecentEventsQuery],
    listEventPage: [timingGroupRef, timingEventPageQuery],
    observeSnapshot: [timingSnapshot],
    read: [timingCommand],
    write: [timingTransaction, timingComputed]
};

const TIMED_OPERATION_INVOCATIONS: Readonly<Record<TimedAsyncOperation, (service: GroupStateService) => Promise<unknown>>> = {
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
    readEvent: async (service) => await service.readEvent(...TIMED_OPERATION_ARGUMENTS.readEvent),
    listEvents: async (service) => await service.listEvents(...TIMED_OPERATION_ARGUMENTS.listEvents),
    listRecentEvents: async (service) => await service.listRecentEvents(...TIMED_OPERATION_ARGUMENTS.listRecentEvents),
    listEventPage: async (service) => await service.listEventPage(...TIMED_OPERATION_ARGUMENTS.listEventPage),
    observeSnapshot: async (service) => await service.observeSnapshot(...TIMED_OPERATION_ARGUMENTS.observeSnapshot),
    read: async (service) => await service.read(...TIMED_OPERATION_ARGUMENTS.read),
    write: async (service) => await service.write(...TIMED_OPERATION_ARGUMENTS.write)
};

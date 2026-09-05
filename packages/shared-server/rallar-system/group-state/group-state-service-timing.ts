import type { GroupScope } from '@shared/api/group-types.ts';

import type { RallarTimingEventInput, RallarTimingSink } from '../observability/timing.ts';
import { timeRallarAsync } from '../observability/timing.ts';
import type { GroupStateMutationCommand, GroupStateService } from './group-state-service-contracts.ts';

export interface CreateTimedGroupStateServiceInput {
    readonly service: GroupStateService;
    readonly timing: RallarTimingSink | undefined;
    readonly serviceId: string;
}

interface GroupStateTimingDetails {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly groupId?: string;
    readonly principalId?: string;
    readonly actorPrincipalId?: string;
    readonly createdByPrincipalId?: string;
    readonly requestId?: string;
    readonly sessionId?: string;
}

type GroupStateTimedOperation = Exclude<keyof GroupStateService, 'compute' | 'validate' | 'sessionGenerationLifecycle'>;

interface TimeGroupStateOperationInput<T> {
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
    readonly operation: GroupStateTimedOperation;
    readonly details: GroupStateTimingDetails;
    readonly action: () => Promise<T>;
}

export function createTimedGroupStateService(
    input: CreateTimedGroupStateServiceInput
): GroupStateService {
    const { service, timing } = input;
    if (!timing) {
        return service;
    }

    const timedInput = { timing, serviceId: input.serviceId };
    return {
        sessionGenerationLifecycle: service.sessionGenerationLifecycle,
        ...createTimedIngressCaptureOperations(service, timedInput),
        ...createTimedSnapshotOperations(service, timedInput),
        ...createTimedEventOperations(service, timedInput),
        ...createTimedObservationOperations(service, timedInput),
        ...createTimedMutationOperations(service, timedInput)
    };
}

interface TimedGroupStateServiceInput {
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
}

type InternalCommandIngressCapture =
    | 'captureFormationCriterionMutationIngress'
    | 'captureFormationAutomationMutationIngress'
    | 'captureTopologyPublicationMutationIngress'
    | 'captureActivationStatusMutationIngress';

// The four internal ingress captures share one signature, so one factory
// times them all; the operation string doubles as the method name, which
// keeps the timing label and the forwarded call from drifting apart.
function createTimedInternalCommandIngressCapture(
    service: GroupStateService,
    input: TimedGroupStateServiceInput,
    operation: InternalCommandIngressCapture
): GroupStateService[InternalCommandIngressCapture] {
    return async (command, atEpochMs) =>
        await timeGroupStateOperation({
            ...input,
            operation,
            details: {},
            action: async () => await service[operation](command, atEpochMs)
        });
}

function createTimedIngressCaptureOperations(
    service: GroupStateService,
    input: TimedGroupStateServiceInput
): Pick<
    GroupStateService,
    | 'authorizeMutation'
    | 'captureMutationIngress'
    | 'captureAppInboxMutationIngress'
    | InternalCommandIngressCapture
    | 'captureExpiredPresenceMutationIngresses'
    | 'captureSessionCleanupMutationIngresses'
> {
    const timedCommand = (operation: InternalCommandIngressCapture) =>
        createTimedInternalCommandIngressCapture(service, input, operation);
    return {
        authorizeMutation: async (descriptor, authority) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'authorizeMutation',
                details: {},
                action: async () => await service.authorizeMutation(descriptor, authority)
            }),
        captureMutationIngress: async (descriptor, authority) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'captureMutationIngress',
                details: {},
                action: async () => await service.captureMutationIngress(descriptor, authority)
            }),
        captureAppInboxMutationIngress: async (descriptor, authority) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'captureAppInboxMutationIngress',
                details: {},
                action: async () => await service.captureAppInboxMutationIngress(descriptor, authority)
            }),
        captureFormationCriterionMutationIngress: timedCommand('captureFormationCriterionMutationIngress'),
        captureFormationAutomationMutationIngress: timedCommand('captureFormationAutomationMutationIngress'),
        captureTopologyPublicationMutationIngress: timedCommand('captureTopologyPublicationMutationIngress'),
        captureActivationStatusMutationIngress: timedCommand('captureActivationStatusMutationIngress'),
        captureExpiredPresenceMutationIngresses: async (atEpochMs) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'captureExpiredPresenceMutationIngresses',
                details: {},
                action: async () => await service.captureExpiredPresenceMutationIngresses(atEpochMs)
            }),
        captureSessionCleanupMutationIngresses: async (cleanup) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'captureSessionCleanupMutationIngresses',
                details: { principalId: cleanup.principalId },
                action: async () => await service.captureSessionCleanupMutationIngresses(cleanup)
            })
    };
}

function createTimedSnapshotOperations(
    service: GroupStateService,
    input: TimedGroupStateServiceInput
): Pick<
    GroupStateService,
    | 'listSnapshots'
    | 'listSnapshotsPage'
    | 'readSnapshot'
    | 'readCausalRevision'
> {
    return {
        listSnapshots: async (scope) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'listSnapshots',
                details: toScopeTimingDetails(scope),
                action: async () => await service.listSnapshots(scope)
            }),
        listSnapshotsPage: async (scope, options) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'listSnapshotsPage',
                details: toScopeTimingDetails(scope),
                action: async () => await service.listSnapshotsPage(scope, options)
            }),
        readSnapshot: async (ref) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'readSnapshot',
                details: toScopeTimingDetails(ref),
                action: async () => await service.readSnapshot(ref)
            }),
        readCausalRevision: async (ref) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'readCausalRevision',
                details: toScopeTimingDetails(ref),
                action: async () => await service.readCausalRevision(ref)
            })
    };
}

function createTimedEventOperations(
    service: GroupStateService,
    input: TimedGroupStateServiceInput
): Pick<GroupStateService, 'listEvents' | 'listRecentEvents' | 'listEventPage'> {
    return {
        listEvents: async (ref) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'listEvents',
                details: toScopeTimingDetails(ref),
                action: async () => await service.listEvents(ref)
            }),
        listRecentEvents: async (ref, query) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'listRecentEvents',
                details: toScopeTimingDetails(ref),
                action: async () => await service.listRecentEvents(ref, query)
            }),
        listEventPage: async (ref, query) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'listEventPage',
                details: toScopeTimingDetails(ref),
                action: async () => await service.listEventPage(ref, query)
            })
    };
}

function createTimedObservationOperations(
    service: GroupStateService,
    input: TimedGroupStateServiceInput
): Pick<GroupStateService, 'readIssuedAuthSession' | 'observeSnapshot'> {
    return {
        readIssuedAuthSession: async (sessionId) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'readIssuedAuthSession',
                details: {},
                action: async () => await service.readIssuedAuthSession(sessionId)
            }),
        observeSnapshot: async (snapshot) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'observeSnapshot',
                details: {},
                action: async () => await service.observeSnapshot(snapshot)
            })
    };
}

function createTimedMutationOperations(
    service: GroupStateService,
    input: TimedGroupStateServiceInput
): Pick<GroupStateService, 'read' | 'compute' | 'validate' | 'write'> {
    return {
        read: async (command) =>
            await timeGroupStateOperation({
                ...input,
                operation: 'read',
                details: toMutationTimingDetails(command),
                action: async () => await service.read(command)
            }),
        compute: service.compute,
        validate: service.validate,
        write: async (transaction, computed) => await service.write(transaction, computed)
    };
}

async function timeGroupStateOperation<T>(input: TimeGroupStateOperationInput<T>): Promise<T> {
    return await timeRallarAsync(
        input.timing,
        toGroupStateTimingEventInput(input.serviceId, input.operation, input.details),
        input.action
    );
}

function toScopeTimingDetails(scope: GroupScope): GroupStateTimingDetails {
    return { applicationId: scope.applicationId, workspaceId: scope.workspaceId };
}

function toMutationTimingDetails(command: GroupStateMutationCommand): GroupStateTimingDetails {
    return {
        requestId: command.command.requestId ?? undefined,
        applicationId: command.command.aggregateRef.applicationId,
        workspaceId: command.command.aggregateRef.workspaceId,
        groupId: command.command.aggregateRef.groupId
    };
}

function toGroupStateTimingEventInput(
    serviceId: string,
    operation: GroupStateTimedOperation,
    details: GroupStateTimingDetails
): RallarTimingEventInput {
    return {
        component: 'group-state-service',
        operation,
        serviceId,
        requestId: typeof details.requestId === 'string' ? details.requestId : undefined,
        applicationId: typeof details.applicationId === 'string' ? details.applicationId : undefined,
        workspaceId: typeof details.workspaceId === 'string' ? details.workspaceId : undefined,
        groupId: typeof details.groupId === 'string' ? details.groupId : undefined,
        principalId: typeof details.principalId === 'string'
            ? details.principalId
            : typeof details.actorPrincipalId === 'string'
            ? details.actorPrincipalId
            : typeof details.createdByPrincipalId === 'string'
            ? details.createdByPrincipalId
            : undefined,
        sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined
    };
}

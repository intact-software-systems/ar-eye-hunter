import {
    nowMs,
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingEventInput,
    type RallarTimingSink
} from '../observability/timing.ts';
import type { ClientStateService } from './client-state-service-contracts.ts';
import type { ClientMutationCommand } from './mutation/client-mutation-contracts.ts';

type ClientStateServiceOperation = 'mutation.read' | 'mutation.compute' | 'mutation.validate' | 'mutation.write';

interface CreateTimedClientStateServiceInput {
    readonly service: ClientStateService;
    readonly timing: RallarTimingSink | undefined;
    readonly serviceId: string;
}

export function createTimedClientStateService(
    input: CreateTimedClientStateServiceInput
): ClientStateService {
    if (!input.timing) {
        return input.service;
    }
    return {
        ...input.service,
        read: (command) => timeClientMutationRead(input, command, () => input.service.read(command)),
        compute: (command, read) =>
            timeClientMutationCompute(input, command, () => input.service.compute(command, read)),
        validate: (command, read, computed) =>
            timeClientMutationValidate(input, command, () => input.service.validate(command, read, computed)),
        write: (transaction, computed) =>
            timeClientMutationWrite(input, computed, () => input.service.write(transaction, computed))
    };
}

export type ClientStateServiceTimingFactory = typeof createTimedClientStateService;

function timeClientMutationRead<T>(
    input: CreateTimedClientStateServiceInput,
    command: ClientMutationCommand,
    action: () => Promise<T>
): Promise<T> {
    return timeRallarAsync(
        input.timing,
        {
            component: 'client-state-service',
            operation: 'mutation.read',
            serviceId: input.serviceId,
            requestId: command.requestId ?? undefined,
            ...command.aggregateRef
        },
        action
    );
}

function timeClientMutationCompute<T>(
    input: CreateTimedClientStateServiceInput,
    command: ClientMutationCommand,
    action: () => T
): T {
    const startedAtEpochMs = nowMs();
    try {
        const result = action();
        recordRallarTiming({
            sink: input.timing,
            event: toMutationTiming('mutation.compute', command, input.serviceId),
            status: 'ok',
            durationMs: nowMs() - startedAtEpochMs
        });
        return result;
    }
    catch (error) {
        recordRallarTiming({
            sink: input.timing,
            event: toMutationTiming('mutation.compute', command, input.serviceId),
            status: 'error',
            durationMs: nowMs() - startedAtEpochMs,
            error
        });
        throw error;
    }
}

function timeClientMutationValidate<T>(
    input: CreateTimedClientStateServiceInput,
    command: ClientMutationCommand,
    action: () => T
): T {
    const startedAtEpochMs = nowMs();
    try {
        const result = action();
        recordRallarTiming({
            sink: input.timing,
            event: toMutationTiming('mutation.validate', command, input.serviceId),
            status: 'ok',
            durationMs: nowMs() - startedAtEpochMs
        });
        return result;
    }
    catch (error) {
        recordRallarTiming({
            sink: input.timing,
            event: toMutationTiming('mutation.validate', command, input.serviceId),
            status: 'error',
            durationMs: nowMs() - startedAtEpochMs,
            error
        });
        throw error;
    }
}

function timeClientMutationWrite<T>(
    input: CreateTimedClientStateServiceInput,
    computed: Parameters<ClientStateService['write']>[1],
    action: () => Promise<T>
): Promise<T> {
    return timeRallarAsync(
        input.timing,
        {
            component: 'client-state-service',
            operation: 'mutation.write',
            serviceId: input.serviceId,
            requestId: computed.receipt.requestId ?? undefined,
            ...computed.receipt.aggregateRef
        },
        action
    );
}

function toMutationTiming(
    operation: ClientStateServiceOperation,
    command: ClientMutationCommand,
    serviceId: string
): RallarTimingEventInput {
    return {
        component: 'client-state-service',
        operation,
        serviceId,
        requestId: command.requestId ?? undefined,
        ...command.aggregateRef,
        details: {
            attempt: command.facts.attemptCount,
            mutationOperation: command.operation
        }
    };
}

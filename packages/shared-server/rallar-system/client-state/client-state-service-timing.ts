import {
    nowMs,
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingEventInput,
    type RallarTimingSink,
    type RecordRallarTimingInput
} from '../observability/timing.ts';
import type { ClientStateService } from './client-state-service-contracts.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputedWrite
} from './mutation/client-mutation-contracts.ts';

type ClientStatePurePhase = 'mutation.compute' | 'mutation.validate';

export interface ClientStateMutationTiming {
    readonly sink: RallarTimingSink | undefined;
    readonly serviceId: string;
}

interface ClientStatePhaseTimingInput {
    readonly timing: ClientStateMutationTiming;
    readonly operation: ClientStatePurePhase;
    readonly command: ClientMutationCommand | undefined;
}

interface ClientStateMutationCommitTimingInput {
    readonly timing: ClientStateMutationTiming;
    readonly writes: readonly ClientMutationComputedWrite[];
}

interface RecordClientStateMutationCommitInput extends ClientStateMutationCommitTimingInput {
    readonly status: 'ok' | 'error';
    readonly durationMs: number;
    readonly error?: RecordRallarTimingInput['error'];
}

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
        mutationTiming: { sink: input.timing, serviceId: input.serviceId },
        read: (command) => timeClientMutationRead(input, command, () => input.service.read(command))
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

export function timeClientStateInboxPhase<T>(
    input: ClientStatePhaseTimingInput,
    action: () => T
): T {
    if (!input.timing.sink || !input.command) {
        return action();
    }
    const startedAtEpochMs = nowMs();
    try {
        const result = action();
        recordRallarTiming({
            sink: input.timing.sink,
            event: toMutationTiming(input.operation, input.command, input.timing.serviceId),
            status: 'ok',
            durationMs: nowMs() - startedAtEpochMs
        });
        return result;
    }
    catch (error) {
        recordRallarTiming({
            sink: input.timing.sink,
            event: toMutationTiming(input.operation, input.command, input.timing.serviceId),
            status: 'error',
            durationMs: nowMs() - startedAtEpochMs,
            error
        });
        throw error;
    }
}

export async function timeClientStateMutationCommit<T>(
    input: ClientStateMutationCommitTimingInput,
    action: () => Promise<T>
): Promise<T> {
    if (!input.timing.sink || input.writes.length === 0) {
        return await action();
    }
    const startedAtEpochMs = nowMs();
    try {
        const result = await action();
        recordClientStateMutationCommit({
            ...input,
            status: 'ok',
            durationMs: nowMs() - startedAtEpochMs
        });
        return result;
    }
    catch (error) {
        recordClientStateMutationCommit({
            ...input,
            status: 'error',
            durationMs: nowMs() - startedAtEpochMs,
            error
        });
        throw error;
    }
}

function recordClientStateMutationCommit(input: RecordClientStateMutationCommitInput): void {
    for (const write of input.writes) {
        recordRallarTiming({
            sink: input.timing.sink,
            event: {
                component: 'client-state-service',
                operation: 'mutation.write',
                serviceId: input.timing.serviceId,
                requestId: write.receipt.requestId ?? undefined,
                ...write.receipt.aggregateRef
            },
            status: input.status,
            durationMs: input.durationMs,
            error: input.error
        });
    }
}

function toMutationTiming(
    operation: ClientStatePurePhase,
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

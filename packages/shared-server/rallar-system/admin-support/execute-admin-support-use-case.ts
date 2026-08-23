import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support-types.ts';
import {
    nowMs,
    recordRallarTiming,
    type RallarTimingDetails,
    type RallarTimingEventInput
} from '../observability/timing.ts';
import type { AdminSupportExecutionDependencies, AdminSupportWriteInput } from './admin-support-contracts.ts';

export async function executeAdminSupportUseCase<T extends AdminSupportNarrativeResponse>(
    dependencies: AdminSupportExecutionDependencies,
    operation: string,
    input: AdminSupportWriteInput<unknown>,
    action: () => Promise<T>
): Promise<T> {
    const timingInput = createTimingInput(dependencies, operation, input);
    const startedAt = nowMs();
    try {
        const result = await action();
        recordRallarTiming({
            sink: dependencies.timing,
            event: {
                ...timingInput,
                details: {
                    ...timingInput.details,
                    warningCount: result.warnings.length,
                    factCount: result.facts.length
                }
            },
            status: 'ok',
            durationMs: nowMs() - startedAt
        });
        return result;
    }
    catch (error) {
        recordRallarTiming({
            sink: dependencies.timing,
            event: timingInput,
            status: 'error',
            durationMs: nowMs() - startedAt,
            error
        });
        throw error;
    }
}

function createTimingInput(
    dependencies: AdminSupportExecutionDependencies,
    operation: string,
    input: AdminSupportWriteInput<unknown>
): RallarTimingEventInput {
    const request = readObject(input.request);
    const queueKey = readRecord(request.queueKey);
    return {
        component: 'admin-support',
        operation,
        serviceId: dependencies.serverId,
        requestId: readTimingString(request.requestId),
        principalId: input.adminSession.clientId,
        sessionId: input.adminSession.sessionId,
        details: compactTimingDetails({
            adminClientId: input.adminSession.clientId,
            queueTopicId: readTimingString(queueKey?.topicId),
            queueResourceId: readTimingString(queueKey?.resourceId),
            queueContextId: readTimingString(queueKey?.contextId)
        })
    };
}

function readObject(input: unknown): Record<string, unknown> {
    return readRecord(input) ?? {};
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
    return typeof input === 'object' && input !== null ? input as Record<string, unknown> : undefined;
}

function readTimingString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function compactTimingDetails(details: RallarTimingDetails): RallarTimingDetails {
    return Object.fromEntries(
        Object.entries(details).filter(([, value]) => value !== undefined)
    );
}

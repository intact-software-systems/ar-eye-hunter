import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support/admin-support-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import { nowMs, recordRallarTiming, type RallarTimingEventInput } from '../observability/timing.ts';
import type { AdminSupportExecutionDependencies } from './admin-support-contracts.ts';

type AdminSupportOperation =
    | 'explain.client'
    | 'explain.group'
    | 'explain.request'
    | 'explain.crdt-document'
    | 'explain.queue-item';

interface AdminSupportTimingDimensions {
    readonly requestId?: string;
    readonly queueKey?: Key;
}

interface ReadTimedAdminSupportNarrativeInput {
    readonly dependencies: AdminSupportExecutionDependencies;
    readonly operation: AdminSupportOperation;
    readonly adminSession: AuthSession;
    readonly timing: AdminSupportTimingDimensions;
    readonly readNarrative: () => Promise<AdminSupportNarrativeResponse>;
}

export async function readTimedAdminSupportNarrative(
    input: ReadTimedAdminSupportNarrativeInput
): Promise<AdminSupportNarrativeResponse> {
    const timingEvent = toAdminSupportTimingEvent(input);
    const startedAt = nowMs();
    try {
        const narrative = await input.readNarrative();
        recordRallarTiming({
            sink: input.dependencies.timing,
            event: {
                ...timingEvent,
                details: {
                    ...timingEvent.details,
                    warningCount: narrative.warnings.length,
                    factCount: narrative.facts.length
                }
            },
            status: 'ok',
            durationMs: nowMs() - startedAt
        });
        return narrative;
    }
    catch (error) {
        recordRallarTiming({
            sink: input.dependencies.timing,
            event: timingEvent,
            status: 'error',
            durationMs: nowMs() - startedAt,
            error
        });
        throw error;
    }
}

function toAdminSupportTimingEvent(
    input: ReadTimedAdminSupportNarrativeInput
): RallarTimingEventInput {
    const queueKey = input.timing.queueKey;
    return {
        component: 'admin-support',
        operation: input.operation,
        serviceId: input.dependencies.serverId,
        requestId: input.timing.requestId,
        principalId: input.adminSession.clientId,
        sessionId: input.adminSession.sessionId,
        details: {
            adminClientId: input.adminSession.clientId,
            ...(queueKey
                ? {
                    queueTopicId: queueKey.topicId,
                    queueResourceId: queueKey.resourceId,
                    queueContextId: queueKey.contextId
                }
                : {})
        }
    };
}

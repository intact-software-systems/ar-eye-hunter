import type {
    AdminSupportExplainQueueItemRequest,
    AdminSupportExplainRequestRequest,
    AdminSupportNarrativeResponse
} from '@shared/api/admin-support-types.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import type { AdminSupportWriteInput, QueueAdminSupportDependencies } from './admin-support-contracts.ts';
import { executeAdminSupportUseCase } from './execute-admin-support-use-case.ts';
import {
    projectQueueAdminSupportNarrative,
    projectRequestAdminSupportNarrative
} from './narratives/queue-admin-support-narrative.ts';

export class QueueAdminSupport {
    private readonly dependencies: QueueAdminSupportDependencies;

    public constructor(dependencies: QueueAdminSupportDependencies) {
        this.dependencies = dependencies;
    }

    public async explainRequest(
        input: AdminSupportWriteInput<AdminSupportExplainRequestRequest>
    ): Promise<AdminSupportNarrativeResponse> {
        return await executeAdminSupportUseCase(
            this.dependencies,
            'explain.request',
            input,
            async () => {
                const queueNarrative = input.request.queueKey
                    ? await this.explainQueueItem({
                        adminSession: input.adminSession,
                        request: {
                            queueKey: input.request.queueKey,
                            includeExpired: true
                        }
                    })
                    : undefined;
                return projectRequestAdminSupportNarrative(
                    this.narrativeBase(),
                    input.request,
                    queueNarrative
                );
            }
        );
    }

    public async explainQueueItem(
        input: AdminSupportWriteInput<AdminSupportExplainQueueItemRequest>
    ): Promise<AdminSupportNarrativeResponse> {
        return await executeAdminSupportUseCase(
            this.dependencies,
            'explain.queue-item',
            input,
            async () => {
                const queueKey = requireQueueKey(input.request.queueKey);
                const includeExpired = input.request.includeExpired === true;
                const [inbox, result] = await Promise.all([
                    this.dependencies.reader.readQueueEntry(queueKey, includeExpired),
                    this.dependencies.reader.readQueueResult(queueKey, includeExpired)
                ]);
                return projectQueueAdminSupportNarrative({
                    ...this.narrativeBase(),
                    queueKey,
                    inbox,
                    result
                });
            }
        );
    }

    private narrativeBase() {
        return {
            generatedAtEpochMs: this.dependencies.now(),
            serverId: this.dependencies.serverId
        };
    }
}

function requireQueueKey(value: Key | undefined): Key {
    if (!value || !value.topicId || !value.resourceId || !value.contextId) {
        throw new Error('Admin support queue explanation requires queueKey.');
    }
    return value;
}

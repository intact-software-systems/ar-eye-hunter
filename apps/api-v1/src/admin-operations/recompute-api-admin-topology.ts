import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import {
    toTopologyAppInboxCommand,
    toTopologyHttpMutationSemanticHash
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import type { TopologyReconfigureInboxResult } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';
import type { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import type { AdminTopologyRecomputeRequest } from '@shared/api/admin-operations-types.ts';

export namespace RecomputeApiAdminTopology {
    export interface Input {
        readonly adminSession: IssuedAuthSession;
        readonly requestId: string;
        readonly request: AdminTopologyRecomputeRequest;
    }

    export interface Options {
        readonly topologyInbox: Pick<TopologyInboxService, 'processAuthenticatedHttpEntryUntilCompletionResult'>;
        readonly nowEpochMs: () => number;
    }
}

export class RecomputeApiAdminTopology {
    private readonly options: RecomputeApiAdminTopology.Options;

    constructor(options: RecomputeApiAdminTopology.Options) {
        this.options = options;
    }

    async execute(
        input: RecomputeApiAdminTopology.Input
    ): Promise<TopologyReconfigureInboxResult> {
        const requestPayload = {
            operation: 'reconfigureTopology' as const,
            requestOptions: input.request.options ?? {},
            publish: input.request.publish ?? true
        };
        const semanticHash = await toTopologyHttpMutationSemanticHash({
            principalId: input.adminSession.clientId,
            groupRef: input.request.groupRef,
            requestId: input.requestId,
            payload: requestPayload
        });
        const result = await this.options.topologyInbox
            .processAuthenticatedHttpEntryUntilCompletionResult(
                {
                    operation: requestPayload.operation,
                    requestId: input.requestId,
                    callerId: input.adminSession.clientId,
                    groupRef: input.request.groupRef,
                    semanticHash,
                    materialize: async () =>
                        await toTopologyAppInboxCommand({
                            actor: {
                                principalId: input.adminSession.clientId,
                                sessionId: input.adminSession.sessionId
                            },
                            groupRef: input.request.groupRef,
                            requestId: input.requestId,
                            capturedAtEpochMs: this.options.nowEpochMs(),
                            payload: requestPayload
                        })
                },
                input.adminSession
            );
        if (result.right !== undefined) {
            return requireTopologyReconfigureResult(result.right);
        }
        if (result.left !== undefined) {
            throw Object.assign(new Error(result.left.message), result.left);
        }
        throw new Error('Admin topology AppInbox processing failed');
    }
}

function requireTopologyReconfigureResult(
    result: Awaited<
        ReturnType<
            RecomputeApiAdminTopology.Options['topologyInbox'][
                'processAuthenticatedHttpEntryUntilCompletionResult'
            ]
        >
    >['right']
): TopologyReconfigureInboxResult {
    if (result === undefined || !('status' in result) || result.status !== 'queued') {
        throw new TypeError('Admin topology reconfigure result is invalid');
    }
    return result;
}

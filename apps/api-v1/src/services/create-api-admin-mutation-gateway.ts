import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
  toTopologyAppInboxCommand,
  type AppGroupInboxService,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import type { AppAdminInboxService } from '@shared-server/rallar-system/services/AppAdminInboxService.ts';
import type { AppCrdtInboxService } from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';
import type {
  AdminOperationsMutationGateway,
} from '@shared-server/rallar-system/admin-operations/admin-operations-mutation-gateway.ts';

export function createApiAdminMutationGateway(input: Readonly<{
  appAdmin: AppAdminInboxService;
  appCrdt: AppCrdtInboxService;
  appGroup: AppGroupInboxService;
  now: () => number;
}>): AdminOperationsMutationGateway {
  return {
    recomputeTopology: async ({ adminSession, request }) => {
      if (!request.groupRef) throw new TypeError('Admin topology recompute requires groupRef');
      const command = await toTopologyAppInboxCommand({
        actor: { principalId: adminSession.clientId, sessionId: adminSession.sessionId },
        groupRef: request.groupRef,
        requestId: request.requestId ?? crypto.randomUUID(),
        capturedAtEpochMs: input.now(),
        payload: {
          operation: 'reconfigureTopology',
          requestOptions: request.options ?? {},
          publish: request.publish ?? true,
        },
      });
      const result = await input.appGroup.processAuthenticatedEntryUntilCompletionResult({
        type: AppInboxType.TOPOLOGY_RECONFIGURE,
        resourceId: command.requestId,
        contextId: [command.groupRef.applicationId, command.groupRef.workspaceId, command.groupRef.groupId]
          .map(encodeURIComponent).join(':'),
        senderId: command.actor.principalId,
        data: command,
      }, adminSession as never);
      if (result.right !== undefined) return result.right;
      throw new Error(result.left?.message ?? 'Admin topology AppInbox processing failed');
    },
    pruneExpired: async (request) => {
      const result = await input.appAdmin.pruneExpired(request);
      if (result.right !== undefined) return result.right;
      throw new Error(result.left?.message ?? 'Admin prune AppInbox processing failed');
    },
    compactCrdt: async (request) =>
      await input.appCrdt.processAdminMutationUntilCompletion('compact', request),
    updateCrdtLifecycle: async (request) =>
      await input.appCrdt.processAdminMutationUntilCompletion('lifecycle', request),
    eraseCrdt: async (request) =>
      await input.appCrdt.processAdminMutationUntilCompletion('erase', request),
  };
}

import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  AdminOperationsMutationGateway,
} from '@shared-server/rallar-system/admin-operations/admin-operations-mutation-gateway.ts';
// prettier-ignore
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/\
auth-session-repository.ts';
import type { AppAdminInboxService } from '@shared-server/rallar-system/services/AppAdminInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
  type AppGroupInboxService,
  toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import type { CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';

export interface CreateApiAdminMutationGatewayInput {
  readonly appAdmin: AppAdminInboxService;
  readonly crdtAdminMutations: CrdtAdminMutations;
  readonly appGroup: AppGroupInboxService;
  readonly now: () => number;
}

export function createApiAdminMutationGateway(
  input: CreateApiAdminMutationGatewayInput,
): AdminOperationsMutationGateway {
  return {
    recomputeTopology: async ({ adminSession, request }) => {
      if (!request.groupRef) {
        throw new TypeError('Admin topology recompute requires groupRef');
      }
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
        contextId: [
          command.groupRef.applicationId,
          command.groupRef.workspaceId,
          command.groupRef.groupId,
        ]
          .map(encodeURIComponent).join(':'),
        senderId: command.actor.principalId,
        data: command,
      }, toIssuedAuthSession(adminSession, input.now()));
      if (result.right !== undefined) {
        return result.right;
      }
      throw new Error(result.left?.message ?? 'Admin topology AppInbox processing failed');
    },
    pruneExpired: async (request) => {
      const result = await input.appAdmin.pruneExpired(request);
      if (result.right !== undefined) {
        return result.right;
      }
      if (result.left !== undefined) {
        throw Object.assign(new Error(result.left.message), {
          code: result.left.code,
          status: result.left.status,
          failure: result.left,
        });
      }
      throw new Error('Admin prune AppInbox processing failed');
    },
    compactCrdt: async (request) =>
      await input.crdtAdminMutations.writeCrdtAdminMutation({
        operation: 'compact',
        adminSession: request.adminSession,
        request: request.request,
      }),
    updateCrdtLifecycle: async (request) =>
      await input.crdtAdminMutations.writeCrdtAdminMutation({
        operation: 'lifecycle',
        adminSession: request.adminSession,
        request: request.request,
      }),
    eraseCrdt: async (request) =>
      await input.crdtAdminMutations.writeCrdtAdminMutation({
        operation: 'erase',
        adminSession: request.adminSession,
        request: request.request,
      }),
  };
}

function toIssuedAuthSession(session: AuthSession, issuedAtEpochMs: number): IssuedAuthSession {
  return { ...session, issuedAtEpochMs };
}

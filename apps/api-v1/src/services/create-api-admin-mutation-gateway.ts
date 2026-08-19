import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarCrdtDocumentMetadata } from '@shared/crdt/mod.ts';
import type {
  AdminOperationsMutationGateway,
} from '@shared-server/rallar-system/admin-operations/admin-operations-mutation-gateway.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/\
auth-session-repository.ts';
import type { AppAdminInboxService } from '@shared-server/rallar-system/admin-operations/inbox/\
app-admin-inbox-service.ts';
import type {
  CrdtAdminCompactResult,
  CrdtAdminEraseResult,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
  type AppGroupInboxService,
  decodeTopologyReconfigureInboxResult,
  type TopologyReconfigureInboxResult,
  toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';

import type {
  CrdtAdminMutations,
  CrdtAdminPublicResult,
} from '../crdt/create-crdt-admin-mutations.ts';

export interface ApiAdminPruneMutationPort {
  readonly pruneExpired: AppAdminInboxService['pruneExpired'];
}

export interface ApiTopologyRecomputeMutationPort {
  readonly processAuthenticatedEntryUntilCompletionResult:
    AppGroupInboxService['processAuthenticatedEntryUntilCompletionResult'];
}

export interface CreateApiAdminMutationGatewayInput {
  readonly appAdmin: ApiAdminPruneMutationPort;
  readonly crdtAdminMutations: CrdtAdminMutations;
  readonly appGroup: ApiTopologyRecomputeMutationPort;
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
      const result = await input.appGroup.processAuthenticatedEntryUntilCompletionResult<
        typeof command,
        TopologyReconfigureInboxResult
      >(
        {
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
        },
        toIssuedAuthSession(adminSession, input.now()),
        decodeTopologyReconfigureInboxResult,
      );
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
      requireCrdtCompactResult(
        await input.crdtAdminMutations.writeCrdtAdminMutation({
          operation: 'compact',
          adminSession: request.adminSession,
          request: request.request,
        }),
      ),
    updateCrdtLifecycle: async (request) =>
      requireCrdtLifecycleResult(
        await input.crdtAdminMutations.writeCrdtAdminMutation({
          operation: 'lifecycle',
          adminSession: request.adminSession,
          request: request.request,
        }),
      ),
    eraseCrdt: async (request) =>
      requireCrdtEraseResult(
        await input.crdtAdminMutations.writeCrdtAdminMutation({
          operation: 'erase',
          adminSession: request.adminSession,
          request: request.request,
        }),
      ),
  };
}

function toIssuedAuthSession(session: AuthSession, issuedAtEpochMs: number): IssuedAuthSession {
  return { ...session, issuedAtEpochMs };
}

function requireCrdtCompactResult(result: CrdtAdminPublicResult): CrdtAdminCompactResult {
  if ('snapshot' in result) return result;
  throw new TypeError('CRDT compact mutation returned a different operation result');
}

function requireCrdtLifecycleResult(result: CrdtAdminPublicResult): RallarCrdtDocumentMetadata {
  if ('lifecycle' in result) return result;
  throw new TypeError('CRDT lifecycle mutation returned a different operation result');
}

function requireCrdtEraseResult(result: CrdtAdminPublicResult): CrdtAdminEraseResult {
  if ('request' in result) return result;
  throw new TypeError('CRDT erase mutation returned a different operation result');
}

import { describe, expect, it, vi } from 'vitest';

import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { authSessionProofSecret } from '@shared-server/rallar-system/auth/sessions/auth-session-proof-secret.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import {
  type AppInboxMessageContext,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { createAuthenticatedTopologyEnqueue } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { TopologyAppInboxHandler } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';

const NOW_EPOCH_MS = 1_000;
const SESSION: IssuedAuthSession = {
  clientId: 'owner',
  username: 'owner',
  sessionId: 'owner-session',
  accessToken: 'owner-token',
  issuedAtEpochMs: 500,
  expiresAtEpochMs: 2_000,
};

describe('TopologyAppInboxHandler', () => {
  it('keeps verification and read-compute-validate-write phases ordered and wakes after commit', async () => {
    const phases: string[] = [];
    const context = await topologyContext(phases);
    const computed = { outcome: 'write' } as never;
    const expected = { status: 'accepted', requestId: 'handler-request' } as never;
    const management = {
      prepareTopologyConfigMutation: vi.fn(async () => {
        phases.push('prepare');
        return { command: { operation: 'putConfig' } } as never;
      }),
      readTopologyConfigMutation: vi.fn(async () => {
        phases.push('read');
        return {} as never;
      }),
      computeTopologyConfigMutation: vi.fn(() => {
        phases.push('compute');
        return computed;
      }),
      validateTopologyConfigMutation: vi.fn(() => {
        phases.push('validate');
      }),
      writeTopologyConfigMutation: vi.fn(async () => {
        phases.push('write');
      }),
      toTopologyConfigMutationResult: vi.fn(() => {
        phases.push('result');
        return expected;
      }),
    } as unknown as GroupTopologyManagementService;
    const wakeQueue = vi.fn(() => phases.push('wake'));
    const handler = new TopologyAppInboxHandler({
      groupStateService: sessionReader(phases),
      nowEpochMs: () => NOW_EPOCH_MS,
      wakeQueue,
      writeMutation: async (_context, write) => {
        phases.push('transaction');
        const result = await write(undefined as never);
        phases.push('commit');
        return result;
      },
    });

    await expect(handler.processMutation(context, management)).resolves.toBe(expected);
    expect(phases).toEqual([
      'verify-authority',
      'prepare',
      'read',
      'compute',
      'validate',
      'transaction',
      'write',
      'result',
      'commit',
      'wake',
    ]);
    expect(wakeQueue).toHaveBeenCalledOnce();
  });

  it('rejects an idempotency conflict before opening a transaction or waking the queue', async () => {
    const phases: string[] = [];
    const context = await topologyContext(phases);
    const writeMutation = vi.fn();
    const wakeQueue = vi.fn();
    const management = {
      prepareTopologyConfigMutation: vi.fn(async () => ({ command: {} })),
      readTopologyConfigMutation: vi.fn(async () => ({})),
      computeTopologyConfigMutation: vi.fn(() => ({
        outcome: 'idempotency-conflict',
        existingCommandHash: 'sha256:existing',
        receivedCommandHash: 'sha256:received',
      })),
      validateTopologyConfigMutation: vi.fn(),
    } as unknown as GroupTopologyManagementService;
    const handler = new TopologyAppInboxHandler({
      groupStateService: sessionReader(phases),
      nowEpochMs: () => NOW_EPOCH_MS,
      writeMutation,
      wakeQueue,
    });

    await expect(handler.processMutation(context, management)).rejects.toMatchObject({
      code: 'group-topology-config-idempotency-conflict',
    });
    expect(writeMutation).not.toHaveBeenCalled();
    expect(wakeQueue).not.toHaveBeenCalled();
  });
});

async function topologyContext(phases: string[]): Promise<AppInboxMessageContext> {
  const command = await toTopologyAppInboxCommand({
    actor: { principalId: SESSION.clientId, sessionId: SESSION.sessionId },
    groupRef: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'room-1',
    },
    requestId: 'handler-request',
    capturedAtEpochMs: NOW_EPOCH_MS,
    payload: { operation: 'putConfig', config: { topologyKind: 'tree' } },
  });
  const enqueue = await createAuthenticatedTopologyEnqueue({
    enqueue: {
      type: AppInboxType.TOPOLOGY_CONFIG_PUT,
      resourceId: command.requestId,
      data: command,
    },
    claimedAuthority: SESSION,
    groupStateService: sessionReader(phases, false),
    nowEpochMs: () => NOW_EPOCH_MS,
  });
  return {
    enqueue,
    entry: { dequeueAudit: { attempts: 7 } },
  } as AppInboxMessageContext;
}

function sessionReader(phases: string[], recordRead = true): GroupStateService {
  return {
    readIssuedAuthSession: async () => {
      if (recordRead) phases.push('verify-authority');
      return await persistedSession();
    },
  } as unknown as GroupStateService;
}

async function persistedSession(): Promise<PersistedAuthSession> {
  return {
    clientId: SESSION.clientId,
    username: SESSION.username,
    sessionId: SESSION.sessionId,
    accessTokenDigest: await authSessionProofSecret(SESSION),
    issuedAtEpochMs: SESSION.issuedAtEpochMs,
    expiresAtEpochMs: SESSION.expiresAtEpochMs,
  };
}

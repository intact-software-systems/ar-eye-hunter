import { describe, expect, it, vi } from 'vitest';

import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { authSessionProofSecret } from '@shared-server/rallar-system/auth/sessions/auth-session-proof-secret.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import {
  type AppInboxMessageContext,
  AppInboxType,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import { createAuthenticatedTopologyEnqueue } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { toTopologyConfigMutationResult } from '@shared-server/rallar-system/topology/config/mutation/to-topology-config-mutation-result.ts';
import { writeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/write-topology-config-mutation.ts';
import {
  TopologyAppInboxHandler,
  type TopologyAppInboxMutationOwners,
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';

vi.mock(
  '@shared-server/rallar-system/topology/config/mutation/write-topology-config-mutation.ts',
  () => ({ writeTopologyConfigMutation: vi.fn() }),
);
vi.mock(
  '@shared-server/rallar-system/topology/config/mutation/to-topology-config-mutation-result.ts',
  () => ({ toTopologyConfigMutationResult: vi.fn() }),
);

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
    const owners = {
      configMutationService: {
        prepare: vi.fn(async () => {
          phases.push('prepare');
          return { command: { operation: 'putConfig' } } as never;
        }),
        read: vi.fn(async () => {
          phases.push('read');
          return {} as never;
        }),
        compute: vi.fn(() => {
          phases.push('compute');
          return computed;
        }),
        validate: vi.fn(() => {
          phases.push('validate');
        }),
      },
    } satisfies TopologyAppInboxMutationOwners;
    vi.mocked(writeTopologyConfigMutation).mockImplementationOnce(
      async () => (phases.push('write'), {} as never),
    );
    vi.mocked(toTopologyConfigMutationResult).mockImplementationOnce(
      () => (phases.push('result'), expected),
    );
    const wakeQueue = vi.fn(() => phases.push('wake'));
    const handler = new TopologyAppInboxHandler({
      groupStateService: sessionReader(phases),
      nowEpochMs: () => NOW_EPOCH_MS,
      wakeQueue,
      transactionWriter: {
        writeMutation: async (_context, write) => {
          phases.push('transaction');
          const result = await write(undefined as never);
          phases.push('commit');
          return result;
        },
      },
    });
    await expect(handler.processMutation(context, owners)).resolves.toBe(expected);
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
    const owners = {
      configMutationService: {
        prepare: vi.fn(async () => ({ command: {} })),
        read: vi.fn(async () => ({})),
        compute: vi.fn(() => ({
          outcome: 'idempotency-conflict',
          existingCommandHash: 'sha256:existing',
          receivedCommandHash: 'sha256:received',
        })),
        validate: vi.fn(),
      },
      reconfigureMutation: {} as never,
    } as unknown as TopologyAppInboxMutationOwners;
    const handler = new TopologyAppInboxHandler({
      groupStateService: sessionReader(phases),
      nowEpochMs: () => NOW_EPOCH_MS,
      transactionWriter: { writeMutation },
      wakeQueue,
    });

    await expect(handler.processMutation(context, owners)).rejects.toMatchObject({
      code: 'group-topology-config-idempotency-conflict',
    });
    expect(writeMutation).not.toHaveBeenCalled();
    expect(wakeQueue).not.toHaveBeenCalled();
  });

  it('keeps reconfigure read-compute-validate-write ordered and wakes after commit', async () => {
    const phases: string[] = [];
    const context = await reconfigureTopologyContext(phases);
    const owners = {
      configMutationService: {} as never,
      reconfigureMutation: {
        read: vi.fn(async () => {
          phases.push('read');
          return {} as never;
        }),
        compute: vi.fn(() => {
          phases.push('compute');
          return { resourceId: 'reconfigure-outbox' } as never;
        }),
        validate: vi.fn(() => {
          phases.push('validate');
        }),
        write: vi.fn(async () => {
          phases.push('write');
        }),
      },
    } satisfies TopologyAppInboxMutationOwners;
    const wakeQueue = vi.fn(() => phases.push('wake'));
    const handler = new TopologyAppInboxHandler({
      groupStateService: sessionReader(phases),
      nowEpochMs: () => NOW_EPOCH_MS,
      wakeQueue,
      transactionWriter: {
        writeMutation: async (_context, write) => {
          phases.push('transaction');
          const result = await write(undefined as never);
          phases.push('commit');
          return result;
        },
      },
    });

    await expect(handler.processMutation(context, owners)).resolves.toMatchObject({
      status: 'queued',
      outboxId: 'reconfigure-outbox',
    });
    expect(phases).toEqual([
      'verify-authority',
      'read',
      'compute',
      'validate',
      'transaction',
      'write',
      'commit',
      'wake',
    ]);
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

async function reconfigureTopologyContext(phases: string[]): Promise<AppInboxMessageContext> {
  const command = await toTopologyAppInboxCommand({
    actor: { principalId: SESSION.clientId, sessionId: SESSION.sessionId },
    groupRef: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'room-1',
    },
    requestId: 'handler-request',
    capturedAtEpochMs: NOW_EPOCH_MS,
    payload: { operation: 'reconfigureTopology', requestOptions: {}, publish: true },
  });
  const enqueue = await createAuthenticatedTopologyEnqueue({
    enqueue: {
      type: AppInboxType.TOPOLOGY_RECONFIGURE,
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

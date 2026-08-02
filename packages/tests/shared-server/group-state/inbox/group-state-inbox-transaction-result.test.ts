import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { createGroupStateTransactionBoundaryHarness } from './group-state-transaction-boundary-fixture.ts';

const handlerPath =
  'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
const transactionWriterPath =
  'packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts';
const contractsPath =
  'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
const descriptorPath =
  'packages/shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
const targetIdentityPath =
  'packages/shared-server/rallar-system/group-state/mutation/orchestration/resolve-group-mutation-target-identity.ts';
const targetWritePath =
  'packages/shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
const computedWritePath =
  'packages/shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';
const targetWriteTestPath =
  'packages/tests/shared-server/group-state/mutation/write-group-mutation-behavior.test.ts';
const predecessorTargetIdentityPath =
  'packages/shared-server/rallar-system/group-state/mutation/orchestration/resolve-group-mutation-target.ts';
const predecessorWritePath =
  'packages/shared-server/rallar-system/group-state/mutation/write/write-group-state-mutation.ts';
const EXPECTED_CREATE_GROUP_DURABLE_JSON =
  '{"status":"created","result":{"right":{"snapshot":' +
  '{"stateRevision":1,"causalRevision":{"groupRevision":1,"presenceRevision":0},' +
  '"group":{"applicationId":"ar-eye-hunter","workspaceId":"default",' +
  '"groupId":"transaction-boundary-room","slug":null,' +
  '"displayName":"Transaction boundary room","description":null,"kind":"room",' +
  '"status":"active","joinMode":"open","maxMembers":null,' +
  '"maxSessionsPerMember":null,"metadata":{},"activeMemberCount":1,' +
  '"ownerPrincipalId":"owner","snapshotVersion":1,"metadataVersion":1,' +
  '"rosterVersion":1,"presenceVersion":0,"created":{"atEpochMs":1785628800000,' +
  '"actor":{"kind":"session","sessionId":"owner-session","principalId":"owner"},' +
  '"reason":null,"traceId":null,"requestId":"create-transaction-boundary-room"},' +
  '"updated":{"atEpochMs":1785628800000,"actor":{"kind":"session",' +
  '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
  '"traceId":null,"requestId":"create-transaction-boundary-room"},' +
  '"archived":null,"deleted":null,"expiresAtEpochMs":null,' +
  '"emptySinceEpochMs":null,"purgeAfterEpochMs":null},"members":[' +
  '{"applicationId":"ar-eye-hunter","workspaceId":"default",' +
  '"groupId":"transaction-boundary-room","principalId":"owner","role":"owner",' +
  '"status":"active","joined":{"atEpochMs":1785628800000,' +
  '"actor":{"kind":"session","sessionId":"owner-session","principalId":"owner"},' +
  '"reason":null,"traceId":null,"requestId":"create-transaction-boundary-room"},' +
  '"updated":{"atEpochMs":1785628800000,"actor":{"kind":"session",' +
  '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
  '"traceId":null,"requestId":"create-transaction-boundary-room"},"left":null,' +
  '"removed":null,"banned":null,"invitedByPrincipalId":null,' +
  '"invitationExpiresAtEpochMs":null}],"activeSessions":[],"memberCount":1,' +
  '"onlineMemberCount":0},"event":{"applicationId":"ar-eye-hunter",' +
  '"workspaceId":"default","groupId":"transaction-boundary-room",' +
  '"eventId":"group-event:3e85b5e31f6a320e249e7fd18bf180c7ce3a15825453b7549a25897e91bc41c7",' +
  '"eventType":"group-created","snapshotVersion":1,' +
  '"causalRevision":{"groupRevision":1,"presenceRevision":0},' +
  '"occurredAtEpochMs":1785628800000,"actor":{"kind":"session",' +
  '"sessionId":"owner-session","principalId":"owner"},"reason":null,' +
  '"traceId":null,"requestId":"create-transaction-boundary-room","payload":{}}}}}';

describe('group-state AppInbox transaction result boundary', () => {
  it('persists the real durable result before exposing the committed snapshot', async () => {
    const harness = await createGroupStateTransactionBoundaryHarness();

    const created = await harness.handler.processGroupStateMutation(harness.context);

    const persisted = await harness.results.findByKey(harness.context.entry.key);
    expect(persisted?.status).toBe(EntityStatus.COMPLETED);
    expect(persisted?.resource).toBe(EXPECTED_CREATE_GROUP_DURABLE_JSON);
    expect(persisted?.resource).not.toContain('committedSnapshot');
    const rawDurableResult = JSON.parse(persisted!.resource) as Record<string, unknown>;
    expect(Object.keys(rawDurableResult)).toEqual(['status', 'result']);
    expect(Object.keys(rawDurableResult.result as Record<string, unknown>)).toEqual(['right']);
    expect(
      Object.keys((rawDurableResult.result as { right: Record<string, unknown> }).right),
    ).toEqual(['snapshot', 'event']);
    expect(rawDurableResult).toEqual(created);
    expect(harness.transactionWriter.read(harness.context)).toEqual({
      state: 'transaction-finalized',
      status: EntityStatus.COMPLETED,
      result: created,
    });
    expect(harness.observedSnapshots).toHaveLength(1);
    expect(harness.observedSnapshots[0]).toEqual(created.result.right?.snapshot);
    expect(harness.readWakeCount()).toBe(1);
    expect(harness.outboxEntries.size).toBe(1);
  });

  it('persists an inactive presence result once without active mutation effects', async () => {
    const { GroupStateInboxHandler } =
      await import('@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts');
    const actions: string[] = [];
    const writeMutation = vi.fn(async (_context, write) => {
      actions.push('inactive-transaction');
      return await write({} as never);
    });
    const writeMutationWithAfterCommitResult = vi.fn(async () => {
      throw new Error('Inactive presence must not enter the active mutation transaction');
    });
    const handler = new GroupStateInboxHandler({
      mutationService: {
        read: async () => {
          throw new Error('Inactive presence must not read group mutation state');
        },
        compute: () => {
          throw new Error('Inactive presence must not compute a group mutation');
        },
        validate: () => {
          throw new Error('Inactive presence must not validate a group mutation');
        },
        write: async () => {
          throw new Error('Inactive presence must not write group mutation state');
        },
      },
      sessionGenerationLifecycle: {
        read: async (identity) => ({
          identity,
          key: 'closed-lifecycle',
          entry: null,
          state: null,
        }),
        isObservedAtClosed: () => true,
        isGenerationClosed: () => true,
        computeClosed: () => {
          throw new Error('Presence connect must not compute a close state');
        },
        computeConnectGuard: () => {
          throw new Error('Inactive presence must not compute a connect guard');
        },
        write: async () => {
          throw new Error('Inactive presence must not write lifecycle state');
        },
      },
      snapshotObserver: {
        observeSnapshot: async () => {
          throw new Error('Inactive presence must not observe a snapshot');
        },
      },
      transactionWriter: { writeMutation, writeMutationWithAfterCommitResult },
      wakeQueue: () => actions.push('wake'),
    });

    const result = await handler.processGroupStateMutation(inactiveConnectContext());

    expect(JSON.stringify(result)).toBe(
      '{"status":"inactive","sessionId":"inactive-session","generationId":"inactive-generation"}',
    );
    expect(actions).toEqual(['inactive-transaction']);
    expect(writeMutation).toHaveBeenCalledOnce();
    expect(writeMutationWithAfterCommitResult).not.toHaveBeenCalled();
  });

  it('passes the exact committed snapshot object to observation only after commit', async () => {
    const committedSnapshot = { snapshot: 'exact-committed-object' };
    const durableResult = { status: 'ok', result: { right: { durable: true } } };
    const readResult = vi.fn().mockResolvedValue({ durableResult, committedSnapshot });
    vi.resetModules();
    vi.doMock('@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts', () => ({
      readGroupStateInboxResult: readResult,
    }));
    const { GroupStateInboxHandler } =
      await import('@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts');
    const actions: string[] = [];
    const observed: unknown[] = [];
    const writeMutationWithAfterCommitResult = vi.fn(async (_context, write) => {
      const result = await write({} as never);
      actions.push('commit');
      return result;
    });
    const handler = new GroupStateInboxHandler({
      mutationService: {
        read: async () => ({}),
        compute: () => ({ outcome: 'write', receipt: {} }),
        validate: () => undefined,
        write: async () => {
          actions.push('write');
          return {};
        },
      } as never,
      sessionGenerationLifecycle: {} as never,
      snapshotObserver: {
        observeSnapshot: async (snapshot: unknown) => {
          actions.push('observe');
          observed.push(snapshot);
          return snapshot;
        },
      } as never,
      transactionWriter: {
        writeMutation: async (_context, write) => await write({} as never),
        writeMutationWithAfterCommitResult,
      },
      wakeQueue: () => actions.push('wake'),
    });

    await expect(
      handler.processGroupStateMutation({
        enqueue: {
          authority: {
            authorityProof: null,
            descriptor: null,
            command: { operation: 'updateGroup', aggregateRef: {} },
            facts: {},
            causalToken: 'causal-token',
            queueResourceId: 'queue-resource',
          },
        },
        entry: { dequeueAudit: { attempts: 1 } },
      } as never),
    ).resolves.toBe(durableResult);
    expect(readResult).toHaveBeenCalledOnce();
    expect(writeMutationWithAfterCommitResult).toHaveBeenCalledOnce();
    expect(observed).toEqual([committedSnapshot]);
    expect(observed[0]).toBe(committedSnapshot);
    expect(actions).toEqual(['write', 'commit', 'observe', 'wake']);
    vi.doUnmock('@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts');
  });

  it('returns immutable committed snapshot data without a mutable callback escape', () => {
    const source = readFileSync(handlerPath, 'utf8');

    expect(source).not.toContain('let committedSnapshot: GroupSnapshot | undefined;');
    expect(source).not.toContain('committedSnapshot = inboxResult.committedSnapshot;');
    expect(source).toContain(
      'await this.dependencies.snapshotObserver.observeSnapshot(committedSnapshot);',
    );
  });

  it('keeps the existing durable-only writer result and serialization unchanged', async () => {
    const harness = await createGroupStateTransactionBoundaryHarness();
    const durableResult = {
      status: 'legacy-compatible',
      result: { right: { value: 0, omitted: null } },
    } as const;

    const returned = await harness.transactionWriter.writeMutation(
      harness.context,
      async () => durableResult,
    );
    const persisted = await harness.results.findByKey(harness.context.entry.key);

    expect(returned).toBe(durableResult);
    expect(persisted?.resource).toBe(
      '{"status":"legacy-compatible","result":{"right":{"value":0,"omitted":null}}}',
    );
    expect(Object.keys(JSON.parse(persisted!.resource) as Record<string, unknown>)).toEqual([
      'status',
      'result',
    ]);
    expect(harness.transactionWriter.read(harness.context)).toEqual({
      state: 'transaction-finalized',
      status: EntityStatus.COMPLETED,
      result: durableResult,
    });
  });

  it('requires distinct durable and after-commit transaction results', () => {
    const source = readFileSync(transactionWriterPath, 'utf8');

    expect(source).toContain('interface AppInboxMutationTransactionResult');
    expect(source).toContain('export interface AppInboxMutationTransactionWriter');
    expect(source).toContain(
      'export class AppInboxTransactionWriter implements AppInboxMutationTransactionWriter',
    );
    expect(source).toContain('writeMutationWithAfterCommitResult');
    expect(source).toContain('durableResult');
    expect(source).toContain('afterCommitResult');
  });

  it('requires direct descriptor routing', () => {
    const handler = readFileSync(handlerPath, 'utf8');

    expect(handler).toContain('processGroupStateMutation(');
    expect(handler).not.toContain('toMutationDescriptor<V>(');
    expect(readFileSync(descriptorPath, 'utf8')).toContain('toGroupMutationDescriptor');
  });

  it('requires a narrow handler capability', () => {
    const handler = readFileSync(handlerPath, 'utf8');
    const contracts = readFileSync(contractsPath, 'utf8');

    expect(handler).not.toContain('groupStateService: GroupStateService;');
    expect(handler).toContain('readonly mutationService: GroupStateMutationService;');
    expect(handler).toContain(
      'readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;',
    );
    expect(handler).toContain(
      "readonly snapshotObserver: Pick<GroupStateService, 'observeSnapshot'>;",
    );
    expect(handler).toContain('readonly transactionWriter: AppInboxMutationTransactionWriter;');
    expect(handler).not.toContain('GroupStateInboxMutationOperations');
    expect(contracts).not.toContain('GroupStateInboxMutationOperations');
  });

  it('requires the Task 10 target-identity owner path', () => {
    expect(existsSync(targetIdentityPath), targetIdentityPath).toBe(true);
  });

  it('requires the Task 10 principal identity resolver name', () => {
    expect(readTargetSource(targetIdentityPath)).toContain('resolveGroupMutationTargetPrincipalId');
  });

  it('requires the Task 10 session identity resolver name', () => {
    expect(readTargetSource(targetIdentityPath)).toContain('resolveGroupMutationTargetSessionId');
  });

  it('removes the predecessor target-identity resolver path', () => {
    expect(existsSync(predecessorTargetIdentityPath), predecessorTargetIdentityPath).toBe(false);
  });

  it('requires the Task 10 mutation-write owner path', () => {
    expect(existsSync(targetWritePath), targetWritePath).toBe(true);
  });

  it('requires the Task 10 behavior-named mutation-write test path', () => {
    expect(existsSync(targetWriteTestPath), targetWriteTestPath).toBe(true);
  });

  it('removes the predecessor mutation-write path', () => {
    expect(existsSync(predecessorWritePath), predecessorWritePath).toBe(false);
  });

  it('requires computeGroupMutationWriteResult without the predecessor write symbol', () => {
    const source = readTargetSource(computedWritePath);

    expect(source).toContain('computeGroupMutationWriteResult');
    expect(source).not.toContain('computeGroupMutationWrite(');
  });

  it('removes the predecessor writeResult symbol from the computed-result owner', () => {
    const source = readTargetSource(computedWritePath);

    expect(source, computedWritePath).not.toBe('');
    expect(source).not.toContain('writeResult');
  });

  it('retains the Task 10 writeGroupMutation primary symbol', () => {
    expect(readTargetSource(targetWritePath)).toContain('writeGroupMutation');
  });
});

function readTargetSource(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function inactiveConnectContext() {
  return {
    enqueue: {
      authority: {
        authorityProof: null,
        descriptor: null,
        command: {
          operation: 'connectPresence',
          aggregateRef: {
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            groupId: 'inactive-group',
          },
          commandId: 'inactive-command',
          requestId: 'inactive-request',
          sessionId: 'inactive-session',
          input: {
            principalId: 'owner',
            generationId: 'inactive-generation',
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 61_000,
            actorPrincipalId: 'owner',
            actorSessionId: 'inactive-session',
            reason: null,
            traceId: null,
          },
        },
        facts: {
          nowEpochMs: 2_000,
          expireAtEpochMs: 604_802_000,
          serviceId: 'server-1',
          eventId: 'event-1',
          commandHash: 'sha256:inactive',
          resolvedJoinCode: null,
          joinCodeVerifier: null,
          internalAuthority: 'none',
          authenticatedAuthority: { principalId: 'owner', sessionId: 'inactive-session' },
        },
        causalToken: 'causal-token',
        queueResourceId: 'inactive-queue-resource',
      },
    },
    entry: { dequeueAudit: { attempts: 1 } },
  } as never;
}

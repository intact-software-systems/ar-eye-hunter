import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { createAuthorityHarness, createRoom } from './group-state-inbox-test-runtime.ts';

const handlerPath =
  'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
const transactionWriterPath =
  'packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts';
const contractsPath =
  'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
const descriptorPath =
  'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-mutation-descriptor.ts';
const targetIdentityPath =
  'packages/shared-server/rallar-system/group-state/mutation/orchestration/resolve-group-mutation-target-identity.ts';
const targetWritePath =
  'packages/shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';

describe('group-state AppInbox transaction result boundary', () => {
  it('persists the real durable result before exposing the committed snapshot', async () => {
    const actions: string[] = [];
    const harness = await createAuthorityHarness(['owner'], {
      wakeQueue: () => actions.push('wake'),
    });
    const observedSnapshots: unknown[] = [];
    const observeSnapshot = harness.groupStateService.observeSnapshot.bind(
      harness.groupStateService,
    );
    harness.groupStateService.observeSnapshot = async (snapshot) => {
      actions.push('observe');
      observedSnapshots.push(snapshot);
      return await observeSnapshot(snapshot);
    };

    const created = await createRoom(harness, 'durable-result-room', 'Durable result room');

    const completed = harness
      .queueEntries()
      .find((entry) => entry.status === EntityStatus.COMPLETED);
    expect(completed).toBeDefined();
    const persisted = await harness.results.findByKey(completed!.key);
    expect(persisted?.status).toBe(EntityStatus.COMPLETED);
    expect(persisted?.resource).toMatch(/^\{"status":"created","result":\{"right":\{"snapshot":/u);
    expect(persisted?.resource).not.toContain('committedSnapshot');
    const rawDurableResult = JSON.parse(persisted!.resource) as Record<string, unknown>;
    expect(Object.keys(rawDurableResult)).toEqual(['status', 'result']);
    expect(Object.keys(rawDurableResult.result as Record<string, unknown>)).toEqual(['right']);
    expect(
      Object.keys((rawDurableResult.result as { right: Record<string, unknown> }).right),
    ).toEqual(['snapshot', 'event']);
    expect(rawDurableResult).toEqual(created);
    expect(observedSnapshots).toHaveLength(1);
    expect(observedSnapshots[0]).toEqual(created.result.right?.snapshot);
    expect(actions.slice(-2)).toEqual(['observe', 'wake']);
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
    const handler = new GroupStateInboxHandler({
      groupStateService: {
        read: async () => ({}),
        compute: () => ({ outcome: 'write', receipt: {} }),
        validate: () => undefined,
        write: async () => {
          actions.push('write');
          return {};
        },
        observeSnapshot: async (snapshot: unknown) => {
          actions.push('observe');
          observed.push(snapshot);
          return snapshot;
        },
        sessionGenerationLifecycle: {},
      } as never,
      writeMutation: async (_context, write) => {
        const result = await write({} as never);
        actions.push('commit');
        return result;
      },
      wakeQueue: () => actions.push('wake'),
    });

    await expect(
      handler.processMutation({
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
    expect(observed).toEqual([committedSnapshot]);
    expect(observed[0]).toBe(committedSnapshot);
    expect(actions).toEqual(['write', 'commit', 'observe', 'wake']);
    vi.doUnmock('@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts');
  });

  it('does not expose a private result, observe, or wake when the transaction callback fails', async () => {
    const readResult = vi.fn();
    vi.resetModules();
    vi.doMock('@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts', () => ({
      readGroupStateInboxResult: readResult,
    }));
    const { GroupStateInboxHandler } =
      await import('@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts');
    const actions: string[] = [];
    const handler = new GroupStateInboxHandler({
      groupStateService: {
        read: async () => ({}),
        compute: () => ({ outcome: 'write', receipt: {} }),
        validate: () => undefined,
        write: async () => {
          actions.push('write');
          return {};
        },
        observeSnapshot: async () => {
          actions.push('observe');
          return {};
        },
        sessionGenerationLifecycle: {},
      } as never,
      writeMutation: async () => {
        actions.push('transaction-failed');
        throw new Error('controlled transaction failure');
      },
      wakeQueue: () => actions.push('wake'),
    });

    await expect(
      handler.processMutation({
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
    ).rejects.toThrow('controlled transaction failure');
    expect(readResult).not.toHaveBeenCalled();
    expect(actions).toEqual(['transaction-failed']);
    vi.doUnmock('@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts');
  });

  it('characterizes the predecessor mutable committed snapshot escape', () => {
    const source = readFileSync(handlerPath, 'utf8');

    expect(source).toContain('let committedSnapshot: GroupSnapshot | undefined;');
    expect(source).toContain('committedSnapshot = inboxResult.committedSnapshot;');
    expect(source).toContain(
      'await this.dependencies.groupStateService.observeSnapshot(committedSnapshot);',
    );
  });

  it('requires distinct durable and after-commit transaction results', () => {
    const source = readFileSync(transactionWriterPath, 'utf8');

    expect(source).toContain('interface AppInboxMutationTransactionResult');
    expect(source).toContain('writeMutationWithAfterCommitResult');
    expect(source).toContain('durableResult');
    expect(source).toContain('afterCommitResult');
  });

  it('requires direct descriptor routing and a narrow handler capability', () => {
    const handler = readFileSync(handlerPath, 'utf8');
    const contracts = readFileSync(contractsPath, 'utf8');

    expect(handler).toContain('processGroupStateMutation(');
    expect(handler).not.toContain('toMutationDescriptor<V>(');
    expect(handler).not.toContain('groupStateService: GroupStateService;');
    expect(contracts).toContain('interface GroupStateInboxMutationOperations');
    expect(readFileSync(descriptorPath, 'utf8')).toContain('toGroupMutationDescriptor');
  });

  it('requires Task 10 ownership names without retaining internal predecessor paths', () => {
    expect(readFileSync(targetIdentityPath, 'utf8')).toContain(
      'resolveGroupMutationTargetPrincipalId',
    );
    expect(readFileSync(targetIdentityPath, 'utf8')).toContain(
      'resolveGroupMutationTargetSessionId',
    );
    expect(readFileSync(targetWritePath, 'utf8')).toContain('writeGroupMutation');
  });
});

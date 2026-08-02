import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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

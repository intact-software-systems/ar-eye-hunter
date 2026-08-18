import { describe, expect, expectTypeOf, it } from 'vitest';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { AppInboxMessageContext } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  AppInboxTransactionWriter,
  type AppInboxMutationTransactionResult,
  type AppInboxMutationTransactionWriter,
} from '@shared-server/rallar-system/services/app-inbox-transaction-writer.ts';
import { createGroupStateService as createDurableGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import type { GroupMutationComputed } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
  computeGroupMutationWriteResult,
  type GroupMutationWriteInput,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';
import type {
  GroupMutationDescriptor,
  GroupStateMutationService,
  GroupStateService,
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import {
  GroupStateInboxHandler,
  type GroupStateInboxHandlerDependencies,
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import type { GroupFormationGroupMutationSink } from '@shared-server/rallar-system/formation-metrics.ts';
import type { WsSessionGenerationLifecycleService } from '@shared-server/rallar-system/services/ws-session-generation-lifecycle.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';

type DurableResult = Readonly<{ status: 'durable' }>;
type AfterCommitResult = Readonly<{ committedSnapshot: GroupSnapshot | undefined }>;
type TransactionResult = AppInboxMutationTransactionResult<DurableResult, AfterCommitResult>;
type ExpectedTransactionWriter = {
  writeMutation<Result>(
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<Result>,
  ): Promise<Result>;
  writeMutationWithAfterCommitResult<Durable, AfterCommit>(
    context: AppInboxMessageContext,
    write: (
      transaction: PSqlTransactionSql,
    ) => Promise<AppInboxMutationTransactionResult<Durable, AfterCommit>>,
  ): Promise<AppInboxMutationTransactionResult<Durable, AfterCommit>>;
};
type ExpectedHandlerDependencies = {
  readonly mutationService: GroupStateMutationService;
  readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
  readonly snapshotObserver: Pick<GroupStateService, 'observeSnapshot'>;
  readonly transactionWriter: AppInboxMutationTransactionWriter;
  readonly wakeQueue?: () => void;
  readonly formationMetrics?: GroupFormationGroupMutationSink;
};
type ExpectedComputedWrite = (input: GroupMutationWriteInput) => GroupMutationComputed;

describe('convergent group and presence state', () => {
  it('refuses to construct a user mutation service without an auth repository', () => {
    expect(() =>
      createDurableGroupStateService({
        runtimeRepository: new GroupBarrierRepository(),
        serviceId: 'missing-auth-service',
      } as never),
    ).toThrow(/auth.*required/i);
  });

  it('returns immutable committed snapshot data through the named transaction result', () => {
    expectTypeOf<TransactionResult['durableResult']>().toEqualTypeOf<DurableResult>();
    expectTypeOf<TransactionResult['afterCommitResult']>().toEqualTypeOf<AfterCommitResult>();
    expectTypeOf<
      ReturnType<AppInboxMutationTransactionWriter['writeMutationWithAfterCommitResult']>
    >().toMatchTypeOf<Promise<AppInboxMutationTransactionResult<unknown, unknown>>>();
  });

  it('requires distinct durable and after-commit transaction results', () => {
    expectTypeOf<TransactionResult>().toEqualTypeOf<
      Readonly<{ durableResult: DurableResult; afterCommitResult: AfterCommitResult }>
    >();
    expectTypeOf<TransactionResult['durableResult']>().toEqualTypeOf<DurableResult>();
    expectTypeOf<TransactionResult['afterCommitResult']>().toEqualTypeOf<AfterCommitResult>();
    expectTypeOf<AppInboxMutationTransactionWriter>().toEqualTypeOf<ExpectedTransactionWriter>();
    expectTypeOf<
      AppInboxMutationTransactionWriter['writeMutationWithAfterCommitResult']
    >().toEqualTypeOf<ExpectedTransactionWriter['writeMutationWithAfterCommitResult']>();
    expectTypeOf<AppInboxTransactionWriter>().toMatchTypeOf<AppInboxMutationTransactionWriter>();
  });

  it('routes authenticated protocol enqueues through the discriminated descriptor contract', () => {
    expectTypeOf<InstanceType<typeof GroupStateInboxHandler>['processGroupStateMutation']>()
      .parameter(0)
      .toEqualTypeOf<AppInboxMessageContext>();
    expectTypeOf<
      Parameters<typeof toGroupMutationDescriptor>[0]
    >().toEqualTypeOf<AuthenticatedGroupMutationEnqueue>();
    expectTypeOf<
      ReturnType<typeof toGroupMutationDescriptor>
    >().toEqualTypeOf<GroupMutationDescriptor>();
  });

  it('requires a narrow handler capability', () => {
    expectTypeOf<GroupStateInboxHandlerDependencies>().toEqualTypeOf<ExpectedHandlerDependencies>();
    expectTypeOf<
      GroupStateInboxHandlerDependencies['mutationService']
    >().toEqualTypeOf<GroupStateMutationService>();
    expectTypeOf<
      GroupStateInboxHandlerDependencies['sessionGenerationLifecycle']
    >().toEqualTypeOf<WsSessionGenerationLifecycleService>();
    expectTypeOf<GroupStateInboxHandlerDependencies['snapshotObserver']>().toEqualTypeOf<
      Pick<GroupStateService, 'observeSnapshot'>
    >();
    expectTypeOf<
      GroupStateInboxHandlerDependencies['transactionWriter']
    >().toEqualTypeOf<AppInboxMutationTransactionWriter>();
    expectTypeOf<GroupStateInboxHandlerDependencies['wakeQueue']>().toEqualTypeOf<
      (() => void) | undefined
    >();
    expectTypeOf<ConstructorParameters<typeof GroupStateInboxHandler>>().toEqualTypeOf<
      [GroupStateInboxHandlerDependencies]
    >();
  });

  it('exports the computed-write result function with its direct input and output contract', () => {
    expectTypeOf<typeof computeGroupMutationWriteResult>().toEqualTypeOf<ExpectedComputedWrite>();
    expectTypeOf<
      Parameters<typeof computeGroupMutationWriteResult>[0]
    >().toEqualTypeOf<GroupMutationWriteInput>();
    expectTypeOf<
      ReturnType<typeof computeGroupMutationWriteResult>
    >().toEqualTypeOf<GroupMutationComputed>();
    expectTypeOf<Parameters<typeof computeGroupMutationWriteResult>>().toEqualTypeOf<
      [GroupMutationWriteInput]
    >();
  });
});

import {
    describe,
    expectTypeOf,
    it
} from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type {
    AppInboxExecutionMetadata,
    AppInboxMessageContext
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type {
    AppInboxCompletionComputed,
    AppInboxCompletionFacts
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import {
    AppInboxTransactionWriter,
    type AppInboxMutationTransactionWriter
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import type {
    GroupMutationDescriptor,
    GroupStateServiceDependencies
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import {
    GroupStateInboxHandler
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import type { GroupMutationComputed } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutationWriteResult, type GroupMutationWriteInput } from '@shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';

type ExpectedTransactionWriter = {
    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts;
    writeComputedMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result>;
};
type ExpectedComputedWrite = (input: GroupMutationWriteInput) => GroupMutationComputed;

describe('convergent group and presence state', () => {
    it('reads authenticated sessions from its own runtime store, not from a separately injected repository', () => {
        expectTypeOf<GroupStateServiceDependencies>().not.toHaveProperty('authSessionRepository');
    });

    it('returns the computed durable result after the transaction commits', () => {
        expectTypeOf<Pick<AppInboxMutationTransactionWriter, 'readCompletionFacts' | 'writeComputedMutation'>>().toEqualTypeOf<ExpectedTransactionWriter>();
        expectTypeOf<AppInboxTransactionWriter>().toMatchTypeOf<AppInboxMutationTransactionWriter>();
    });

    it('routes authenticated protocol enqueues through the discriminated descriptor contract', () => {
        expectTypeOf<InstanceType<typeof GroupStateInboxHandler>['processGroupStateMutation']>()
            .parameter(0)
            .toEqualTypeOf<AppInboxMessageContext<GroupStateInboxDurableResult>>();
        expectTypeOf<Parameters<typeof toGroupMutationDescriptor>[0]>().toEqualTypeOf<AuthenticatedGroupMutationEnqueue>();
        expectTypeOf<ReturnType<typeof toGroupMutationDescriptor>>().toEqualTypeOf<GroupMutationDescriptor>();
    });

    it('exports the computed-write result function with its direct input and output contract', () => {
        expectTypeOf<typeof computeGroupMutationWriteResult>().toEqualTypeOf<ExpectedComputedWrite>();
        expectTypeOf<Parameters<typeof computeGroupMutationWriteResult>[0]>().toEqualTypeOf<GroupMutationWriteInput>();
        expectTypeOf<ReturnType<typeof computeGroupMutationWriteResult>>().toEqualTypeOf<GroupMutationComputed>();
        expectTypeOf<Parameters<typeof computeGroupMutationWriteResult>>().toEqualTypeOf<[GroupMutationWriteInput]>();
    });
});

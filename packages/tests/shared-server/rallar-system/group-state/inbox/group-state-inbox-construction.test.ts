import { describe, expect, expectTypeOf, it } from 'vitest';

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
    GroupMutationAuthority,
    GroupMutationDescriptor,
    GroupMutationPreparation,
    GroupStateMutationService
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService as createDurableGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import {
    GroupStateInboxHandler,
    type GroupStateInboxHandlerDependencies,
    type GroupStateInboxResultReader
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-handler.ts';
import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import type { GroupMutationComputed } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutationWriteResult, type GroupMutationWriteInput } from '@shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';
import type { GroupFormationGroupMutationSink } from '@shared-server/rallar-system/observability/formation-metrics.ts';
import type { WsSessionGenerationLifecycleService } from '@shared-server/rallar-system/websocket/ws-session-generation-lifecycle.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';

type DurableResult = Readonly<{ status: 'durable'; }>;
type ExpectedTransactionWriter = {
    readCompletionFacts(context: AppInboxExecutionMetadata): AppInboxCompletionFacts;
    writeComputedMutation<Result>(
        context: AppInboxExecutionMetadata,
        computed: AppInboxCompletionComputed<Result>,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<Result>;
};
type ExpectedHandlerDependencies = {
    readonly mutationService: GroupStateMutationService;
    readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
    readonly resultReader: GroupStateInboxResultReader;
    readonly transactionWriter: AppInboxMutationTransactionWriter;
    readonly wakeQueue?: () => void;
    readonly formationMetrics?: GroupFormationGroupMutationSink;
    readonly readAuthenticatedMutation: (
        descriptor: GroupMutationDescriptor,
        authority: GroupMutationAuthority
    ) => Promise<GroupMutationPreparation>;
};
type ExpectedComputedWrite = (input: GroupMutationWriteInput) => GroupMutationComputed;

describe('convergent group and presence state', () => {
    it('refuses to construct a user mutation service without an auth repository', () => {
        expect(() =>
            createDurableGroupStateService({
                runtimeRepository: new GroupBarrierRepository(),
                serviceId: 'missing-auth-service'
            } as never)
        ).toThrow(/auth.*required/i);
    });

    it('returns the computed durable result after the transaction commits', () => {
        expectTypeOf<AppInboxMutationTransactionWriter>().toEqualTypeOf<ExpectedTransactionWriter>();
        expectTypeOf<AppInboxTransactionWriter>().toMatchTypeOf<AppInboxMutationTransactionWriter>();
    });

    it('routes authenticated protocol enqueues through the discriminated descriptor contract', () => {
        expectTypeOf<InstanceType<typeof GroupStateInboxHandler>['processGroupStateMutation']>()
            .parameter(0)
            .toEqualTypeOf<AppInboxMessageContext<GroupStateInboxDurableResult>>();
        expectTypeOf<Parameters<typeof toGroupMutationDescriptor>[0]>().toEqualTypeOf<AuthenticatedGroupMutationEnqueue>();
        expectTypeOf<ReturnType<typeof toGroupMutationDescriptor>>().toEqualTypeOf<GroupMutationDescriptor>();
    });

    it('requires a narrow handler capability', () => {
        expectTypeOf<GroupStateInboxHandlerDependencies>().toEqualTypeOf<ExpectedHandlerDependencies>();
        expectTypeOf<GroupStateInboxHandlerDependencies['mutationService']>().toEqualTypeOf<GroupStateMutationService>();
        expectTypeOf<GroupStateInboxHandlerDependencies['sessionGenerationLifecycle']>().toEqualTypeOf<WsSessionGenerationLifecycleService>();
        expectTypeOf<GroupStateInboxHandlerDependencies['resultReader']>().toEqualTypeOf<GroupStateInboxResultReader>();
        expectTypeOf<GroupStateInboxHandlerDependencies['transactionWriter']>().toEqualTypeOf<AppInboxMutationTransactionWriter>();
        expectTypeOf<GroupStateInboxHandlerDependencies['wakeQueue']>().toEqualTypeOf<(() => void) | undefined>();
        expectTypeOf<ConstructorParameters<typeof GroupStateInboxHandler>>().toEqualTypeOf<[GroupStateInboxHandlerDependencies]>();
    });

    it('exports the computed-write result function with its direct input and output contract', () => {
        expectTypeOf<typeof computeGroupMutationWriteResult>().toEqualTypeOf<ExpectedComputedWrite>();
        expectTypeOf<Parameters<typeof computeGroupMutationWriteResult>[0]>().toEqualTypeOf<GroupMutationWriteInput>();
        expectTypeOf<ReturnType<typeof computeGroupMutationWriteResult>>().toEqualTypeOf<GroupMutationComputed>();
        expectTypeOf<Parameters<typeof computeGroupMutationWriteResult>>().toEqualTypeOf<[GroupMutationWriteInput]>();
    });
});

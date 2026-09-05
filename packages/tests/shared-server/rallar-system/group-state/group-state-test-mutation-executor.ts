import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { type toExpiryCommand, type toSessionCleanupCommand } from '@shared-server/rallar-system/group-state/group-presence-mutation-command.ts';
import {
    type GroupJoinCodeWritten,
    type GroupMutationDescriptor,
    type GroupStateMutationCommand,
    type GroupStateService,
    type GroupStateServiceDependencies,
    type GroupStateWritten
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { GroupMutationIdempotencyConflictError } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import {
    type GroupMutationComputed,
    type GroupMutationComputedWrite,
    type GroupMutationFacts,
    type GroupMutationReceipt
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toGroupMutationRejectionError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { readGroupMutation } from '@shared-server/rallar-system/group-state/mutation/read/read-group-mutation.ts';
import { assertGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/assert-group-mutation.ts';
import { GroupLifecyclePolicyRepository } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { decodeJsonWireValue, hashMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupStateEventStore } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import type { RuntimeStateGuardedBatchTransaction } from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateComputedRuntimeStateGuardedBatchResult } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch-result.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateGuardedBatchTransactionalRepositoryLike,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';

export type GroupStateTestMutationResult =
    | GroupJoinCodeWritten
    | GroupMutationReceipt
    | GroupStateWritten;

interface GroupStateTestMutationExecutorDependencies {
    readonly durableService: GroupStateService;
    readonly runtimeRepository: RuntimeStateGuardedBatchTransactionalRepositoryLike;
    readonly groupStateEventStoreFor: (
        runtime: RuntimeStateOptimisticTransactionalRepositoryLike
    ) => GroupStateEventStore;
    readonly serviceId: string;
    readonly randomId: () => string;
}

type GroupStateTestMaintenanceCommand = ReturnType<typeof toExpiryCommand> | ReturnType<typeof toSessionCleanupCommand>;

export class GroupStateTestMutationExecutor {
    private readonly dependencies: GroupStateTestMutationExecutorDependencies;

    constructor(dependencies: GroupStateTestMutationExecutorDependencies) {
        this.dependencies = dependencies;
    }

    async executeAuthenticated(
        descriptor: GroupMutationDescriptor,
        authority: IssuedAuthSession,
        receiptOnly: boolean,
        attemptCount: number
    ): Promise<GroupStateTestMutationResult> {
        const ingress = await this.dependencies.durableService.captureMutationIngress(descriptor, authority);
        const command: GroupStateMutationCommand = {
            authorityProof: ingress.authorityProof,
            descriptor: ingress.descriptor,
            command: ingress.command,
            facts: { ...ingress.facts, attemptCount }
        };
        const read = await this.dependencies.durableService.read(command);
        const computed = this.dependencies.durableService.compute(command, read);
        assertValidGroupMutationServiceResult(
            this.dependencies.durableService,
            command,
            read,
            computed
        );
        if (computed.outcome === 'idempotency-conflict') {
            throw new GroupMutationIdempotencyConflictError(
                command.command.commandId,
                computed.existingCommandHash,
                computed.receivedCommandHash
            );
        }
        if (computed.outcome === 'write') {
            await this.writeComputed(computed);
        }
        return await this.toMutationResult(ingress.command.operation, computed, receiptOnly);
    }

    async executeInternal(
        command: GroupStateTestMaintenanceCommand,
        authority: GroupMutationFacts['internalAuthority'],
        atEpochMs: number,
        attemptCount: number
    ): Promise<Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>> {
        const commandHash = await hashMutationCommand(
            decodeJsonWireValue(command, 'Group maintenance command')
        );
        const read = await readGroupMutation(this.repository(), command);
        const facts: GroupMutationFacts = {
            nowEpochMs: atEpochMs,
            expireAtEpochMs: TEST_OUTBOX_EXPIRE_AT_EPOCH_MS,
            serviceId: this.dependencies.serviceId,
            eventId: this.dependencies.randomId(),
            commandHash,
            attemptCount,
            resolvedJoinCode: null,
            joinCodeVerifier: null,
            internalAuthority: authority,
            capacity: { defaultMaxMembers: null },
            authenticatedAuthority: null
        };
        const computed = computeGroupMutation({ command, read, facts });
        assertGroupMutation({ command, read, facts, computed });
        if (computed.outcome === 'idempotency-conflict') {
            throw new TypeError('Validated idempotency conflict is unreachable');
        }
        if (computed.outcome === 'write') {
            await this.writeComputed(computed);
        }
        return computed;
    }

    async toMutationResult(
        operation: GroupStateMutationCommand['command']['operation'],
        computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>,
        receiptOnly: true
    ): Promise<GroupMutationReceipt>;
    async toMutationResult(
        operation: 'rotateGroupJoinCode',
        computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>,
        receiptOnly?: false
    ): Promise<GroupJoinCodeWritten>;
    async toMutationResult(
        operation: Exclude<GroupStateMutationCommand['command']['operation'], 'rotateGroupJoinCode'>,
        computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>,
        receiptOnly?: false
    ): Promise<GroupStateWritten>;
    async toMutationResult(
        operation: GroupStateMutationCommand['command']['operation'],
        computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>,
        receiptOnly: boolean
    ): Promise<GroupStateTestMutationResult>;
    async toMutationResult(
        operation: GroupStateMutationCommand['command']['operation'],
        computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>,
        receiptOnly = false
    ): Promise<GroupStateTestMutationResult> {
        if (computed.outcome === 'rejected') {
            throw toGroupMutationRejectionError(computed);
        }
        const repository = this.repository();
        const receipt = computed.receipt;
        if (receiptOnly) {
            return receipt;
        }
        const snapshot = await repository.readSnapshot(receipt.aggregateRef);
        if (!snapshot) {
            throw new TypeError(`Group snapshot not found: ${receipt.aggregateRef.groupId}`);
        }
        const event = await this.receiptEvent(repository, receipt);
        if (operation === 'rotateGroupJoinCode') {
            if (receipt.joinCode === null || receipt.joinCodeExpiresAtEpochMs === null) {
                throw new TypeError('Rotate join-code receipt requires current join-code values');
            }
            return {
                status: 'ok',
                result: {
                    joinCode: receipt.joinCode,
                    expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
                    snapshot,
                    event
                }
            };
        }
        return {
            status: operation === 'createGroup' ? 'created' : 'ok',
            result: { snapshot, event }
        };
    }

    private async writeComputed(computed: GroupMutationComputedWrite): Promise<GroupMutationReceipt> {
        await this.dependencies.runtimeRepository.begin(async (transaction) => {
            const repository = this.repository(transaction);
            await writeGuardedBatch(transaction, computed);
            if (computed.lifecyclePolicy !== null) {
                await new GroupLifecyclePolicyRepository(transaction).writePolicy(computed.receipt.aggregateRef, computed.lifecyclePolicy);
            }
            await repository.appendEvent(computed.event);
        });
        return computed.receipt;
    }

    private async receiptEvent(repository: GroupStateRepository, receipt: GroupMutationReceipt): Promise<GroupEvent | null> {
        if (receipt.eventId === null) {
            return null;
        }
        return (await repository.listEvents(receipt.aggregateRef)).find((event) => event.eventId === receipt.eventId) ?? null;
    }

    private repository(runtimeRepository = this.dependencies.runtimeRepository): GroupStateRepository {
        return createTestGroupStateRepository(
            runtimeRepository,
            this.dependencies.groupStateEventStoreFor(runtimeRepository)
        );
    }
}

async function writeGuardedBatch(transaction: RuntimeStateGuardedBatchTransaction, computed: GroupMutationComputedWrite): Promise<void> {
    const materialized = computed.persistence.guardedBatch;
    const result = validateComputedRuntimeStateGuardedBatchResult(
        materialized,
        await transaction.writeGuardedBatch(materialized)
    );
    if (result.guard.status === 'conflict' || result.effects.some((effect) => effect.status !== 'applied')) {
        throw new RuntimeStateWriteConflictError();
    }
}

const TEST_OUTBOX_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

function assertValidGroupMutationServiceResult(
    service: GroupStateService,
    command: GroupStateMutationCommand,
    read: Parameters<GroupStateService['validate']>[1],
    computed: GroupMutationComputed
): void {
    const issue = service.validate(command, read, computed)[0];
    if (issue !== undefined) {
        throw issue.cause;
    }
}

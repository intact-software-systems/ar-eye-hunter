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
import {
    type GroupMutationComputed,
    type GroupMutationComputedWrite,
    type GroupMutationFacts,
    type GroupMutationReceipt
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toGroupMutationRejectionError } from '@shared-server/rallar-system/group-state/mutation/group-mutation-result.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { validateGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation.ts';
import { materializeGroupStateGuardedBatch } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { GroupLifecyclePolicyRepository } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { hashMutationCommand, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupStateEventStore } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';
import {
    isRuntimeStateGuardedBatchRepositoryLike,
    type RuntimeStateGuardedBatchRepositoryLike
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatchResult } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch-result.ts';
import {
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';

export type GroupStateTestMutationResult =
    | GroupJoinCodeWritten
    | GroupMutationReceipt
    | GroupStateWritten;

type GroupStateTestMutationExecutorDependencies = Readonly<{
    durableService: GroupStateService;
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    groupStateEventStoreFor: (
        runtime: RuntimeStateOptimisticTransactionalRepositoryLike
    ) => GroupStateEventStore;
    serviceId: string;
    randomId: () => string;
    sleep?: (delayMs: number) => Promise<void>;
}>;

type GroupStateTestMaintenanceCommand = ReturnType<typeof toExpiryCommand> | ReturnType<typeof toSessionCleanupCommand>;

export class GroupStateTestMutationExecutor {
    private readonly dependencies: GroupStateTestMutationExecutorDependencies;

    constructor(dependencies: GroupStateTestMutationExecutorDependencies) {
        this.dependencies = dependencies;
    }

    async executeAuthenticated(
        descriptor: GroupMutationDescriptor,
        authority: IssuedAuthSession,
        receiptOnly: boolean
    ): Promise<GroupStateTestMutationResult> {
        const prepared = await this.dependencies.durableService.prepareMutation(descriptor, authority);
        let computed: GroupMutationComputed | undefined;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const command: GroupStateMutationCommand = {
                authorityProof: prepared.authorityProof,
                descriptor: prepared.descriptor,
                command: prepared.command,
                facts: { ...prepared.facts, attemptCount: attempt }
            };
            try {
                const read = await this.dependencies.durableService.read(command);
                computed = this.dependencies.durableService.compute(command, read);
                this.dependencies.durableService.validate(command, read, computed);
                if (computed.outcome === 'idempotency-conflict') {
                    throw new TypeError('Validated idempotency conflict is unreachable');
                }
                if (computed.outcome === 'write') {
                    await this.writeComputed(computed);
                }
                return await this.toMutationResult(prepared.command.operation, computed, receiptOnly);
            }
            catch (error) {
                await this.handleWriteConflict(error, attempt);
            }
        }
        throw new TypeError(`Missing computed group mutation: ${String(computed)}`);
    }

    async executeInternal(
        command: GroupStateTestMaintenanceCommand,
        authority: GroupMutationFacts['internalAuthority'],
        atEpochMs: number
    ): Promise<Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>> {
        const commandHash = await hashMutationCommand(command as JsonWireValue);
        let computed: GroupMutationComputed | undefined;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const read = await import('@shared-server/rallar-system/group-state/mutation/read/read-group-mutation.ts').then(
                ({ readGroupMutation }) => readGroupMutation(this.repository(), command)
            );
            const facts: GroupMutationFacts = {
                nowEpochMs: atEpochMs,
                expireAtEpochMs: TEST_OUTBOX_EXPIRE_AT_EPOCH_MS,
                serviceId: this.dependencies.serviceId,
                eventId: this.dependencies.randomId(),
                commandHash,
                attemptCount: attempt,
                resolvedJoinCode: null,
                joinCodeVerifier: null,
                internalAuthority: authority,
                authenticatedAuthority: null
            };
            computed = computeGroupMutation({ command, read, facts });
            validateGroupMutation({ command, read, facts, computed });
            if (computed.outcome === 'idempotency-conflict') {
                throw new TypeError('Validated idempotency conflict is unreachable');
            }
            if (computed.outcome !== 'write') {
                return computed;
            }
            try {
                await this.writeComputed(computed);
                return computed;
            }
            catch (error) {
                await this.handleWriteConflict(error, attempt);
            }
        }
        throw new TypeError(`Missing internal group mutation: ${String(computed)}`);
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
        if (computed.outcome === 'rejected') {
            throw toGroupMutationRejectionError(computed);
        }
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
            if (isRuntimeStateGuardedBatchRepositoryLike(transaction)) {
                await writeGuardedBatch(transaction, computed);
            }
            else {
                await writeConditionalMutation(repository, computed);
            }
            if (computed.lifecyclePolicy !== null) {
                await new GroupLifecyclePolicyRepository(transaction).writePolicy(computed.receipt.aggregateRef, computed.lifecyclePolicy);
            }
            await repository.appendEvent(computed.event);
        });
        return computed.receipt;
    }

    private async handleWriteConflict(error: unknown, attempt: number): Promise<void> {
        if (!(error instanceof RuntimeStateWriteConflictError)) {
            throw error;
        }
        if (attempt === 3) {
            throw new RuntimeStateRetryExhaustedError(error);
        }
        await this.dependencies.sleep?.(attempt === 1 ? 2 : 8);
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

async function writeGuardedBatch(transaction: RuntimeStateGuardedBatchRepositoryLike, computed: GroupMutationComputedWrite): Promise<void> {
    const materialized = materializeGroupStateGuardedBatch(computed);
    const result = validateRuntimeStateGuardedBatchResult(materialized.batch, await transaction.executeGuardedBatch(materialized.batch));
    if (result.guard.status === 'conflict' || result.effects.some((effect) => effect.status !== 'applied')) {
        throw new RuntimeStateWriteConflictError();
    }
}

async function writeConditionalMutation(repository: GroupStateRepository, computed: GroupMutationComputedWrite): Promise<void> {
    await writeConditionalGuard(repository, computed);
    if (computed.presenceAdmission) {
        requireConditionalWrite(
            computed.presenceAdmission.operation === 'insert'
                ? await repository.insertPresenceAdmission(computed.presenceAdmission.value)
                : await repository.updatePresenceAdmission(computed.presenceAdmission.value, computed.presenceAdmission.expectedRevision)
        );
    }
    for (const member of computed.members) {
        await repository.putMember(member);
    }
    if (computed.initialPresenceSummary) {
        const summary = computed.initialPresenceSummary;
        requireConditionalWrite(
            summary.operation === 'insert'
                ? await repository.insertPresenceSummary(summary.value)
                : await repository.updatePresenceSummary(summary.value, summary.expectedRevision)
        );
    }
    if (computed.idempotency) {
        requireConditionalWrite(
            await repository.insertIdempotentGroupMutationReceipt(
                computed.receipt.aggregateRef,
                computed.idempotency.requestId,
                computed.idempotency
            )
        );
    }
}

async function writeConditionalGuard(repository: GroupStateRepository, computed: GroupMutationComputedWrite): Promise<void> {
    if (computed.guard.kind === 'group') {
        requireConditionalWrite(
            computed.guard.operation === 'insert'
                ? await repository.insertGroup(computed.guard.value)
                : await repository.updateGroup(computed.guard.value, computed.guard.expectedRevision)
        );
        return;
    }
    requireConditionalWrite(
        computed.guard.operation === 'insert'
            ? await repository.insertPresence(computed.guard.value)
            : computed.guard.operation === 'update'
            ? await repository.updatePresence(computed.guard.value, computed.guard.expectedRevision)
            : await repository.deletePresence(computed.guard.value, computed.guard.expectedRevision)
    );
}

const TEST_OUTBOX_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

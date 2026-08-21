import { materializeGroupStateGuardedBatch } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { GroupLifecyclePolicyRepository } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import type {
    GroupMutationComputed,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationReceipt
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import {
    type GroupMutationDescriptor,
    type GroupStateMutationCommand,
    type GroupStateService,
    type GroupStateServiceDependencies,
    type toExpiryCommand,
    type toSessionCleanupCommand
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { hashMutationCommand, type JsonWireValue } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import {
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import {
    isRuntimeStateGuardedBatchRepositoryLike,
    validateRuntimeStateGuardedBatchResult,
    type RuntimeStateGuardedBatchRepositoryLike
} from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';
import type { RuntimeStateOptimisticTransactionalRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import type { GroupEvent } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { AuthSession } from '../auth/auth-test-fixtures.ts';

type GroupStateTestMutationExecutorDependencies = Readonly<{
    durableService: GroupStateService;
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    createGroupStateEventStore?: GroupStateServiceDependencies['createGroupStateEventStore'];
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

    async executeAuthenticated(descriptor: GroupMutationDescriptor, authority: AuthSession, receiptOnly: boolean): Promise<unknown> {
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
                return await this.toCompatibleResult(prepared.command.operation, computed, receiptOnly);
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
                formationDamping: 'legacy',
                authenticatedAuthority: null
            };
            const mutation = await import('@shared-server/rallar-system/services/group-state-mutations.ts');
            computed = mutation.computeGroupMutation({ command, read, facts });
            mutation.validateGroupMutation({ command, read, facts, computed });
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

    async toCompatibleResult(
        operation: GroupStateMutationCommand['command']['operation'],
        computed: Exclude<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>,
        receiptOnly = false
    ): Promise<any> {
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
            return receipt.outcome === 'rejected'
                ? { status: 'error', result: Either.ofLeft(receipt.rejection ?? 'Rejected') }
                : {
                    status: 'ok',
                    result: Either.ofRight({
                        joinCode: receipt.joinCode,
                        expiresAtEpochMs: receipt.joinCodeExpiresAtEpochMs,
                        snapshot,
                        event
                    })
                };
        }
        return receipt.outcome === 'rejected'
            ? { status: 'error', result: Either.ofLeft(receipt.rejection ?? 'Rejected') }
            : {
                status: operation === 'createGroup' ? 'created' : 'ok',
                result: Either.ofRight({ snapshot, event })
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
        return new GroupStateRepository(runtimeRepository, {
            events: this.dependencies.createGroupStateEventStore?.(runtimeRepository)
        });
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

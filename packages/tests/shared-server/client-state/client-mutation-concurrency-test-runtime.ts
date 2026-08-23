import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { CLIENT_MUTATION_TEST_SCOPE as SCOPE, clientMutationPrincipalRef as principalRef } from './client-mutation-validation-test-fixtures.ts';
import { createClientStateTestDriver as createClientStateService, getClientStateTestOutbox } from './client-state-test-runtime.ts';

export const CLIENT_MUTATION_BASE_EPOCH_MS = Date.now();

export class AggregateBarrierRepository extends FakeRuntimeStateRepository {
    private principalReadsRemaining = 0;
    private principalReadsArrived = 0;
    private releasePrincipalReads: (() => void) | undefined;
    private releaseFirstPrincipalRead: (() => void) | undefined;
    private holdFirstPrincipalRead = false;
    private aggregateTransactionTail: Promise<void> = Promise.resolve();
    armPrincipalReadBarrier(readers: number, holdFirst = false): Promise<void> {
        this.principalReadsRemaining = readers;
        this.principalReadsArrived = 0;
        this.holdFirstPrincipalRead = holdFirst;
        return new Promise((resolve) => {
            this.releaseFirstPrincipalRead = resolve;
        });
    }
    releasePrincipalReadBarrier(): void {
        this.releasePrincipalReads?.();
    }
    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const value = await super.findEntry(namespace, key);
        if (namespace !== 'client-state:principals' || this.principalReadsRemaining <= 0) {
            return value;
        }
        this.principalReadsArrived += 1;
        this.releaseFirstPrincipalRead?.();
        this.releaseFirstPrincipalRead = undefined;
        if (this.principalReadsArrived === this.principalReadsRemaining) {
            this.principalReadsRemaining = 0;
            if (!this.holdFirstPrincipalRead) {
                this.releasePrincipalReads?.();
            }
            return value;
        }
        await new Promise<void>((resolve) => {
            this.releasePrincipalReads = resolve;
        });
        return value;
    }

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        let release!: () => void;
        const previous = this.aggregateTransactionTail;
        this.aggregateTransactionTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await super.begin(fn);
        }
        finally {
            release();
        }
    }
}

export class PrincipalChangeAfterFirstReadRepository extends AggregateBarrierRepository {
    private changeAfterPrincipalRead = false;

    armPrincipalChangeAfterRead(): void {
        this.changeAfterPrincipalRead = true;
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = await super.findEntry(namespace, key);
        if (namespace === 'client-state:principals' && entry && this.changeAfterPrincipalRead) {
            this.changeAfterPrincipalRead = false;
            await super.upsert(namespace, key, entry.value, entry.expireAtTimestamp);
        }
        return entry;
    }
}

export class AlwaysConflictingPrincipalRepository extends AggregateBarrierRepository {
    principalGuardCount = 0;
    transactionBeginCount = 0;

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        this.transactionBeginCount += 1;
        return await super.begin(fn);
    }

    override insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        if (namespace === 'client-state:principals') {
            this.principalGuardCount += 1;
            return Promise.resolve({ status: 'conflict' });
        }
        return super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }
}

export class StatementRecordingRepository extends AggregateBarrierRepository {
    transactionBeginCount = 0;
    readonly transactionStatements: string[] = [];
    private transactionDepth = 0;

    override async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        this.transactionBeginCount += 1;
        this.transactionDepth += 1;
        try {
            return await super.begin(fn);
        }
        finally {
            this.transactionDepth -= 1;
        }
    }

    override insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.record('insertIfAbsent', namespace);
        return super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }

    override upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.record('upsertIfRevision', namespace);
        return super.upsertIfRevision(namespace, key, value, expireAtTimestamp, expectedRevision);
    }

    resetInstrumentation(): void {
        this.transactionBeginCount = 0;
        this.transactionStatements.length = 0;
    }

    private record(operation: string, namespace: string): void {
        if (this.transactionDepth > 0) {
            this.transactionStatements.push(`${operation}:${namespace}`);
        }
    }
}

export function createService(
    runtimeRepository: AggregateBarrierRepository,
    nowEpochMs: number,
    timing?: (event: RallarTimingEvent) => void
) {
    return createClientStateService({
        runtimeRepository,
        now: () => nowEpochMs,
        randomId: (() => {
            let next = 0;
            return () => `id-${nowEpochMs}-${++next}`;
        })(),
        sleep: () => Promise.resolve(),
        serviceId: 'client-service',
        timing
    });
}

export async function connect(
    runtime: AggregateBarrierRepository,
    sessionId: string,
    generationId: string,
    nowEpochMs: number,
    expiresAtEpochMs = CLIENT_MUTATION_BASE_EPOCH_MS + 50_000
): Promise<void> {
    await createService(runtime, nowEpochMs).connectSession(SCOPE, 'alice', 'browser', sessionId, {
        generationId,
        connectionId: generationId,
        connectedAtEpochMs: nowEpochMs,
        lastHeartbeatAtEpochMs: nowEpochMs,
        expiresAtEpochMs,
        requestId: `connect-${sessionId}-${generationId}`
    });
}

export async function snapshot(runtime: AggregateBarrierRepository, principalId: string) {
    const value = await new ClientStateRepository(runtime).readSnapshot(principalRef(principalId));
    if (!value) {
        throw new Error(`missing snapshot for ${principalId}`);
    }
    return value;
}

export async function outboxFor(
    runtime: AggregateBarrierRepository,
    commandIds: readonly string[]
) {
    return getClientStateTestOutbox(runtime).filter((entry) => commandIds.some((commandId) => entry.resource.includes(commandId)));
}

export function deepFreeze<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
    DequeueResourceEntryController,
    ResilienceDto,
    type ResourceInboxRetryExhaustion,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { DequeueController } from '@shared/queuebox/DequeueController.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry,
    toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type {
    PSqlSql,
    PSqlTransactionSql,
} from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    AppInboxReservationConflictError,
    AppInboxService,
    AppInboxType,
    classifyAppInboxError,
    createAppInboxRetryExhaustionHandler,
    type AppInboxMessageContext,
    type AppInboxTransactionRepositories,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';

const NOW_EPOCH_MS = Date.parse('2026-07-22T12:00:00.000Z');

describe('AppInboxService transaction ownership', () => {
    it('commits mutation, outbox, result, and completion in one transaction', async () => {
        const harness = createAtomicHarness();
        const receipt = { status: 'accepted', revision: 2 } as const;

        const result = await harness.service.commit(harness.context, async (transaction) => {
            expect(transaction).toBe(harness.database.activeTransaction);
            harness.database.writeMutation('group-1', { revision: 2 });
            harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            return receipt;
        });

        expect(result).toEqual(receipt);
        expect(harness.database.beginCalls).toBe(1);
        expect(harness.database.state.mutations.get('group-1')).toEqual({ revision: 2 });
        expect(harness.database.state.outbox.get('outbox-1')).toEqual({ groupId: 'group-1' });
        expect(JSON.parse(harness.database.state.results.get(toKeyAsString(harness.entry.key))!.resource))
            .toEqual(receipt);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.COMPLETED);
    });

    it.each(['dependent-write', 'outbox-write'] as const)(
        'rolls the mutation back when the %s fails',
        async (failurePhase) => {
            const harness = createAtomicHarness();

            await expect(harness.service.commit(harness.context, async () => {
                harness.database.writeMutation('group-1', { revision: 2 });
                if (failurePhase === 'dependent-write') {
                    throw new Error('dependent write failed');
                }
                harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
                throw new Error('outbox write failed');
            })).rejects.toThrow(`${failurePhase.split('-')[0]} write failed`);

            expect(harness.database.state.mutations.size).toBe(0);
            expect(harness.database.state.outbox.size).toBe(0);
            expect(harness.database.state.results.size).toBe(0);
            expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
                .toBe(EntityStatus.RESERVED);
        },
    );

    it('rolls every successful write back when the result write fails', async () => {
        const harness = createAtomicHarness({ failResultWrite: true });

        await expect(harness.service.commit(harness.context, async () => {
            harness.database.writeMutation('group-1', { revision: 2 });
            harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            return { status: 'accepted' };
        })).rejects.toThrow('result write failed');

        expect(harness.database.state.mutations.size).toBe(0);
        expect(harness.database.state.outbox.size).toBe(0);
        expect(harness.database.state.results.size).toBe(0);
    });

    it('rolls every successful write back when reservation ownership changed', async () => {
        const harness = createAtomicHarness({ loseReservation: true });

        await expect(harness.service.commit(harness.context, async () => {
            harness.database.writeMutation('group-1', { revision: 2 });
            harness.database.writeOutbox('outbox-1', { groupId: 'group-1' });
            return { status: 'accepted' };
        })).rejects.toBeInstanceOf(AppInboxReservationConflictError);
        await expect(harness.service.commit(harness.context, async () => undefined))
            .rejects.toMatchObject({ code: 'app-inbox-reservation-conflict' });

        expect(harness.database.state.mutations.size).toBe(0);
        expect(harness.database.state.outbox.size).toBe(0);
        expect(harness.database.state.results.size).toBe(0);
    });

    it('writes terminal policy denial result and FAILED completion atomically', async () => {
        const harness = createAtomicHarness();
        const denial = new GroupPolicyDeniedError({
            allowed: false,
            code: 'group-policy-denied',
            message: 'membership is required',
            details: { groupId: 'group-1' },
        });

        const classification = classifyAppInboxError(denial);
        expect(classification).toMatchObject({ kind: 'terminal' });
        if (classification.kind !== 'terminal') throw new Error('Expected terminal denial');
        await harness.service.fail(harness.context, classification.result);

        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toMatchObject({
            code: 'group-policy-denied',
            message: 'membership is required',
        });
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.FAILED);
    });

    it('classifies CAS conflicts as retryable without writing a result', async () => {
        const harness = createAtomicHarness();
        const conflict = Object.assign(new Error('conditional write lost'), {
            code: 'runtime-state-write-conflict',
            status: 503,
        });

        expect(classifyAppInboxError(conflict)).toEqual({
            kind: 'retryable',
            code: 'runtime-state-write-conflict',
            message: 'conditional write lost',
        });
        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.RESERVED);

        expect(classifyAppInboxError(
            new AppInboxReservationConflictError(harness.entry.key),
        )).toMatchObject({
            kind: 'retryable',
            code: 'app-inbox-reservation-conflict',
        });
    });

    it('records transaction and write timing for the exact winning attempt without a plan field', async () => {
        const timing: RallarTimingEvent[] = [];
        const harness = createAtomicHarness({ timing: (event) => timing.push(event) });

        await harness.service.commit(harness.context, async () => ({ status: 'accepted' }));

        expect(timing.filter((event) => event.operation === 'transaction')).toHaveLength(1);
        expect(timing.filter((event) => event.operation === 'write')).toHaveLength(1);
        for (const event of timing) {
            expect(event.details).toMatchObject({ attempt: 7 });
            expect(event.details).not.toHaveProperty('plan');
        }
    });
});

describe('AppInbox retry exhaustion', () => {
    it('persists mandatory attempt-20 diagnostics and FAILED completion in one transaction', async () => {
        const harness = createAtomicHarness({ attempts: 20 });
        const telemetry: ResourceInboxRetryExhaustion[] = [];
        const releaseEntries = vi.fn();
        const onRetryExhausted = createAppInboxRetryExhaustionHandler({
            database: harness.database.sql,
            nowEpochMs: () => NOW_EPOCH_MS,
            transactionRepositories: harness.transactionRepositories,
        });
        let reserved = false;
        const controller = DequeueResourceEntryController.toDequeuer<Key>(
            {
                isAnyEntryToLock: async () => true,
                reserveEntries: async () => {
                    if (reserved) return new Map();
                    reserved = true;
                    return new Map([[harness.entry.key, harness.entry]]);
                },
                reserveTimeoutEntries: async () => new Map(),
                reserveOverdueRetryEntries: async () => new Map(),
                releaseEntries,
            },
            () => new Set([EnqueuedType.APP_INBOX]),
            () => 1,
            20,
            1,
            createResilience(),
            {
                nowEpochMs: () => NOW_EPOCH_MS,
                jitterUnit: () => 0.5,
                onRetryExhausted,
                onRetryExhaustionTelemetry: (event) => telemetry.push(event),
            },
        );

        await controller.dequeueForCompute(async () => {
            throw Object.assign(new Error('conditional write lost'), {
                code: 'runtime-state-write-conflict',
            });
        });

        expect(releaseEntries).not.toHaveBeenCalled();
        expect(harness.database.beginCalls).toBe(1);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status)
            .toBe(EntityStatus.FAILED);
        const stored = harness.database.state.results.get(toKeyAsString(harness.entry.key));
        expect(stored?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(stored!.resource)).toEqual({
            type: 'app-inbox-retry-exhausted',
            commandIdentity: {
                contextId: harness.entry.key.contextId,
                resourceId: harness.entry.key.resourceId,
                topicId: harness.entry.key.topicId,
                typeId: EnqueuedType.APP_INBOX,
            },
            attempts: 20,
            lastError: {
                code: 'runtime-state-write-conflict',
                message: 'conditional write lost',
            },
            queueAgeMs: expect.any(Number),
            dueAgeMs: expect.any(Number),
            exhaustedAtEpochMs: NOW_EPOCH_MS,
        });
        expect(telemetry).toEqual([
            expect.objectContaining({
                attempt: 20,
                lane: 'NEW',
                classification: 'retryable',
                exhausted: true,
                queueAgeMs: expect.any(Number),
                dueAgeMs: expect.any(Number),
            }),
        ]);
    });
});

class AtomicAppInboxService extends AppInboxService {
    async commit<R>(
        context: AppInboxMessageContext,
        write: (transaction: PSqlTransactionSql) => Promise<R>,
    ): Promise<R> {
        return await this.writeMutation(context, write);
    }

    async fail(context: AppInboxMessageContext, error: unknown): Promise<void> {
        await this.writeTerminalFailure(context, error);
    }
}

type AtomicState = {
    mutations: Map<string, unknown>;
    outbox: Map<string, unknown>;
    inbox: Map<string, ResourceEntry>;
    results: Map<string, ResourceEntry>;
};

class AtomicDatabase {
    state: AtomicState;
    beginCalls = 0;
    activeTransaction: PSqlTransactionSql | undefined;
    private working: AtomicState | undefined;

    readonly sql: PSqlSql;

    constructor(entry: ResourceEntry) {
        this.state = {
            mutations: new Map(),
            outbox: new Map(),
            inbox: new Map([[toKeyAsString(entry.key), entry]]),
            results: new Map(),
        };
        const sql = (async () => {
            throw new Error('Unexpected raw SQL in atomic test database');
        }) as unknown as PSqlSql;
        sql.begin = async <T>(write: (transaction: PSqlTransactionSql) => Promise<T>) => {
            this.beginCalls += 1;
            const transaction = (async () => {
                throw new Error('Unexpected raw transaction SQL in atomic test database');
            }) as unknown as PSqlTransactionSql;
            transaction.begin = async () => {
                throw new Error('Nested transaction');
            };
            this.activeTransaction = transaction;
            this.working = cloneState(this.state);
            try {
                const result = await write(transaction);
                this.state = this.working;
                return result;
            } finally {
                this.activeTransaction = undefined;
                this.working = undefined;
            }
        };
        this.sql = sql;
    }

    writeMutation(key: string, value: unknown): void {
        this.requireWorking().mutations.set(key, value);
    }

    writeOutbox(key: string, value: unknown): void {
        this.requireWorking().outbox.set(key, value);
    }

    repositories(options: Readonly<{
        failResultWrite: boolean;
        loseReservation: boolean;
    }>): AppInboxTransactionRepositories {
        return () => ({
            resourceInboxResults: {
                replace: async (entry) => {
                    if (options.failResultWrite) throw new Error('result write failed');
                    this.requireWorking().results.set(toKeyAsString(entry.key), entry);
                    return entry;
                },
            },
            resourceInbox: {
                finishReserved: async (key, expectedAttempts, status, completedAt) => {
                    if (options.loseReservation) return false;
                    const stored = this.requireWorking().inbox.get(toKeyAsString(key));
                    if (
                        !stored ||
                        stored.status !== EntityStatus.RESERVED ||
                        stored.dequeueAudit.attempts !== expectedAttempts
                    ) return false;
                    this.requireWorking().inbox.set(toKeyAsString(key), {
                        ...stored,
                        status,
                        dequeueAudit: {
                            ...stored.dequeueAudit,
                            endTs: Temporal.Instant.fromEpochMilliseconds(completedAt.getTime()),
                            nextTs: undefined,
                        },
                    });
                    return true;
                },
            },
        });
    }

    private requireWorking(): AtomicState {
        if (!this.working) throw new Error('Write occurred without active transaction');
        return this.working;
    }
}

function createAtomicHarness(options: Readonly<{
    attempts?: number;
    failResultWrite?: boolean;
    loseReservation?: boolean;
    timing?: (event: RallarTimingEvent) => void;
}> = {}) {
    const entry = createReservedEntry(options.attempts ?? 7);
    const database = new AtomicDatabase(entry);
    const transactionRepositories = database.repositories({
        failResultWrite: options.failResultWrite ?? false,
        loseReservation: options.loseReservation ?? false,
    });
    const queue = new InMemoryQueueBox();
    const reader = new InboxQueueReader(queue);
    const service = new AtomicAppInboxService(
        reader,
        {} as never,
        {} as never,
        database.sql,
        'server-1',
        'app-inbox.group-state',
        options.timing,
        {
            phaseTiming: true,
            nowEpochMs: () => NOW_EPOCH_MS,
            transactionRepositories,
        },
    );
    const enqueue = {
        type: AppInboxType.GROUP_CREATE,
        resourceId: entry.key.resourceId,
        contextId: entry.key.contextId,
        data: { requestId: entry.key.resourceId },
    } as const;
    const context: AppInboxMessageContext = {
        enqueue,
        message: {} as never,
        entry,
    };
    return { context, database, entry, service, transactionRepositories };
}

function createReservedEntry(attempts: number): ResourceEntry {
    return {
        key: {
            topicId: 'app-inbox.group-state',
            resourceId: 'request-1',
            contextId: 'group-1',
        },
        resource: JSON.stringify({ command: 'create-group' }),
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'server-1',
            createdTs: Temporal.PlainDateTime.from('2026-07-22T11:59:00'),
            expiryTs: Temporal.Instant.from('2026-07-23T00:00:00Z'),
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            attempts,
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS),
        },
    };
}

function cloneState(state: AtomicState): AtomicState {
    return {
        mutations: new Map(state.mutations),
        outbox: new Map(state.outbox),
        inbox: new Map(state.inbox),
        results: new Map(state.results),
    };
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        1,
        1,
        1,
    );
}

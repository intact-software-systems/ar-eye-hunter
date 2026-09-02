import { Temporal } from '@js-temporal/polyfill';
import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxType, type AppInboxExecutionMetadata } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '@shared-server/rallar-system/app-inbox/app-inbox-persistence-ports.ts';
import type { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxQueueEntryWriter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxHandlerRegistration } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-registration.ts';
import { AppInboxHandlerRegistry } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';

import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { Reservator } from '@shared/queuebox/DequeueController.ts';
import {
    ResilienceDto,
    type ResourceInboxRetryExhaustion,
    type ResourceInboxRetryExhaustionRecovery
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, isExpiredResourceEntry, toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

const NOW_EPOCH_MS = Date.parse('2026-07-22T12:00:00.000Z');

interface RegisteredHandlerHarness {
    readonly enqueue: AppInboxEnqueueInput;
    readonly queue: RegisteredHandlerInbox;
    readonly readEntry: () => Promise<ResourceEntry | undefined>;
    readonly reader: InboxQueueReader;
    readonly results: RegisteredHandlerResults;
    readonly service: AtomicAppInboxService;
}

interface AtomicState {
    mutations: Map<string, JsonWireValue>;
    outbox: Map<string, JsonWireValue>;
    inbox: Map<string, ResourceEntry>;
    results: Map<string, ResourceEntry>;
}

interface AtomicHarness {
    readonly context: AppInboxExecutionMetadata;
    readonly database: AtomicDatabase;
    readonly entry: ResourceEntry;
    readonly service: AtomicAppInboxService;
}

interface AtomicResultRow {
    readonly ris_row_id: bigint;
    readonly ris_resource_id: string;
    readonly ris_topic_id: string;
    readonly ris_resource: string;
    readonly ris_type_id: string;
    readonly ris_status: EntityStatus;
    readonly fk_ext_bank_id: string;
    readonly system_date: string;
    readonly created_by: string;
    readonly created_ts: string;
    readonly expire_ts: string;
}

interface AtomicAppInboxDependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: AppInboxEntryRepository;
    readonly resourceInboxResultsRepository: AppInboxResultRepository;
    readonly database: PSqlSql;
}

interface AtomicAppInboxConfig {
    readonly serviceId: string;
    readonly defaultTopicId: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxOptions;
    readonly wakeOwningQueue?: () => void;
}

class AtomicAppInboxService {
    private readonly commandClient: AppInboxCommandClient;
    private readonly queueEntryWriter: AppInboxQueueEntryWriter;
    private readonly handlerRegistry: AppInboxHandlerRegistry;
    private readonly transactionWriter: AppInboxTransactionWriter;

    constructor(
        dependencies: AtomicAppInboxDependencies,
        config: AtomicAppInboxConfig
    ) {
        const clientRuntime = createAppInboxClientRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resourceInboxRepository: dependencies.resourceInboxRepository,
            resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
            serviceId: config.serviceId,
            defaultTopicId: config.defaultTopicId,
            timing: config.timing,
            options: config.options,
            wakeOwningQueue: config.wakeOwningQueue
        });
        this.commandClient = clientRuntime.commandClient;
        this.queueEntryWriter = clientRuntime.queueEntryWriter;
        const handlerRuntime = createAppInboxHandlerRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resultRepository: dependencies.resourceInboxResultsRepository,
            database: dependencies.database,
            serviceId: config.serviceId,
            timing: config.timing,
            options: config.options
        });
        this.handlerRegistry = handlerRuntime.registry;
        this.transactionWriter = handlerRuntime.transactionWriter;
    }

    async commit<R>(
        context: AppInboxExecutionMetadata,
        durableResult: R,
        write: (transaction: PSqlSql) => Promise<void>
    ): Promise<R> {
        const input = {
            ...this.transactionWriter.readCompletionFacts(context),
            status: EntityStatus.COMPLETED,
            durableResult
        };
        const computed = computeAppInboxCompletion(input);
        const issues = validateAppInboxCompletion(input, computed);
        if (issues.length > 0) {
            throw issues[0].cause;
        }
        return await this.transactionWriter.writeMutation(context, computed, write);
    }

    async fail(context: AppInboxExecutionMetadata, computed: AppInboxCompletionComputed<AppInboxFailure>): Promise<void> {
        await this.transactionWriter.writeTerminalFailure(context, computed);
    }

    onStateMessage<Result>(
        type: AppInboxType,
        handler: (
            data: JsonWireValue,
            context: AppInboxExecutionMetadata
        ) => Promise<Result>
    ): void {
        this.handlerRegistry.registerHandler({
            type,
            decodeCommand: (value) => value,
            encodeResult: (result) => decodeJsonWireValue(result, 'Test AppInbox result'),
            handle: handler
        });
    }

    registerHandler<Command, Result>(
        registration: AppInboxHandlerRegistration<Command, Result>
    ): void {
        this.handlerRegistry.registerHandler(registration);
    }

    assertRegistrationComplete(expectedTypes: readonly AppInboxType[]): void {
        this.handlerRegistry.assertRegistrationComplete(expectedTypes);
    }

    enqueueAndWait(
        input: AppInboxEnqueueInput
    ) {
        return this.commandClient.enqueueAndWait(input);
    }

    enqueueWithoutWaiting(input: AppInboxEnqueueInput): void {
        void this.queueEntryWriter.enqueue(input).catch((error) => {
            console.error('Error enqueueing test AppInbox command without waiting', error);
        });
    }
}

class RegisteredHandlerInbox extends InMemoryQueueBox {
    private latestKey: Key | undefined;
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();

    override async enqueue(entry: ResourceEntry): Promise<ResourceEntry | undefined> {
        this.latestKey = entry.key;
        return await super.enqueue(entry);
    }

    override async enqueueIfAbsent(entry: ResourceEntry): Promise<ResourceEntry> {
        this.latestKey = entry.key;
        return await super.enqueueIfAbsent(entry);
    }

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }

    async writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const key = toKeyAsString(placeholder.key);
        const active = this.materializations.get(key);
        if (active !== undefined) {
            return await active;
        }
        const pending = this.materializeEntry(placeholder, materialize);
        this.materializations.set(key, pending);
        try {
            return await pending;
        }
        finally {
            this.materializations.delete(key);
        }
    }

    private async materializeEntry(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const existing = await this.getItem(placeholder.key);
        if (existing !== undefined && !isExpiredResourceEntry(existing)) {
            return existing;
        }
        const materialized = await materialize();
        return await this.enqueueIfAbsent({ ...placeholder, resource: materialized.resource });
    }

    async readLatest(): Promise<ResourceEntry | undefined> {
        return this.latestKey ? await this.getItem(this.latestKey) : undefined;
    }
}

class RegisteredHandlerResults {
    readonly entries = new Map<string, ResourceEntry>();
    replaceCalls = 0;

    private readonly failResultWriteAfter?: number;

    constructor(failResultWriteAfter?: number) {
        this.failResultWriteAfter = failResultWriteAfter;
    }

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.replaceCalls += 1;
        if (this.failResultWriteAfter !== undefined && this.replaceCalls > this.failResultWriteAfter) {
            throw new Error('duplicate result write must not run');
        }
        this.entries.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        return this.entries.get(toKeyAsString(key));
    }
}

export function createRegisteredHandlerHarness(
    options: Readonly<{
        failResultWriteAfter?: number;
        timing?: (event: RallarTimingEvent) => void;
        topicId?: string;
    }> = {}
): RegisteredHandlerHarness {
    const queue = new RegisteredHandlerInbox();
    const results = new RegisteredHandlerResults(options.failResultWriteAfter);
    const reader = new InboxQueueReader(queue);
    const service = new AtomicAppInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: createAppInboxTestDatabase(queue, results)
        },
        {
            serviceId: 'server-1',
            defaultTopicId: 'app-inbox.group-state',
            timing: options.timing,
            options: {
                phaseTiming: true,
                waitMaxElapsedMsecs: 5_000,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 1,
                waitJitterRatio: 0
            }
        }
    );
    const enqueue = createRegisteredHandlerEnqueue(options.topicId ?? 'app-inbox.group-state');
    return {
        enqueue,
        queue,
        readEntry: async () => await queue.readLatest(),
        reader,
        results,
        service
    };
}

function createRegisteredHandlerEnqueue(topicId: string): AppInboxEnqueueInput {
    return {
        type: AppInboxType.GROUP_CREATE,
        topicId,
        resourceId: 'registered-handler-request',
        contextId: 'group-1',
        authority: {
            authorityProof: {
                version: 1,
                principalId: 'principal-1',
                sessionId: 'session-1',
                sessionIssuedAtEpochMs: NOW_EPOCH_MS - 1_000,
                sessionExpiresAtEpochMs: NOW_EPOCH_MS + 60_000,
                commandMac: '0'.repeat(64)
            },
            descriptor: {
                operation: 'createGroup',
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
                groupId: 'group-1',
                targetPrincipalId: null,
                sessionId: null,
                request: {
                    groupId: 'group-1',
                    displayName: 'Group 1',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'principal-1',
                    actorPrincipalId: 'principal-1',
                    actorSessionId: 'session-1',
                    requestId: 'registered-handler-request'
                }
            }
        },
        data: { requestId: 'registered-handler-request' }
    } as const;
}

export async function waitForRegisteredHandlerEntry(
    queue: RegisteredHandlerInbox
): Promise<ResourceEntry> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const entry = await queue.readLatest();
        if (entry) {
            return entry;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Expected registered handler entry');
}

export function toRegisteredHandlerIdentityResource(
    entry: ResourceEntry,
    identity: Readonly<{
        outerType: string;
        nested:
            | Readonly<{ kind: 'operation'; type: string; }>
            | Readonly<{ kind: 'missing'; }>
            | Readonly<{ kind: 'corrupt'; }>;
    }>
): string {
    const message = JSON.parse(entry.resource) as {
        payload: { typeId: string; resource: string; };
    };
    message.payload.typeId = identity.outerType;
    if (identity.nested.kind === 'corrupt') {
        message.payload.resource = '{"secret":"nested-password"';
        return JSON.stringify(message);
    }
    const nestedCommand = JSON.parse(message.payload.resource) as {
        type?: string;
    };
    if (identity.nested.kind === 'missing') {
        delete nestedCommand.type;
    }
    else {
        nestedCommand.type = identity.nested.type;
    }
    message.payload.resource = JSON.stringify(nestedCommand);
    return JSON.stringify(message);
}

class AtomicDatabase {
    state: AtomicState;
    beginCalls = 0;
    activeTransaction: PSqlSql | undefined;
    private working: AtomicState | undefined;
    loseReservation: boolean;

    readonly sql: PSqlSql;

    private readonly options: Readonly<{
        failResultWrite: boolean;
        loseReservation: boolean;
    }>;

    constructor(
        entry: ResourceEntry,
        options: Readonly<{
            failResultWrite: boolean;
            loseReservation: boolean;
        }>
    ) {
        this.options = options;
        this.loseReservation = options.loseReservation;
        this.state = {
            mutations: new Map(),
            outbox: new Map(),
            inbox: new Map([[toKeyAsString(entry.key), entry]]),
            results: new Map()
        };
        const sql = (async (_stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]) => {
            throw new Error('Unexpected raw SQL in atomic test database');
        }) as PSqlSql;
        sql.begin = async <T>(write: (transaction: PSqlSql) => Promise<T>) => {
            this.beginCalls += 1;
            const transaction = (async (strings: TemplateStringsArray, ...values: readonly PSqlParameter[]) => {
                return this.executeTransactionSql(strings, values);
            }) as PSqlSql;
            transaction.begin = async () => {
                throw new Error('Nested transaction');
            };
            this.activeTransaction = transaction;
            this.working = cloneState(this.state);
            try {
                const result = await write(transaction);
                this.state = this.working;
                return result;
            }
            finally {
                this.activeTransaction = undefined;
                this.working = undefined;
            }
        };
        this.sql = sql;
    }

    private executeTransactionSql(strings: TemplateStringsArray, values: readonly PSqlParameter[]): ReturnType<PSqlSql> {
        const query = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
        if (query.includes('insert into resource_inbox_results')) {
            if (this.options.failResultWrite) {
                throw new Error('result write failed');
            }
            const result = toAtomicResultEntry(values);
            this.requireWorking().results.set(toKeyAsString(result.key), result);
            return [toAtomicResultRow(result)];
        }
        if (query.includes('update resource_inbox') && query.includes('ri_status = \'reserved\'')) {
            return this.finishReservation(values);
        }
        throw new Error(`Unexpected raw transaction SQL in atomic test database: ${query}`);
    }

    private finishReservation(values: readonly PSqlParameter[]): ReturnType<PSqlSql> {
        const [status, completedAt, topicId, resourceId, contextId, attempts] = values as [
            EntityStatus,
            Date,
            string,
            string,
            string,
            number
        ];
        if (this.loseReservation) {
            return [];
        }
        const key = toKeyAsString({ topicId, resourceId, contextId });
        const stored = this.requireWorking().inbox.get(key);
        if (
            !stored ||
            stored.status !== EntityStatus.RESERVED ||
            stored.dequeueAudit.attempts !== attempts
        ) {
            return [];
        }
        this.requireWorking().inbox.set(key, {
            ...stored,
            status,
            dequeueAudit: {
                ...stored.dequeueAudit,
                endTs: Temporal.Instant.fromEpochMilliseconds(completedAt.getTime()),
                nextTs: undefined
            }
        });
        return [{ ri_row_id: 1n }];
    }

    writeMutation(key: string, value: JsonWireValue): void {
        this.requireWorking().mutations.set(key, value);
    }

    writeOutbox(key: string, value: JsonWireValue): void {
        this.requireWorking().outbox.set(key, value);
    }

    reclaimFinalization(): ResourceEntry {
        const [key, entry] = [...this.state.inbox.entries()][0] ?? [];
        if (!key || !entry) {
            throw new Error('Missing finalization entry');
        }
        const reclaimed: ResourceEntry = {
            ...entry,
            dequeueAudit: {
                attempts: entry.dequeueAudit.attempts + 1,
                startTs: Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS),
                endTs: undefined,
                nextTs: undefined
            }
        };
        this.state.inbox.set(key, reclaimed);
        return reclaimed;
    }

    private requireWorking(): AtomicState {
        if (!this.working) {
            throw new Error('Write occurred without active transaction');
        }
        return this.working;
    }
}

export function createAtomicHarness(
    options: Readonly<{
        attempts?: number;
        entryResource?: string;
        entryTopicId?: string;
        failResultWrite?: boolean;
        loseReservation?: boolean;
        timing?: (event: RallarTimingEvent) => void;
    }> = {}
): AtomicHarness {
    const baseEntry = createReservedEntry(options.attempts ?? 7);
    const entry = {
        ...baseEntry,
        key: {
            ...baseEntry.key,
            topicId: options.entryTopicId ?? baseEntry.key.topicId
        },
        resource: options.entryResource ?? baseEntry.resource
    };
    const database = new AtomicDatabase(entry, {
        failResultWrite: options.failResultWrite ?? false,
        loseReservation: options.loseReservation ?? false
    });
    const queue = new RegisteredHandlerInbox();
    const reader = new InboxQueueReader(queue);
    const results = new RegisteredHandlerResults();
    const service = new AtomicAppInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: database.sql
        },
        {
            serviceId: 'server-1',
            defaultTopicId: 'app-inbox.group-state',
            timing: options.timing,
            options: {
                phaseTiming: true,
                nowEpochMs: () => NOW_EPOCH_MS
            }
        }
    );
    const context = createAtomicExecutionMetadata(entry);
    return { context, database, entry, service };
}

function createAtomicExecutionMetadata(entry: ResourceEntry): AppInboxExecutionMetadata {
    const enqueue = {
        type: AppInboxType.GROUP_CREATE,
        resourceId: entry.key.resourceId,
        contextId: entry.key.contextId,
        data: { requestId: entry.key.resourceId }
    } as const;
    return {
        enqueue,
        message: newALUntargetedMessage(
            'server-1',
            newALRoute(entry.key.topicId, entry.key.contextId, entry.key.resourceId),
            enqueue.type,
            enqueue
        ),
        entry
    };
}

function toAtomicResultEntry(values: readonly PSqlParameter[]): ResourceEntry {
    const [
        resourceId,
        topicId,
        resource,
        typeId,
        status,
        contextId,
        ,
        createdBy,
        createdTs,
        expiryTs
    ] = values;
    return {
        key: { resourceId, topicId, contextId } as Key,
        resource: resource as string,
        typeId: typeId as string,
        status: status as EntityStatus,
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: createdBy as string,
            createdTs: Temporal.PlainDateTime.from(String(createdTs).replace(/Z$/u, '')),
            expiryTs: String(expiryTs).endsWith('Z')
                ? Temporal.Instant.from(expiryTs as string)
                : Temporal.PlainDateTime.from(expiryTs as string)
                    .toZonedDateTime('UTC')
                    .toInstant()
        },
        dequeueAudit: { attempts: 0 }
    };
}

function toAtomicResultRow(entry: ResourceEntry): AtomicResultRow {
    return {
        ris_row_id: 1n,
        ris_resource_id: entry.key.resourceId,
        ris_topic_id: entry.key.topicId,
        ris_resource: entry.resource,
        ris_type_id: entry.typeId,
        ris_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toZonedDateTimeISO('UTC').toPlainDateTime().toString()
    };
}

function createReservedEntry(attempts: number): ResourceEntry {
    const enqueue = {
        type: AppInboxType.GROUP_CREATE,
        resourceId: 'request-1',
        contextId: 'group-1',
        data: { requestId: 'request-1' }
    };
    return {
        key: {
            topicId: 'app-inbox.group-state',
            resourceId: 'request-1',
            contextId: 'group-1'
        },
        resource: JSON.stringify({
            payload: {
                typeId: AppInboxType.GROUP_CREATE,
                resource: JSON.stringify(enqueue)
            }
        }),
        typeId: EnqueuedType.APP_INBOX,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'server-1',
            createdTs: Temporal.PlainDateTime.from('2026-07-22T11:59:00'),
            expiryTs: Temporal.Instant.from('2026-07-23T00:00:00Z')
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            attempts,
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW_EPOCH_MS)
        }
    };
}

export function toPersistedAppInboxResource(
    options: Readonly<{
        outerType?: string;
        nestedType?: string;
    }>
): string {
    const command = options.nestedType === undefined
        ? { data: { secret: 'nested-password' } }
        : { type: options.nestedType, data: { secret: 'nested-password' } };
    const payload = options.outerType === undefined
        ? { resource: JSON.stringify(command) }
        : { typeId: options.outerType, resource: JSON.stringify(command) };
    return JSON.stringify({ payload });
}

export function toRecovery(
    entry: ResourceEntry,
    reservationAttempt: number
): ResourceInboxRetryExhaustionRecovery {
    return {
        entry,
        processingAttempts: 20,
        reservationAttempt,
        lane: Reservator.FINALIZATION,
        classification: 'retryable',
        exhausted: true,
        failure: { source: 'finalization-recovery' },
        queueAgeMs: 60_000,
        dueAgeMs: 300_000,
        selectedDueAtEpochMs: NOW_EPOCH_MS - 300_000,
        finalizedAtEpochMs: NOW_EPOCH_MS
    };
}

export function toExhaustion(entry: ResourceEntry): ResourceInboxRetryExhaustion {
    return {
        entry,
        processingAttempts: 20,
        reservationAttempt: 20,
        lane: Reservator.NEW,
        classification: 'retryable',
        exhausted: true,
        failure: {
            source: 'processing',
            error: Object.assign(new Error('retryable conflict'), {
                code: 'runtime-state-write-conflict'
            })
        },
        queueAgeMs: 60_000,
        dueAgeMs: 0,
        exhaustedAtEpochMs: NOW_EPOCH_MS
    };
}

function cloneState(state: AtomicState): AtomicState {
    return {
        mutations: new Map(state.mutations),
        outbox: new Map(state.outbox),
        inbox: new Map(state.inbox),
        results: new Map(state.results)
    };
}

export function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        1,
        1,
        1
    );
}

import { Temporal } from '@js-temporal/polyfill';

import type {
    PSqlParameter,
    PSqlRows,
    PSqlSql
} from '@shared-server/postgres/p-sql-sql.ts';
import { decodeAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxType, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '@shared-server/rallar-system/app-inbox/app-inbox-persistence-ports.ts';
import type { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxQueueEntryWriter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import type { AppInboxHandlerRegistration } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-registration.ts';
import { AppInboxHandlerRegistry } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { Reservator } from '@shared/queuebox/DequeueController.ts';
import {
    ResilienceDto,
    type ResourceInboxRetryExhaustion,
    type ResourceInboxRetryExhaustionRecovery
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

const NOW_EPOCH_MS = Date.parse('2026-07-22T12:00:00.000Z');

interface RegisteredHandlerHarness {
    readonly enqueue: AppInboxMessageContext<JsonWireValue>['enqueue'];
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
    readonly context: AppInboxMessageContext<JsonWireValue>;
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

namespace AtomicAppInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxEntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
    }

    export interface Config {
        readonly serviceId: string;
        readonly defaultTopicId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }
}

class AtomicAppInboxService {
    private readonly commandClient: AppInboxCommandClient;
    private readonly queueEntryWriter: AppInboxQueueEntryWriter;
    private readonly handlerRegistry: AppInboxHandlerRegistry;
    private readonly transactionWriter: AppInboxTransactionWriter;

    constructor(
        dependencies: AtomicAppInboxService.Dependencies,
        config: AtomicAppInboxService.Config
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
        context: AppInboxMessageContext<R>,
        write: (transaction: PSqlSql) => Promise<R>
    ): Promise<R> {
        return await this.transactionWriter.writeMutation(context, write);
    }

    async fail(context: AppInboxMessageContext<JsonWireValue>, error: JsonWireValue): Promise<void> {
        await this.transactionWriter.writeTerminalFailure(context, error);
    }

    onStateMessage<Result>(
        type: AppInboxType,
        handler: (
            data: JsonWireValue,
            context: AppInboxMessageContext<Result>
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
    ): Promise<Either<AppInboxFailure, JsonWireValue>> {
        return this.commandClient.enqueueAndWait(input);
    }

    enqueueWithoutWaiting(input: AppInboxMessageContext<JsonWireValue>['enqueue']): void {
        void this.queueEntryWriter.enqueue(input).catch((caught) => {
            const error = toError(caught);
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

interface RegisteredHandlerOptions {
    readonly failResultWriteAfter?: number;
    readonly timing?: RallarTimingSink;
    readonly topicId?: string;
}

export function createRegisteredHandlerHarness(
    options: RegisteredHandlerOptions = {}
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
    const enqueue = createRegisteredHandlerCommand(options.topicId);
    return {
        enqueue,
        queue,
        readEntry: async () => await queue.readLatest(),
        reader,
        results,
        service
    };
}

function createRegisteredHandlerCommand(topicId?: string): AppInboxEnqueueInput {
    return {
        type: AppInboxType.GROUP_CREATE,
        topicId: topicId ?? 'app-inbox.group-state',
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
    };
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

interface RegisteredHandlerOperationIdentity {
    readonly kind: 'operation';
    readonly type: string;
}

interface RegisteredHandlerIdentity {
    readonly outerType: string;
    readonly nested:
        | RegisteredHandlerOperationIdentity
        | { readonly kind: 'missing'; }
        | { readonly kind: 'corrupt'; };
}

export function toRegisteredHandlerIdentityResource(
    entry: ResourceEntry,
    identity: RegisteredHandlerIdentity
): string {
    const message = decodePersistedALMessage(entry.resource);
    const command = decodeAppInboxEnqueue(JSON.parse(message.payload.resource));
    const { type: _type, ...withoutType } = command;
    const resource = identity.nested.kind === 'corrupt'
        ? '{"secret":"nested-password"'
        : JSON.stringify(
            identity.nested.kind === 'missing'
                ? withoutType
                : { ...command, type: identity.nested.type }
        );
    return JSON.stringify({
        ...message,
        payload: { ...message.payload, typeId: identity.outerType, resource }
    });
}

namespace AtomicDatabase {
    export interface Options {
        readonly failResultWrite: boolean;
        readonly loseReservation: boolean;
    }
}

class AtomicDatabase {
    state: AtomicState;
    beginCalls = 0;
    activeTransaction: PSqlSql | undefined;
    private working: AtomicState | undefined;
    loseReservation: boolean;

    readonly sql: PSqlSql;

    private readonly options: AtomicDatabase.Options;

    constructor(
        entry: ResourceEntry,
        options: AtomicDatabase.Options
    ) {
        this.options = options;
        this.loseReservation = options.loseReservation;
        this.state = {
            mutations: new Map(),
            outbox: new Map(),
            inbox: new Map([[toKeyAsString(entry.key), entry]]),
            results: new Map()
        };
        this.sql = this.createSql(false);
    }

    private createSql(transactional: boolean): PSqlSql {
        const execute = (strings: TemplateStringsArray, values: readonly PSqlParameter[]): PSqlRows => {
            if (!transactional) {
                throw new Error('Unexpected raw SQL in atomic test database');
            }
            return this.executeSql(strings, values);
        };
        function sql(values: readonly PSqlParameter[]): object;
        function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
        function sql<Result>(
            stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
            ...values: readonly PSqlParameter[]
        ): object | Promise<Result> {
            if (!('raw' in stringsOrValues)) {
                return { values: stringsOrValues };
            }
            // The generic row result belongs to the native SQL query boundary.
            return Promise.resolve().then(() => execute(stringsOrValues, values) as Result);
        }
        return Object.assign(sql, {
            begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
                if (transactional) {
                    throw new Error('Nested transaction');
                }
                return await this.withTransaction(write);
            }
        });
    }

    private async withTransaction<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> {
        this.beginCalls += 1;
        const transaction = this.createSql(true);
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
    }

    private executeSql(strings: TemplateStringsArray, values: readonly PSqlParameter[]): PSqlRows {
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
            return this.finalizeReservation(values);
        }
        throw new Error(`Unexpected raw transaction SQL in atomic test database: ${query}`);
    }

    private finalizeReservation(values: readonly PSqlParameter[]): PSqlRows {
        const [status, completedAt, topicId, resourceId, contextId, attempts] = values;
        if (
            (status !== EntityStatus.COMPLETED && status !== EntityStatus.FAILED) ||
            !(completedAt instanceof Date) || typeof topicId !== 'string' ||
            typeof resourceId !== 'string' || typeof contextId !== 'string' || typeof attempts !== 'number'
        ) {
            throw new TypeError('Invalid atomic reservation SQL parameters');
        }
        if (this.loseReservation) {
            return [];
        }
        const key = toKeyAsString({ topicId, resourceId, contextId });
        const stored = this.requireWorking().inbox.get(key);
        if (!stored || stored.status !== EntityStatus.RESERVED || stored.dequeueAudit.attempts !== attempts) {
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

interface AtomicHarnessOptions {
    readonly attempts?: number;
    readonly entryResource?: string;
    readonly entryTopicId?: string;
    readonly failResultWrite?: boolean;
    readonly loseReservation?: boolean;
    readonly timing?: RallarTimingSink;
}

export function createAtomicHarness(
    options: AtomicHarnessOptions = {}
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

    const enqueue: AppInboxEnqueueInput = {
        type: AppInboxType.GROUP_CREATE,
        resourceId: entry.key.resourceId,
        contextId: entry.key.contextId,
        data: { requestId: entry.key.resourceId }
    };
    const context: AppInboxMessageContext<JsonWireValue> = {
        enqueue,
        message: newALUntargetedMessage(
            'server-1',
            newALRoute(entry.key.topicId, entry.key.contextId, entry.key.resourceId),
            enqueue.type,
            enqueue
        ),
        entry,
        encodeResult: (result) => result
    };
    return { context, database, entry, service };
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
    if (
        typeof resourceId !== 'string' || typeof topicId !== 'string' || typeof contextId !== 'string' ||
        typeof resource !== 'string' || typeof typeId !== 'string' || typeof createdBy !== 'string' ||
        typeof createdTs !== 'string' || typeof expiryTs !== 'string' ||
        (status !== EntityStatus.COMPLETED && status !== EntityStatus.FAILED)
    ) {
        throw new TypeError('Invalid atomic result SQL parameters');
    }
    return {
        key: { resourceId, topicId, contextId },
        resource: resource,
        typeId: typeId,
        status: status,
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: createdBy,
            createdTs: Temporal.PlainDateTime.from(String(createdTs).replace(/Z$/u, '')),
            expiryTs: String(expiryTs).endsWith('Z')
                ? Temporal.Instant.from(expiryTs)
                : Temporal.PlainDateTime.from(expiryTs)
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
    const enqueue: AppInboxEnqueueInput = {
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

interface PersistedAppInboxResourceOptions {
    readonly outerType?: string;
    readonly nestedType?: string;
}

export function toPersistedAppInboxResource(
    options: PersistedAppInboxResourceOptions
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

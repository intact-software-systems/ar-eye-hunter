import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { PSqlSql, PSqlTransactionWrite } from '../postgres/p-sql-sql.ts';
import {
    AppInboxCommandIdentityError,
    validateAppInboxCommandIdentity
} from '../rallar-system/app-inbox/app-inbox-command-identity.ts';
import {
    AppInboxIdempotencyConflictError,
    isAppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '../rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '../rallar-system/app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '../rallar-system/app-inbox/app-inbox-options.ts';
import type {
    AppInboxEntryRepository,
    AppInboxResultRepository
} from '../rallar-system/app-inbox/app-inbox-persistence-ports.ts';
import type { AppInboxResultWaiter } from '../rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import {
    createAppInboxClientRuntime,
    type AppInboxClientRuntime
} from '../rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '../rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import {
    createAppInboxHandlerRuntime,
    type AppInboxHandlerRuntime
} from '../rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import type { RallarTimingSink } from '../rallar-system/observability/timing.ts';
import {
    computeMutationCommandDigest,
    decodeJsonWireText,
    encodeJsonWireValue,
    serializeCanonicalMutationCommand,
    type JsonWireValue
} from '../rallar-system/protocol/json-wire-identity.ts';

export namespace RallarServerAppInbox {
    export interface EntryRepository extends AppInboxEntryRepository {
        findByKey(key: Key): Promise<ResourceEntry | null | undefined>;
    }

    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: EntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
        readonly wakeOwningQueue: () => void;
    }

    export interface Config {
        readonly serviceId: string;
        readonly options: AppInboxOptions;
        readonly timing?: RallarTimingSink;
    }

    export interface Binding {
        readonly contextId: string;
        readonly resourceId: string;
    }

    export interface Registration<Command, Result> {
        readonly type: `app:${string}:${string}`;
        readonly decodeCommand: (value: JsonWireValue) => Command;
        readonly encodeCommand: (command: Command) => JsonWireValue;
        readonly toBinding: (command: Command) => Binding;
        /** Caller semantics, including scope and authority, before volatile winner facts. */
        readonly toLogicalCommand: (command: Command) => JsonWireValue;
        /**
         * Exactly once for the reservation winner. Bounded clock/ID capture and row construction only;
         * synchronous, no external I/O, scheduling, caller mutation or nested transactions.
         * External proposals must already be present in the command, computed after readReplay misses.
         */
        readonly materialize: (command: Command) => Command;
        readonly encodeResult: (result: Result) => JsonWireValue;
        readonly decodeResult: (value: JsonWireValue) => Result;
        /** One delivery, one full read -> compute -> validate -> commit attempt. QueueBox owns retries. */
        readonly handle: (command: Command, context: AppInboxMessageContext<Result>) => Promise<Result>;
    }

    export interface Operation<Command, Result> {
        submit(command: Command): Promise<Either<AppInboxFailure, Result>>;
        /** A validated miss permits external proposal work; concurrent misses may each compute a proposal. */
        readReplay(command: Command): Promise<Either<AppInboxFailure, Result> | undefined>;
    }
}

/** Application registration/admission policy over the existing AppInbox reservation, worker and transaction owners. */
export class RallarServerAppInbox {
    private readonly entries: RallarServerAppInbox.EntryRepository;
    private readonly client: AppInboxClientRuntime;
    private readonly handlers: AppInboxHandlerRuntime;
    private readonly activeContexts = new WeakSet<object>();
    private state: 'registering' | 'running' | 'stopped' = 'registering';

    constructor(dependencies: RallarServerAppInbox.Dependencies, config: RallarServerAppInbox.Config) {
        this.entries = dependencies.resourceInboxRepository;
        const results: AppInboxResultRepository = {
            replace: (entry) => dependencies.resourceInboxResultsRepository.replace(entry),
            findByKey: (key) => readBoundResult(dependencies.resourceInboxResultsRepository, key)
        };
        this.client = createAppInboxClientRuntime({
            ...dependencies,
            ...config,
            resourceInboxResultsRepository: results,
            defaultTopicId: ''
        });
        this.handlers = createAppInboxHandlerRuntime({
            ...dependencies,
            ...config,
            resultRepository: results
        });
    }

    register<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>
    ): RallarServerAppInbox.Operation<Command, Result> {
        if (this.state !== 'registering') {
            throw new Error('Application AppInbox registration is sealed');
        }
        if (
            !registration.type.startsWith('app:') || !isAppInboxType(registration.type) || registration.type.length > 36
        ) {
            throw new TypeError('Application AppInbox operation must be a namespaced topic of at most 36 characters');
        }
        const registered = Object.freeze({ ...registration });
        this.handlers.registry.registerHandler({
            type: registered.type,
            decodeCommand: registered.decodeCommand,
            encodeResult: registered.encodeResult,
            handle: (command, context) => this.runRegisteredAttempt(registered, command, context)
        });
        return Object.freeze({
            submit: (command: Command) => this.submit(registered, command),
            readReplay: (command: Command) => this.readReplay(registered, command)
        });
    }

    /** Seals every local registration before the existing runtime starts its workers. */
    start(): void {
        if (this.state === 'stopped') {
            throw new Error('Application AppInbox is stopped');
        }
        this.state = 'running';
    }

    /** Closes admission; existing runtime shutdown owns draining/stopping workers and closing persistence. */
    stop(): void {
        this.state = 'stopped';
    }

    /** Encodes the exact result before entry; resolves only after domain writes and durable completion commit together. */
    async commit<Result>(
        context: AppInboxMessageContext<Result>,
        result: Result,
        write: PSqlTransactionWrite<void>
    ): Promise<Result> {
        if (!this.activeContexts.has(context)) {
            throw new TypeError('Application AppInbox commit requires its active registered attempt');
        }
        const completionInput = {
            ...this.handlers.transactionWriter.readCompletionFacts(context),
            status: EntityStatus.COMPLETED,
            durableResult: encodeJsonWireValue(context.encodeResult(result), 'Application AppInbox result')
        } as const;
        const completion = computeAppInboxCompletion(completionInput);
        const issues = validateAppInboxCompletion(completionInput, completion);
        if (issues[0]) {
            throw issues[0].cause;
        }
        await this.handlers.transactionWriter.writeComputedMutation(context, completion, write);
        return result;
    }

    private async runRegisteredAttempt<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        command: Command,
        context: AppInboxMessageContext<Result>
    ): Promise<Result> {
        const enqueue = toRegisteredEnqueue(registration, command);
        assertRegisteredEntry(registration, context.entry, enqueue);
        Object.freeze(context);
        this.activeContexts.add(context);
        try {
            const result = await registration.handle(command, context);
            if (this.handlers.transactionWriter.read(context).state !== 'transaction-finalized') {
                throw new TypeError('Application AppInbox handler returned without committing its mutation');
            }
            return result;
        }
        finally {
            this.activeContexts.delete(context);
        }
    }

    private async submit<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        command: Command
    ): Promise<Either<AppInboxFailure, Result>> {
        this.requireRunning();
        const received = toRegisteredEnqueue(registration, command);
        const retained = await this.readRetained(registration, received);
        if (retained) {
            return await this.client.resultWaiter.waitForResult(retained, registration.decodeResult);
        }
        this.requireRunning();
        const reservation = await this.client.reservationClient.reserveMaterializedEntry(received, async () => {
            const decoded = registration.decodeCommand(received.data);
            const materialized = toRegisteredEnqueue(registration, registration.materialize(decoded));
            assertMatchingRegisteredCommand(received, materialized);
            return materialized;
        });
        assertRegisteredEntry(registration, reservation.entry, received);
        return await this.client.resultWaiter.waitForResult(reservation, registration.decodeResult);
    }

    private async readReplay<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        command: Command
    ): Promise<Either<AppInboxFailure, Result> | undefined> {
        this.requireRunning();
        const retained = await this.readRetained(registration, toRegisteredEnqueue(registration, command));
        return retained ? await this.client.resultWaiter.waitForResult(retained, registration.decodeResult) : undefined;
    }

    private async readRetained<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        received: AppInboxEnqueueInput
    ): Promise<AppInboxResultWaiter.Wait | undefined> {
        const key = toRegisteredKey(received);
        const entry = await this.entries.findByKey(key);
        if (!entry) {
            return undefined;
        }
        const enqueue = assertRegisteredEntry(registration, entry, received);
        return { enqueue, key, winner: false };
    }

    private requireRunning(): void {
        if (this.state !== 'running') {
            throw Object.assign(new Error('Application AppInbox is not accepting commands'), {
                code: 'app-inbox-lifecycle-rejected'
            });
        }
    }
}

function toRegisteredEnqueue<Command, Result>(
    registration: RallarServerAppInbox.Registration<Command, Result>,
    command: Command
): AppInboxEnqueueInput {
    const data = decodeJsonWireText(JSON.stringify(encodeJsonWireValue(registration.encodeCommand(command))));
    const decoded = registration.decodeCommand(data);
    const binding = registration.toBinding(decoded);
    for (const value of [binding.contextId, binding.resourceId]) {
        if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
            throw new TypeError('Application AppInbox scope and request keys must contain 1 to 128 characters');
        }
    }
    return {
        type: registration.type,
        topicId: registration.type,
        contextId: binding.contextId,
        resourceId: binding.resourceId,
        authority: encodeJsonWireValue(registration.toLogicalCommand(decoded)),
        data
    };
}

function toRegisteredKey(enqueue: AppInboxEnqueueInput): Key {
    if (!enqueue.resourceId || !enqueue.topicId) {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    return { topicId: enqueue.topicId, resourceId: enqueue.resourceId, contextId: enqueue.contextId };
}

function assertRegisteredEntry<Command, Result>(
    registration: RallarServerAppInbox.Registration<Command, Result>,
    entry: ResourceEntry,
    received: AppInboxEnqueueInput
): AppInboxEnqueueInput {
    const identity = validateAppInboxCommandIdentity(entry);
    const message = decodePersistedALMessage(entry.resource);
    if (!identity.valid || entry.typeId !== 'APP_INBOX') {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    const stored = identity.command;
    const projected = toRegisteredEnqueue(registration, registration.decodeCommand(stored.data));
    const key = toRegisteredKey(projected);
    const route = message.route;
    if (
        !sameKey(entry.key, key) || !sameKey(entry.key, toRegisteredKey(received)) ||
        stored.type !== registration.type || !sameKey(toRegisteredKey(stored), key) ||
        route?.topicId !== key.topicId || route.contextId !== key.contextId || route.resourceId !== key.resourceId ||
        serializeCanonicalMutationCommand(stored.authority ?? null) !==
            serializeCanonicalMutationCommand(projected.authority ?? null)
    ) {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    assertMatchingRegisteredCommand(received, projected);
    return stored;
}

function assertMatchingRegisteredCommand(received: AppInboxEnqueueInput, existing: AppInboxEnqueueInput): void {
    const receivedIdentity = { type: received.type, ...toRegisteredKey(received), logical: received.authority ?? null };
    const existingIdentity = { type: existing.type, ...toRegisteredKey(existing), logical: existing.authority ?? null };
    if (serializeCanonicalMutationCommand(receivedIdentity) !== serializeCanonicalMutationCommand(existingIdentity)) {
        throw new AppInboxIdempotencyConflictError(
            received.resourceId ?? '',
            computeMutationCommandDigest(existingIdentity),
            computeMutationCommandDigest(receivedIdentity)
        );
    }
}

function sameKey(left: Key, right: Key): boolean {
    return left.topicId === right.topicId && left.contextId === right.contextId && left.resourceId === right.resourceId;
}

async function readBoundResult(repository: AppInboxResultRepository, key: Key): Promise<ResourceEntry | undefined> {
    const result = await repository.findByKey(key);
    if (result && (!sameKey(result.key, key) || result.typeId !== 'APP_INBOX')) {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    return result;
}

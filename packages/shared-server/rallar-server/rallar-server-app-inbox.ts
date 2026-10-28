import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { newALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { PSqlSql, PSqlTransactionWrite } from '../postgres/p-sql-sql.ts';
import {
    AppInboxCommandIdentityError,
    validateAppInboxCommandIdentity
} from '../rallar-system/app-inbox/app-inbox-command-identity.ts';
import {
    AppInboxIdempotencyConflictError,
    isAppInboxType,
    type AppInboxEnqueue,
    type AppInboxMessageContext
} from '../rallar-system/app-inbox/app-inbox-contracts.ts';
import { toTerminalAppInboxFailure, type AppInboxFailure } from '../rallar-system/app-inbox/app-inbox-failure.ts';
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
        /** Synchronous scheduling signal. A failure propagates without rolling back the durable admission. */
        readonly wakeOwningQueue: () => void;
    }

    export interface Config {
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
        readonly options: AppInboxOptions;
        readonly timing?: RallarTimingSink;
    }

    export interface Binding {
        readonly contextId: string;
        readonly resourceId: string;
    }

    /** Existing canonical application envelope; optional fields follow the persisted AppInbox wire contract. */
    export interface Envelope {
        readonly data: JsonWireValue;
        readonly authority?: JsonWireValue;
        readonly senderId?: string;
    }

    export interface Registration<Command, Result> {
        readonly type: `app:${string}:${string}`;
        /** Owns the canonical data/authority/sender representation, including cross-field binding validation. */
        readonly decodeEnvelope: (envelope: Envelope) => Command;
        readonly encodeEnvelope: (command: Command) => Envelope;
        readonly toBinding: (command: Command) => Binding;
        /** Logical caller semantics and authorization identity, independent of captured envelope facts. */
        readonly toLogicalCommand: (command: Command) => JsonWireValue;
        /**
         * Exactly once for the reservation winner. Bounded clock/ID capture and row construction only;
         * synchronous, no external I/O, scheduling, caller mutation or nested transactions.
         * External proposals must already be present in the command, computed after readReplay misses.
         */
        readonly materialize: (command: Command) => Command;
        readonly encodeResult: (result: Result) => JsonWireValue;
        /** Validates the exact stored result against the validated retained winner, including its captured facts. */
        readonly decodeResult: (value: JsonWireValue, command: Command) => Result;
        /** One delivery, one full read -> compute -> validate -> commit attempt. QueueBox owns retries. */
        readonly handle: (command: Command, context: AppInboxMessageContext<Result>) => Promise<Result>;
    }

    /** Wait is bound to the actual validated retained winner; callers cannot supply or replace its command. */
    export interface Admission<Result> {
        wait(): Promise<Either<AppInboxFailure, Result>>;
    }

    /** Admission/idempotency policy failures are Left values; corrupt invariants and unexpected exceptions remain distinct. */
    export interface Operation<Command, Result> {
        /** Returns validated durable admission after waking its owning queue; execution is not awaited. */
        enqueue(command: Command): Promise<Either<AppInboxFailure, Admission<Result>>>;
        /** Returns retained pending/completed admission immediately; only a validated miss permits proposal work. */
        readAdmission(command: Command): Promise<Either<AppInboxFailure, Admission<Result>> | undefined>;
        submit(command: Command): Promise<Either<AppInboxFailure, Result>>;
        /** A validated miss permits external proposal work; concurrent misses may each compute a proposal. */
        readReplay(command: Command): Promise<Either<AppInboxFailure, Result> | undefined>;
    }
}

/** Application registration/admission policy over the existing AppInbox reservation, worker and transaction owners. */
export class RallarServerAppInbox {
    private readonly entries: RallarServerAppInbox.EntryRepository;
    private readonly wakeOwningQueue: () => void;
    private readonly client: AppInboxClientRuntime;
    private readonly handlers: AppInboxHandlerRuntime;
    private readonly activeContexts = new WeakSet<object>();
    private state: 'registering' | 'running' | 'stopped' = 'registering';

    constructor(dependencies: RallarServerAppInbox.Dependencies, config: RallarServerAppInbox.Config) {
        this.entries = dependencies.resourceInboxRepository;
        this.wakeOwningQueue = dependencies.wakeOwningQueue;
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
            decodeCommand: (data: JsonWireValue) => data,
            encodeResult: registered.encodeResult,
            handle: (_data, context) => this.runRegisteredAttempt(registered, context)
        });
        return Object.freeze({
            enqueue: (command: Command) => this.enqueue(registered, command),
            readAdmission: (command: Command) => this.readAdmission(registered, command),
            submit: (command: Command) => this.submit(registered, command),
            readReplay: (command: Command) => this.readReplay(registered, command)
        });
    }

    /** Seals every local registration before the existing runtime starts its workers. */
    start(): void {
        if (this.state === 'stopped') {
            throw new Error('Application AppInbox is stopped');
        }
        this.handlers.registry.sealRegistrations();
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
        context: AppInboxMessageContext<Result>
    ): Promise<Result> {
        const command = registration.decodeEnvelope(context.enqueue);
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
        const admission = await this.enqueue(registration, command);
        return admission.left ? Either.ofLeft(admission.left) : await admission.right!.wait();
    }

    private async readReplay<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        command: Command
    ): Promise<Either<AppInboxFailure, Result> | undefined> {
        const admission = await this.readAdmission(registration, command);
        if (!admission) {
            return undefined;
        }
        return admission.left ? Either.ofLeft(admission.left) : await admission.right!.wait();
    }

    private async enqueue<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        command: Command
    ): Promise<Either<AppInboxFailure, RallarServerAppInbox.Admission<Result>>> {
        const admission = this.getAdmissionFailure();
        if (admission) {
            return Either.ofLeft(admission);
        }
        try {
            const received = toRegisteredEnqueue(registration, command);
            const retained = await this.readRetained(registration, received);
            if (retained) {
                this.wakeOwningQueue();
                return Either.ofRight(this.createAdmission(registration, retained));
            }
            const stopped = this.getAdmissionFailure();
            if (stopped) {
                return Either.ofLeft(stopped);
            }
            const placeholder = { ...received, traceId: newALTraceId() };
            const reservation = await this.client.reservationClient.reserveMaterializedEntry(placeholder, async () => {
                const decoded = registration.decodeEnvelope(received);
                const materialized = toRegisteredEnqueue(registration, registration.materialize(decoded));
                assertMatchingRegisteredCommand(registration, received, materialized);
                return materialized;
            });
            assertRegisteredEntry(registration, reservation.entry, received);
            this.wakeOwningQueue();
            return Either.ofRight(this.createAdmission(registration, reservation));
        }
        catch (error) {
            if (error instanceof AppInboxIdempotencyConflictError) {
                return Either.ofLeft(toTerminalAppInboxFailure(error));
            }
            throw error;
        }
    }

    private async readAdmission<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        command: Command
    ): Promise<Either<AppInboxFailure, RallarServerAppInbox.Admission<Result>> | undefined> {
        const admission = this.getAdmissionFailure();
        if (admission) {
            return Either.ofLeft(admission);
        }
        try {
            const retained = await this.readRetained(registration, toRegisteredEnqueue(registration, command));
            return retained ? Either.ofRight(this.createAdmission(registration, retained)) : undefined;
        }
        catch (error) {
            if (error instanceof AppInboxIdempotencyConflictError) {
                return Either.ofLeft(toTerminalAppInboxFailure(error));
            }
            throw error;
        }
    }

    private createAdmission<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        retained: AppInboxResultWaiter.Wait
    ): RallarServerAppInbox.Admission<Result> {
        const command = registration.decodeEnvelope(retained.enqueue);
        // Enqueue owns queue wakes. Subscribe then read: retained work may have completed before this wait begins.
        const observed = { enqueue: retained.enqueue, key: retained.key, winner: false };
        return Object.freeze({
            wait: () =>
                this.client.resultWaiter.waitForResult(observed, (value) => registration.decodeResult(value, command))
        });
    }

    private async readRetained<Command, Result>(
        registration: RallarServerAppInbox.Registration<Command, Result>,
        received: AppInboxEnqueue
    ): Promise<AppInboxResultWaiter.Wait | undefined> {
        const key = toRegisteredKey(received);
        const entry = await this.entries.findByKey(key);
        if (!entry) {
            return undefined;
        }
        const enqueue = assertRegisteredEntry(registration, entry, received);
        return { enqueue, key, winner: false };
    }

    private getAdmissionFailure(): AppInboxFailure | undefined {
        return this.state === 'running' ? undefined : toTerminalAppInboxFailure({
            code: 'app-inbox-lifecycle-rejected',
            status: 503,
            message: 'Application AppInbox is not accepting commands'
        });
    }
}

function toRegisteredEnqueue<Command, Result>(
    registration: RallarServerAppInbox.Registration<Command, Result>,
    command: Command
): AppInboxEnqueue {
    const encoded = registration.encodeEnvelope(command);
    const envelope: RallarServerAppInbox.Envelope = {
        data: detachWireValue(encoded.data),
        ...(encoded.authority === undefined ? {} : { authority: detachWireValue(encoded.authority) }),
        ...(encoded.senderId === undefined ? {} : { senderId: encoded.senderId })
    };
    if (envelope.senderId !== undefined && typeof envelope.senderId !== 'string') {
        throw new TypeError('Application AppInbox sender must be a string');
    }
    const decoded = registration.decodeEnvelope(envelope);
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
        ...envelope
    };
}

function toRegisteredKey(enqueue: AppInboxEnqueue): Key {
    if (!enqueue.resourceId || !enqueue.topicId) {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    return { topicId: enqueue.topicId, resourceId: enqueue.resourceId, contextId: enqueue.contextId };
}

function assertRegisteredEntry<Command, Result>(
    registration: RallarServerAppInbox.Registration<Command, Result>,
    entry: ResourceEntry,
    received: AppInboxEnqueue
): AppInboxEnqueue {
    const identity = validateAppInboxCommandIdentity(entry);
    const message = decodePersistedALMessage(entry.resource);
    if (!identity.valid || entry.typeId !== 'APP_INBOX') {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    const stored = identity.command;
    let projected: AppInboxEnqueue;
    try {
        projected = toRegisteredEnqueue(registration, registration.decodeEnvelope(stored));
    }
    catch {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    const key = toRegisteredKey(projected);
    const route = message.route;
    if (
        !sameKey(entry.key, key) || !sameKey(entry.key, toRegisteredKey(received)) ||
        stored.type !== registration.type || !sameKey(toRegisteredKey(stored), key) ||
        route?.topicId !== key.topicId || route.contextId !== key.contextId || route.resourceId !== key.resourceId ||
        serializeCanonicalMutationCommand(stored.authority ?? null) !==
            serializeCanonicalMutationCommand(projected.authority ?? null) ||
        serializeCanonicalMutationCommand(stored.data) !== serializeCanonicalMutationCommand(projected.data) ||
        stored.senderId !== projected.senderId
    ) {
        throw new AppInboxCommandIdentityError('corrupt');
    }
    assertMatchingRegisteredCommand(registration, received, projected);
    return stored;
}

function assertMatchingRegisteredCommand<Command, Result>(
    registration: RallarServerAppInbox.Registration<Command, Result>,
    received: AppInboxEnqueue,
    existing: AppInboxEnqueue
): void {
    const receivedIdentity = {
        type: received.type,
        ...toRegisteredKey(received),
        logical: registration.toLogicalCommand(registration.decodeEnvelope(received))
    };
    const existingIdentity = {
        type: existing.type,
        ...toRegisteredKey(existing),
        logical: registration.toLogicalCommand(registration.decodeEnvelope(existing))
    };
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

function detachWireValue(value: JsonWireValue): JsonWireValue {
    return decodeJsonWireText(JSON.stringify(encodeJsonWireValue(value)));
}

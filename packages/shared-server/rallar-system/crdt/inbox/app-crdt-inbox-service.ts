import type { RallarCrdtAuditSink, RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { toAppQueueKey, toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { PSqlResourceInboxEntryRepository } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { ResourceInboxResultsRepository } from '../../../queuebox/postgres/resource-inbox-results-repository.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxType,
    type AppInboxMessageContext
} from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import type { AppInboxCommandClient } from '../../app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxQueueEntryWriter } from '../../app-inbox/client/app-inbox-queue-entry-writer.ts';
import type { AppInboxReservationClient } from '../../app-inbox/client/app-inbox-reservation-client.ts';
import type { AppInboxResultWaiter } from '../../app-inbox/client/app-inbox-result-waiter.ts';
import { createAppInboxClientRuntime } from '../../app-inbox/client/create-app-inbox-client-runtime.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '../../app-inbox/handler/app-inbox-handler-runtime.ts';
import { AppInboxTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import { createCrdtMutationCommand, decodeCrdtMutationCommand } from '../mutation/crdt-mutation-command-codec.ts';
import {
    CRDT_MUTATION_INBOX_TYPES,
    type CrdtAppendCommand,
    type CrdtMutationActor,
    type CrdtMutationCommand,
    type CrdtMutationResponseAudience,
    type CrdtMutationResult
} from '../mutation/crdt-mutation-contracts.ts';
import type { CrdtMutationService } from '../mutation/create-crdt-mutation-service.ts';
import { decodeCrdtMutationResult } from '../mutation/decode-crdt-mutation-result.ts';
import { CrdtHttpAdminRejectionError } from './crdt-http-admin-rejection-error.ts';
import {
    createAndEnqueueAuthenticatedCrdtAppend,
    type AuthenticatedCrdtAppendInput,
    type ReadCurrentCrdtMutationSession
} from './create-authenticated-crdt-append.ts';
import { registerCrdtAuditDelivery } from './register-crdt-audit-delivery.ts';

export const CRDT_APP_INBOX_TOPIC = 'app-inbox.crdt-state';

export interface CreateAndEnqueueCrdtAppendInput {
    readonly update: RallarCrdtUpdateEnvelope;
    readonly deliveryId: string;
    readonly actor: CrdtMutationActor;
    readonly responseAudience: CrdtMutationResponseAudience;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

export namespace AppCrdtInboxService {
    export interface AuditDelivery {
        readonly outboxQueueReader: OutboxQueueReader;
        readonly auditSink: RallarCrdtAuditSink;
    }

    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: PSqlResourceInboxEntryRepository;
        readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
        readonly database: PSqlSql;
        readonly mutationService: CrdtMutationService;
        readonly readCurrentSession: ReadCurrentCrdtMutationSession;
        readonly wakeQueueEngine: () => void;
        readonly auditDelivery?: AuditDelivery;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing: RallarTimingSink | undefined;
        readonly appInbox: AppInboxOptions;
    }

    export interface HttpAdminCommandReservation {
        readonly operation: Exclude<CrdtMutationCommand['operation'], 'append'>;
        readonly requestId: string;
        readonly callerId: string;
        readonly documentKey: string;
        readonly semanticHash: string;
        readonly materialize: () => Promise<CrdtMutationCommand>;
        readonly matches: (command: CrdtMutationCommand) => boolean | Promise<boolean>;
    }
}

export class AppCrdtInboxService {
    private readonly commandClient: AppInboxCommandClient;
    private readonly queueEntryWriter: AppInboxQueueEntryWriter;
    private readonly reservationClient: AppInboxReservationClient;
    private readonly resultWaiter: AppInboxResultWaiter;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly transactionWriter: AppInboxTransactionWriter;
    private readonly readCurrentSession: ReadCurrentCrdtMutationSession;
    private readonly wakeQueueEngine: () => void;
    private readonly serviceId: string;

    public readonly mutationService: CrdtMutationService;

    constructor(dependencies: AppCrdtInboxService.Dependencies, config: AppCrdtInboxService.Config) {
        const clientRuntime = createAppInboxClientRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resourceInboxRepository: dependencies.resourceInboxRepository,
            resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
            serviceId: config.serviceId,
            defaultTopicId: CRDT_APP_INBOX_TOPIC,
            timing: config.timing,
            options: config.appInbox,
            wakeOwningQueue: dependencies.wakeQueueEngine
        });
        this.commandClient = clientRuntime.commandClient;
        this.queueEntryWriter = clientRuntime.queueEntryWriter;
        this.reservationClient = clientRuntime.reservationClient;
        this.resultWaiter = clientRuntime.resultWaiter;
        const handlerRuntime = createAppInboxHandlerRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resultRepository: dependencies.resourceInboxResultsRepository,
            database: dependencies.database,
            serviceId: config.serviceId,
            timing: config.timing,
            options: config.appInbox
        });
        this.handlers = handlerRuntime.registry;
        this.transactionWriter = handlerRuntime.transactionWriter;
        this.serviceId = config.serviceId;
        this.mutationService = dependencies.mutationService;
        this.readCurrentSession = dependencies.readCurrentSession;
        this.wakeQueueEngine = dependencies.wakeQueueEngine;
        if (dependencies.auditDelivery !== undefined) {
            registerCrdtAuditDelivery(dependencies.auditDelivery);
        }
        for (const type of CRDT_MUTATION_INBOX_TYPES) {
            this.handlers.registerHandler({
                type,
                decodeCommand: decodeCrdtMutationCommand,
                encodeResult: (result) => encodeAppInboxResult(result, 'CRDT AppInbox result'),
                handle: async (command, context) => await this.processCommand(command, context)
            });
        }
        this.handlers.assertRegistrationComplete(CRDT_MUTATION_INBOX_TYPES);
    }

    async writeCrdtCommandUntilCompletion(
        command: CrdtMutationCommand
    ): Promise<Either<AppInboxFailure, CrdtMutationResult>> {
        const decoded = decodeCrdtMutationCommand(command);
        return await this.commandClient.enqueueAndWaitForResult(
            {
                type: toCrdtAppInboxType(decoded),
                topicId: CRDT_APP_INBOX_TOPIC,
                resourceId: decoded.deliveryId,
                contextId: decoded.documentKey,
                senderId: decoded.actor.sessionId,
                data: encodeAppInboxCommand(decoded, 'CRDT AppInbox command')
            },
            decodeCrdtMutationResult
        );
    }

    async writeHttpAdminCommandUntilCompletion(
        reservation: AppCrdtInboxService.HttpAdminCommandReservation
    ): Promise<Either<AppInboxFailure, CrdtMutationResult>> {
        const type = toCrdtAppInboxType({ operation: reservation.operation });
        const key = toStrictAppInboxQueueKey({
            topicId: type,
            resourceId: reservation.requestId,
            contextId: toCrdtHttpAdminContextId(reservation.callerId, reservation.documentKey)
        });
        const reserved = await this.reservationClient.reserveMaterializedEntry(
            {
                type,
                ...key,
                senderId: reservation.callerId,
                data: null
            },
            async () => ({
                type,
                ...key,
                senderId: reservation.callerId,
                data: encodeAppInboxCommand(
                    await reservation.materialize(),
                    'Reserved CRDT AppInbox command'
                )
            })
        );
        const command = decodeCrdtMutationCommand(reserved.enqueue.data);
        if (
            command.operation !== reservation.operation ||
            command.deliveryId !== reservation.requestId ||
            command.documentKey !== reservation.documentKey ||
            command.actor.actorId !== reservation.callerId ||
            reserved.enqueue.type !== type ||
            reserved.enqueue.topicId !== key.topicId ||
            reserved.enqueue.resourceId !== key.resourceId ||
            reserved.enqueue.contextId !== key.contextId ||
            reserved.enqueue.senderId !== reservation.callerId ||
            !(await reservation.matches(command))
        ) {
            throw new AppInboxIdempotencyConflictError(
                reservation.requestId,
                command.commandHash,
                reservation.semanticHash
            );
        }
        return await this.resultWaiter.waitForReservedResult(
            reserved,
            decodeCrdtMutationResult
        );
    }

    writeCrdtCommandNoWaiting(command: CrdtMutationCommand): void {
        const decoded = decodeCrdtMutationCommand(command);
        void this.queueEntryWriter.enqueue({
            type: toCrdtAppInboxType(decoded),
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: decoded.deliveryId,
            contextId: decoded.documentKey,
            senderId: decoded.actor.sessionId,
            data: encodeAppInboxCommand(decoded, 'CRDT AppInbox command')
        }).catch((caught) => {
            const error = caught instanceof Error ? caught : new Error(String(caught));
            console.error('Error enqueueing CRDT AppInbox command without waiting', error);
        });
    }

    async createAndEnqueueAppend(input: CreateAndEnqueueCrdtAppendInput): Promise<CrdtAppendCommand> {
        const command = await createCrdtMutationCommand({
            operation: 'append',
            commandId: input.update.updateId,
            deliveryId: input.deliveryId,
            actor: input.actor,
            capturedAtEpochMs: input.capturedAtEpochMs,
            expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(
                input.capturedAtEpochMs,
                input.expireAtEpochMs
            ),
            document: input.update.document,
            responseAudience: input.responseAudience,
            update: input.update,
            authorizationScope: input.update.document.scope
        });
        if (command.operation !== 'append') {
            throw new TypeError('CRDT append command is invalid');
        }
        await this.queueEntryWriter.enqueue({
            type: toCrdtAppInboxType(command),
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: command.deliveryId,
            contextId: command.documentKey,
            senderId: command.actor.sessionId,
            data: encodeAppInboxCommand(command, 'CRDT append AppInbox command')
        });
        return command;
    }

    async createAndEnqueueAuthenticatedAppend(
        input: AuthenticatedCrdtAppendInput
    ): Promise<CrdtAppendCommand> {
        return await createAndEnqueueAuthenticatedCrdtAppend(input, {
            serviceId: this.serviceId,
            readCurrentSession: this.readCurrentSession,
            enqueue: async (append) => await this.createAndEnqueueAppend(append)
        });
    }

    private async processCommand(
        command: CrdtMutationCommand,
        appInboxContext: AppInboxMessageContext<CrdtMutationResult>
    ): Promise<CrdtMutationResult> {
        assertCrdtAppInboxIdentity({ command, appInboxContext });

        const read = await this.mutationService.read(command);
        const computed = this.mutationService.compute({ command, read });
        const issues = this.mutationService.validate({ command, read, computed });
        if (issues[0] !== undefined) {
            throw new TypeError(issues[0].message);
        }
        if (computed.outcome === 'rejected' && isCrdtHttpAdminIdentity({ command, appInboxContext })) {
            throw toCrdtHttpAdminRejection(computed.code);
        }
        const result = await this.transactionWriter.writeMutation(
            appInboxContext,
            async (transaction) => await this.mutationService.write(transaction, computed)
        );
        if (result.operation === 'erase' && result.status === 'accepted') {
            this.wakeQueueEngine();
        }
        return result;
    }
}

function toCrdtHttpAdminRejection(reasonCode: string): Error {
    return new CrdtHttpAdminRejectionError(reasonCode);
}

interface AssertCrdtAppInboxIdentityInput {
    readonly command: CrdtMutationCommand;
    readonly appInboxContext: AppInboxMessageContext<CrdtMutationResult>;
}

function assertCrdtAppInboxIdentity(input: AssertCrdtAppInboxIdentityInput): void {
    const appendKey = toAppQueueKey({
        topicId: CRDT_APP_INBOX_TOPIC,
        resourceId: input.command.deliveryId,
        contextId: input.command.documentKey
    });
    if (
        toCrdtAppInboxType(input.command) !== input.appInboxContext.enqueue.type ||
        !(
            (appendKey.resourceId === input.appInboxContext.entry.key.resourceId &&
                appendKey.contextId === input.appInboxContext.entry.key.contextId &&
                appendKey.topicId === input.appInboxContext.entry.key.topicId) ||
            isCrdtHttpAdminIdentity(input)
        )
    ) {
        throw new TypeError('CRDT AppInbox command identity differs from queue key');
    }
}

function isCrdtHttpAdminIdentity(input: AssertCrdtAppInboxIdentityInput): boolean {
    if (input.command.operation === 'append') {
        return false;
    }
    const type = toCrdtAppInboxType(input.command);
    const expectedKey = toStrictAppInboxQueueKey({
        topicId: type,
        resourceId: input.command.deliveryId,
        contextId: toCrdtHttpAdminContextId(input.command.actor.actorId, input.command.documentKey)
    });
    return (
        expectedKey.topicId === input.appInboxContext.entry.key.topicId &&
        expectedKey.resourceId === input.appInboxContext.entry.key.resourceId &&
        expectedKey.contextId === input.appInboxContext.entry.key.contextId &&
        input.appInboxContext.enqueue.senderId === input.command.actor.actorId
    );
}

export function toCrdtHttpAdminContextId(callerId: string, documentKey: string): string {
    return `caller=${encodeURIComponent(callerId)}:document=${encodeURIComponent(documentKey)}`;
}

export function toCrdtAppInboxType(command: Pick<CrdtMutationCommand, 'operation'>): AppInboxType {
    switch (command.operation) {
        case 'append':
            return AppInboxType.CRDT_UPDATE_APPEND;
        case 'rebuild-projection':
            return AppInboxType.CRDT_PROJECTION_REBUILD;
        case 'compact':
            return AppInboxType.CRDT_SNAPSHOT_COMPACT;
        case 'lifecycle':
            return AppInboxType.CRDT_LIFECYCLE_UPDATE;
        case 'erase':
            return AppInboxType.CRDT_ERASE;
    }
}

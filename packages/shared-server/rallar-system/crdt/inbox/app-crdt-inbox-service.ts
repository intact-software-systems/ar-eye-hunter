import type { RallarCrdtAuditSink, RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import type { PSqlSql } from '../../../postgres/PostgresSqlClient.ts';
import type { ResourceInboxRepository } from '../../../postgres/resource-inbox/\
ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '../../../postgres/resource-inbox/\
ResourceInboxResultsRepository.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxType,
    type AppInboxMessageContext
} from '../../services/app-inbox-contracts.ts';
import type { AppInboxFailure } from '../../services/app-inbox-failure.ts';
import { toAppQueueKey, toStrictAppInboxQueueKey } from '../../services/app-inbox-queue-key.ts';
import { AppInboxService, type AppInboxServiceOptions } from '../../services/AppInboxService.ts';
import type { RallarTimingSink } from '../../services/timing.ts';
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
        readonly resourceInboxRepository: ResourceInboxRepository;
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
        readonly appInbox: AppInboxServiceOptions;
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

export class AppCrdtInboxService extends AppInboxService {
    private readonly readCurrentSession: ReadCurrentCrdtMutationSession;
    private readonly wakeQueueEngine: () => void;

    public readonly mutationService: CrdtMutationService;

    constructor(dependencies: AppCrdtInboxService.Dependencies, config: AppCrdtInboxService.Config) {
        super(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxRepository: dependencies.resourceInboxRepository,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
                database: dependencies.database
            },
            {
                serviceId: config.serviceId,
                defaultTopicId: CRDT_APP_INBOX_TOPIC,
                timing: config.timing,
                options: config.appInbox,
                wakeOwningQueue: dependencies.wakeQueueEngine
            }
        );
        this.mutationService = dependencies.mutationService;
        this.readCurrentSession = dependencies.readCurrentSession;
        this.wakeQueueEngine = dependencies.wakeQueueEngine;
        if (dependencies.auditDelivery !== undefined) {
            registerCrdtAuditDelivery(dependencies.auditDelivery);
        }
        for (const type of CRDT_MUTATION_INBOX_TYPES) {
            this.onStateMessage<unknown>(
                type,
                async (value, appInboxContext) => await this.processCommand(value, appInboxContext)
            );
        }
    }

    async writeCrdtCommandUntilCompletion(
        command: CrdtMutationCommand
    ): Promise<Either<AppInboxFailure, CrdtMutationResult>> {
        const decoded = decodeCrdtMutationCommand(command);
        return await this.processEntryUntilCompletionResult(
            {
                type: toCrdtAppInboxType(decoded),
                topicId: CRDT_APP_INBOX_TOPIC,
                resourceId: decoded.deliveryId,
                contextId: decoded.documentKey,
                senderId: decoded.actor.sessionId,
                data: decoded
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
        const reserved = await this.reserveMaterializedEntry(
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
                data: await reservation.materialize()
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
        return await this.waitForReservedEntryResult(
            reserved.enqueue,
            decodeCrdtMutationResult,
            reserved.winner
        );
    }

    writeCrdtCommandNoWaiting(command: CrdtMutationCommand): void {
        const decoded = decodeCrdtMutationCommand(command);
        this.processEntryNoWaiting({
            type: toCrdtAppInboxType(decoded),
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: decoded.deliveryId,
            contextId: decoded.documentKey,
            senderId: decoded.actor.sessionId,
            data: decoded
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
        await this.enqueue({
            type: toCrdtAppInboxType(command),
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: command.deliveryId,
            contextId: command.documentKey,
            senderId: command.actor.sessionId,
            data: command
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
        value: unknown,
        appInboxContext: AppInboxMessageContext
    ): Promise<CrdtMutationResult> {
        const command = decodeCrdtMutationCommand(value);
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
        const result = await this.writeMutation(
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
    const status = reasonCode.startsWith('authentication-')
        ? 401
        : reasonCode === 'document-not-found'
        ? 404
        : reasonCode.startsWith('authorization-') || reasonCode === 'feature-disabled'
        ? 403
        : 409;
    return Object.assign(new Error(`CRDT admin mutation rejected: ${reasonCode}`), {
        code: 'crdt-admin-mutation-rejected',
        status,
        details: { reasonCode }
    });
}

interface AssertCrdtAppInboxIdentityInput {
    readonly command: CrdtMutationCommand;
    readonly appInboxContext: AppInboxMessageContext;
}

function assertCrdtAppInboxIdentity(input: AssertCrdtAppInboxIdentityInput): void {
    const legacyKey = toAppQueueKey({
        topicId: CRDT_APP_INBOX_TOPIC,
        resourceId: input.command.deliveryId,
        contextId: input.command.documentKey
    });
    if (
        toCrdtAppInboxType(input.command) !== input.appInboxContext.enqueue.type ||
        !(
            (legacyKey.resourceId === input.appInboxContext.entry.key.resourceId &&
                legacyKey.contextId === input.appInboxContext.entry.key.contextId &&
                legacyKey.topicId === input.appInboxContext.entry.key.topicId) ||
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

import type { AuthSession } from '@shared/api/api-config.ts';
import {
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentLifecycleState,
    type RallarCrdtDocumentRef,
    type RallarCrdtQuotaPolicy,
    type RallarCrdtRetentionPolicy,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql } from '../../postgres/PostgresSqlClient.ts';
import type { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '../../postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { toAppQueueKey } from './app-inbox-queue-key.ts';
import type { AppInboxFailure } from './app-inbox-failure.ts';
import { AppInboxService, type AppInboxServiceOptions } from './AppInboxService.ts';
import { type AppInboxMessageContext, AppInboxType } from './app-inbox-contracts.ts';
import {
    CRDT_MUTATION_INBOX_TYPES,
    createCrdtMutationCommand,
    decodeCrdtMutationCommand,
    decodeCrdtMutationResult,
    type CrdtAppendCommand,
    type CrdtMutationActor,
    type CrdtMutationCommand,
    type CrdtMutationResponseAudience,
    type CrdtMutationResult,
    type CrdtMutationService,
} from './crdt-mutations.ts';
import type { RallarTimingSink } from './timing.ts';

export const CRDT_APP_INBOX_TOPIC = 'app-inbox.crdt-state';

export type CrdtAdminMutationOperation =
    | 'rebuild-projection'
    | 'compact'
    | 'lifecycle'
    | 'erase';

export class AppCrdtInboxService extends AppInboxService {
    constructor(
        public override readonly inbox: InboxQueueReader,
        public override readonly resourceInbox: ResourceInboxRepository,
        public override readonly resourceInboxResults: ResourceInboxResultsRepository,
        database: PSqlSql,
        public readonly mutationService: CrdtMutationService,
        public override readonly serviceId: string,
        timing?: RallarTimingSink,
        options?: AppInboxServiceOptions,
    ) {
        super(
            inbox,
            resourceInbox,
            resourceInboxResults,
            database,
            serviceId,
            CRDT_APP_INBOX_TOPIC,
            timing,
            options,
        );
        for (const type of CRDT_MUTATION_INBOX_TYPES) {
            this.onStateMessage<unknown>(
                type,
                async (data, context) => await this.processCommand(data, context),
            );
        }
    }

    async processCrdtCommandUntilCompletion(
        command: CrdtMutationCommand,
    ): Promise<Either<AppInboxFailure, CrdtMutationResult>> {
        const decoded = decodeCrdtMutationCommand(command);
        return await this.processEntryUntilCompletionResult({
            type: toCrdtAppInboxType(decoded),
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: decoded.commandId,
            contextId: decoded.documentKey,
            senderId: decoded.actor.sessionId,
            data: decoded,
        });
    }

    processCrdtCommandNoWaiting(command: CrdtMutationCommand): void {
        const decoded = decodeCrdtMutationCommand(command);
        this.processEntryNoWaiting({
            type: toCrdtAppInboxType(decoded),
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: decoded.commandId,
            contextId: decoded.documentKey,
            senderId: decoded.actor.sessionId,
            data: decoded,
        });
    }

    async createAndEnqueueAppend(input: Readonly<{
        update: RallarCrdtUpdateEnvelope;
        actor: CrdtMutationActor;
        responseAudience: CrdtMutationResponseAudience;
        capturedAtEpochMs: number;
        expireAtEpochMs: number;
    }>): Promise<CrdtAppendCommand> {
        const command = await createCrdtMutationCommand({
            operation: 'append',
            commandId: input.update.updateId,
            actor: input.actor,
            capturedAtEpochMs: input.capturedAtEpochMs,
            expireAtEpochMs: input.expireAtEpochMs,
            document: input.update.document,
            responseAudience: input.responseAudience,
            update: input.update,
            authorizationScope: input.update.document.scope,
        });
        if (command.operation !== 'append') throw new TypeError('CRDT append command is invalid');
        this.processCrdtCommandNoWaiting(command);
        return command;
    }

    async processAdminMutationUntilCompletion(
        operation: CrdtAdminMutationOperation,
        input: Readonly<{ adminSession: AuthSession; request: unknown }>,
    ): Promise<CrdtMutationResult> {
        const command = await this.createAdminCommand(operation, input);
        const completed = await this.processCrdtCommandUntilCompletion(command);
        if (completed.left !== undefined) {
            throw Object.assign(new Error(completed.left.message), completed.left);
        }
        if (completed.right === undefined) throw new Error('CRDT AppInbox result is missing');
        return decodeCrdtMutationResult(completed.right);
    }

    private async processCommand(
        input: unknown,
        context: AppInboxMessageContext,
    ): Promise<CrdtMutationResult> {
        const command = decodeCrdtMutationCommand(input);
        const expectedKey = toAppQueueKey({
            topicId: CRDT_APP_INBOX_TOPIC,
            resourceId: command.commandId,
            contextId: command.documentKey,
        });
        if (
            toCrdtAppInboxType(command) !== context.enqueue.type ||
            expectedKey.resourceId !== context.entry.key.resourceId ||
            expectedKey.contextId !== context.entry.key.contextId
        ) throw new TypeError('CRDT AppInbox command identity differs from queue key');
        const read = await this.mutationService.read(command);
        const computed = this.mutationService.compute(command, read);
        this.mutationService.validate(command, read, computed);
        return await this.writeMutation(
            context,
            async (transaction) => await this.mutationService.write(transaction, computed),
        );
    }

    private async createAdminCommand(
        operation: CrdtAdminMutationOperation,
        input: Readonly<{ adminSession: AuthSession; request: unknown }>,
    ): Promise<CrdtMutationCommand> {
        const request = requireRecord(input.request);
        const document = requireDocument(request.document);
        const capturedAtEpochMs = this.nowEpochMs();
        const common = {
            commandId: readString(request.requestId) ?? crypto.randomUUID(),
            actor: {
                actorId: input.adminSession.clientId,
                principalId: input.adminSession.username,
                sessionId: input.adminSession.sessionId,
                serverId: this.serviceId,
            },
            capturedAtEpochMs,
            expireAtEpochMs: capturedAtEpochMs + 60_000,
            document,
            responseAudience: {
                kind: 'admin' as const,
                senderSessionId: input.adminSession.sessionId,
                topicId: 'crdt.admin',
                contextId: toRallarCrdtDocumentKey(document),
            },
        };
        if (operation === 'rebuild-projection') {
            return await createCrdtMutationCommand({
                ...common,
                operation,
                projectionId: readString(request.projectionId) ?? 'default',
            });
        }
        if (operation === 'compact') {
            return await createCrdtMutationCommand({
                ...common,
                operation,
                snapshot: request.snapshot === undefined
                    ? null
                    : request.snapshot as RallarCrdtSnapshotEnvelope,
                reason: readString(request.reason) ?? 'api-v1-admin-compaction',
            });
        }
        if (operation === 'lifecycle') {
            return await createCrdtMutationCommand({
                ...common,
                operation,
                lifecycle: requireLifecycle(request.lifecycle),
                retention: (request.retention ?? null) as RallarCrdtRetentionPolicy | null,
                quota: (request.quota ?? null) as RallarCrdtQuotaPolicy | null,
                projectionIds: readStringArray(request.projectionIds),
            });
        }
        return await createCrdtMutationCommand({
            ...common,
            operation,
            mode: request.mode === 'redact-payloads' ? 'redact-payloads' : 'destroy-document',
            reason: readString(request.reason) ?? 'api-v1-admin-erasure-workflow',
        });
    }
}

export function toCrdtAppInboxType(command: CrdtMutationCommand): AppInboxType {
    switch (command.operation) {
        case 'append': return AppInboxType.CRDT_UPDATE_APPEND;
        case 'rebuild-projection': return AppInboxType.CRDT_PROJECTION_REBUILD;
        case 'compact': return AppInboxType.CRDT_SNAPSHOT_COMPACT;
        case 'lifecycle': return AppInboxType.CRDT_LIFECYCLE_UPDATE;
        case 'erase': return AppInboxType.CRDT_ERASE;
    }
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('CRDT admin request must be an object');
    }
    return value as Record<string, unknown>;
}

function requireDocument(value: unknown): RallarCrdtDocumentRef {
    if (!value || typeof value !== 'object') throw new TypeError('CRDT document is required');
    toRallarCrdtDocumentKey(value as RallarCrdtDocumentRef);
    return value as RallarCrdtDocumentRef;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new TypeError('CRDT projectionIds are invalid');
    }
    return value;
}

function requireLifecycle(value: unknown): RallarCrdtDocumentLifecycleState {
    if (!['active', 'archived', 'destroyed', 'quarantined'].includes(String(value))) {
        throw new TypeError('CRDT lifecycle is invalid');
    }
    return value as RallarCrdtDocumentLifecycleState;
}

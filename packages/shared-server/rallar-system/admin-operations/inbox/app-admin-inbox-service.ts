import {
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredCategory,
    type AdminPruneExpiredRequest
} from '@shared/api/admin-operations-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import { toUnavailableAppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import {
    DEFAULT_APP_INBOX_WAIT_JITTER_RATIO,
    DEFAULT_APP_INBOX_WAIT_MAX_ELAPSED_MSECS,
    DEFAULT_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MSECS,
    DEFAULT_APP_INBOX_WAIT_RETRY_INTERVAL_MSECS,
    type AppInboxOptions
} from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { AppInboxQueueClient } from '../../app-inbox/app-inbox-queue-client.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '../../app-inbox/handler/app-inbox-handler-runtime.ts';
import { AppInboxTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { AdminExpiredDataPruner } from '../admin-expired-data-pruner.ts';
import { toAdminPruneExpiredOptions } from '../admin-prune-options.ts';
import { toAdminPruneOutbox } from '../prune/admin-prune-page-codec.ts';
import {
    createAdminPruneAggregate,
    decodeAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneAggregateKey,
    toAdminPruneCompletedResultForCommand
} from '../prune/admin-prune-progress.ts';
import {
    createAdminPruneCommand,
    decodeAdminPruneCommand,
    type AdminPruneCommand
} from './admin-prune-command-codec.ts';

import { AppInboxType, type AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';

import { recordRallarTiming, timeRallarAsync, type RallarTimingSink } from '../../observability/timing.ts';
import {
    decodeAdminPruneEnqueueResultForCommand,
    decodeAdminPruneRequest,
    type AdminPruneEnqueueResult
} from './admin-prune-inbox-codec.ts';
import {
    ADMIN_APP_INBOX_TOPIC,
    assertAdminPruneQueueIdentity,
    assertAdminPruneStoredIdentity,
    assertMatchingAdminPruneIdentity,
    toAdminPruneQueueKey,
    toAdminPruneTimingIdentity,
    type AdminPruneIdempotencyIdentity,
    type AdminPruneIdempotencyIdentityInput,
    type AdminPruneTimingIdentity
} from './admin-prune-inbox-identity.ts';
import { throwOnAdminPruneValidationIssues, type AdminPruneValidationIssue } from './admin-prune-inbox-validation.ts';

export interface AdminPruneAuthorityReaderInput {
    readonly requestedBy: string;
    readonly requestedSessionId: string;
    readonly nowEpochMs: number;
}

export interface AdminPruneAuthority {
    readonly allowed: boolean;
    readonly code: string;
}

export type AdminPruneAuthorityReader = (
    input: AdminPruneAuthorityReaderInput
) => Promise<AdminPruneAuthority>;

export interface AppAdminInboxServiceDependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: AppInboxEntryRepository;
    readonly resourceInboxResultsRepository: AppInboxResultRepository;
    readonly database: PSqlSql;
    readonly pruner: Pick<AdminExpiredDataPruner, 'countExpired'>;
    readonly readAuthority: AdminPruneAuthorityReader;
    readonly wakeQueueEngine: () => void;
    readonly computeRetryExpiryAtEpochMs: (capturedAtEpochMs: number) => number;
    readonly createAdminPruneIdempotencyIdentity: (
        input: AdminPruneIdempotencyIdentityInput
    ) => Promise<AdminPruneIdempotencyIdentity>;
}

export interface AppAdminInboxServiceConfig {
    readonly serviceId: string;
    readonly pageSize: number;
    readonly timing?: RallarTimingSink;
    readonly appInbox: AppInboxOptions;
}

interface AdminPruneRead {
    readonly command: AdminPruneCommand;
    readonly expiredRows: Readonly<Record<AdminPruneExpiredCategory, number>>;
    readonly authority: AdminPruneAuthority;
    readonly nowEpochMs: number;
}

interface AdminPruneComputed {
    readonly read: AdminPruneRead;
    readonly result: AdminPruneEnqueueResult;
    readonly outboxEntries: readonly ResourceEntry[];
    readonly aggregateEntry: ResourceEntry | null;
}

export class AppAdminInboxService {
    private readonly dependencies: AppAdminInboxServiceDependencies;
    private readonly config: AppAdminInboxServiceConfig;
    private readonly aggregateWaitPolicy: TryWithPolicy;
    private readonly queueClient: AppInboxQueueClient;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly transactionWriter: AppInboxTransactionWriter;
    private readonly serviceId: string;

    constructor(dependencies: AppAdminInboxServiceDependencies, config: AppAdminInboxServiceConfig) {
        this.queueClient = new AppInboxQueueClient(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxRepository: dependencies.resourceInboxRepository,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository
            },
            {
                serviceId: config.serviceId,
                defaultTopicId: ADMIN_APP_INBOX_TOPIC,
                timing: config.timing,
                options: config.appInbox,
                wakeOwningQueue: dependencies.wakeQueueEngine
            }
        );
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
        this.dependencies = dependencies;
        this.config = config;
        this.aggregateWaitPolicy = createWaitPolicy('app-inbox:admin-prune-aggregate', config.appInbox);
        this.handlers.registerHandler({
            type: AppInboxType.ADMIN_PRUNE_EXPIRED,
            decodeCommand: decodeAdminPruneCommand,
            encodeResult: (result) => encodeAppInboxResult(result, 'Admin prune AppInbox result'),
            handle: async (command, context) => await this.processCommand(command, context)
        });
        this.handlers.assertRegistrationComplete([AppInboxType.ADMIN_PRUNE_EXPIRED]);
    }

    async pruneExpired(
        input: Readonly<{
            adminSession: AuthSession;
            requestId: string;
            request: AdminPruneExpiredRequest;
        }>
    ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
        const normalizedRequest = decodeAdminPruneRequest(input.request);
        const identity = await this.dependencies.createAdminPruneIdempotencyIdentity({
            requestId: input.requestId,
            requestedBy: input.adminSession.clientId,
            requestedSessionId: input.adminSession.sessionId,
            categories: normalizedRequest.categories,
            appData: normalizedRequest.appData,
            dryRun: normalizedRequest.dryRun
        });
        this.recordPhase('semantic-identity', identity, {
            semanticHash: identity.semanticHash
        });

        const key = toAdminPruneQueueKey(identity);
        const reservation = await this.queueClient.reserveMaterializedEntry(
            {
                type: AppInboxType.ADMIN_PRUNE_EXPIRED,
                topicId: key.topicId,
                resourceId: key.resourceId,
                contextId: key.contextId,
                senderId: identity.requestedBy,
                data: null
            },
            async () => {
                const capturedAtEpochMs = this.queueClient.nowEpochMs();
                const command = await createAdminPruneCommand({
                    jobId: identity.jobId,
                    requestedBy: identity.requestedBy,
                    requestedSessionId: identity.requestedSessionId,
                    capturedAtEpochMs,
                    expireAtEpochMs: this.dependencies.computeRetryExpiryAtEpochMs(capturedAtEpochMs),
                    dryRun: identity.dryRun,
                    categories: identity.categories,
                    appData: identity.appData,
                    pageSize: this.config.pageSize
                });
                return {
                    type: AppInboxType.ADMIN_PRUNE_EXPIRED,
                    topicId: key.topicId,
                    resourceId: key.resourceId,
                    contextId: key.contextId,
                    senderId: command.requestedSessionId,
                    data: encodeAppInboxCommand(command, 'Admin prune AppInbox command')
                };
            }
        );
        const command = decodeAdminPruneCommand(reservation.enqueue.data);
        await assertAdminPruneStoredIdentity(key, reservation.enqueue, command);
        assertMatchingAdminPruneIdentity(identity, command);
        const enqueued = await this.queueClient.waitForReservedEntryResult<AdminPruneEnqueueResult>(
            reservation.enqueue,
            (value) => decodeAdminPruneEnqueueResultForCommand(value, command),
            reservation.winner
        );
        return await this.toCallerResult(command, enqueued);
    }

    private async processCommand(
        value: AdminPruneCommand,
        context: AppInboxMessageContext<AdminPruneEnqueueResult>
    ): Promise<AdminPruneEnqueueResult> {
        const command = decodeAdminPruneCommand(value);
        await assertAdminPruneQueueIdentity(command, context);

        const read = await this.timeAdminPrunePhase(
            'read',
            command,
            async () => await this.read(command)
        );
        const computed = await this.timeAdminPrunePhase('compute', command, () => Promise.resolve(this.compute(read)));
        const issues = await this.timeAdminPrunePhase(
            'validate',
            command,
            () => Promise.resolve(this.validate(computed))
        );
        throwOnAdminPruneValidationIssues(issues);

        const result = await this.transactionWriter.writeMutation(context, async (transaction) => {
            const outbox = new PSqlResourceInboxEntryRepository(transaction);
            for (const entry of computed.outboxEntries) {
                await outbox.write(entry);
            }
            if (computed.aggregateEntry !== null) {
                const stored = await new ResourceInboxResultsRepository(
                    transaction
                ).writeIfAbsentOrReplaceExpired(computed.aggregateEntry);
                if (stored.resource !== computed.aggregateEntry.resource) {
                    throw new Error('Admin prune aggregate collides with an active job');
                }
            }
            return computed.result;
        });
        if (!command.dryRun) {
            this.dependencies.wakeQueueEngine();
        }
        return result;
    }

    private async read(command: AdminPruneCommand): Promise<AdminPruneRead> {
        const nowEpochMs = this.queueClient.nowEpochMs();
        const countPairs = ADMIN_PRUNE_EXPIRED_CATEGORIES.map(async (category) => {
            const count = command.categories.includes(category)
                ? await this.dependencies.pruner.countExpired(category, toAdminPruneExpiredOptions(command))
                : 0;
            return [category, count] as const;
        });
        const [pairs, authority] = await Promise.all([
            Promise.all(countPairs),
            this.dependencies.readAuthority({
                requestedBy: command.requestedBy,
                requestedSessionId: command.requestedSessionId,
                nowEpochMs
            })
        ]);
        const expiredRows: Record<AdminPruneExpiredCategory, number> = {
            'runtime-state': 0,
            'resource-inbox': 0,
            'resource-inbox-results': 0,
            'app-data': 0
        };
        for (const [category, count] of pairs) {
            expiredRows[category] = count;
        }
        return { command, expiredRows, authority, nowEpochMs };
    }

    private compute(read: AdminPruneRead): AdminPruneComputed {
        const command = read.command;
        const results = command.categories.map((category) => ({
            category,
            expiredRows: read.expiredRows[category],
            deletedRows: 0,
            dryRun: command.dryRun
        }));
        return {
            read,
            outboxEntries: createInitialAdminPrunePages(command, this.serviceId),
            aggregateEntry: command.dryRun
                ? null
                : toAdminPruneAggregateEntry(
                    createAdminPruneAggregate({
                        jobId: command.jobId,
                        generatedAtEpochMs: command.capturedAtEpochMs,
                        expireAtEpochMs: command.expireAtEpochMs,
                        serverId: this.serviceId,
                        requestedBy: command.requestedBy,
                        requestedSessionId: command.requestedSessionId,
                        categories: command.categories,
                        expiredRows: read.expiredRows
                    })
                ),
            result: {
                generatedAtEpochMs: command.capturedAtEpochMs,
                serverId: this.serviceId,
                warnings: [],
                operation: 'maintenance.prune-expired',
                status: command.dryRun ? 'dry-run' : 'queued',
                changed: false,
                jobId: command.jobId,
                results
            }
        };
    }

    private validate(computed: AdminPruneComputed): readonly AdminPruneValidationIssue[] {
        const { command } = computed.read;
        const issues: AdminPruneValidationIssue[] = [];
        if (!computed.read.authority.allowed || command.expireAtEpochMs <= computed.read.nowEpochMs) {
            issues.push({
                code: 'admin-prune-authority-denied',
                message: 'Admin prune current authority is denied',
                status: 403
            });
        }
        if (computed.result.jobId !== command.jobId) {
            issues.push({
                code: 'admin-prune-computed-identity-invalid',
                message: 'Admin prune computed identity differs from command',
                status: 400
            });
        }
        if (computed.outboxEntries.length !== (command.dryRun ? 0 : command.categories.length)) {
            issues.push({
                code: 'admin-prune-computed-category-count-invalid',
                message: 'Admin prune computed category count is invalid',
                status: 400
            });
        }
        if ((computed.aggregateEntry === null) !== command.dryRun) {
            issues.push({
                code: 'admin-prune-aggregate-presence-invalid',
                message: 'Admin prune aggregate presence is invalid',
                status: 400
            });
        }
        return issues;
    }

    private async toCallerResult(
        command: AdminPruneCommand,
        result: Either<AppInboxFailure, AdminPruneEnqueueResult>
    ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
        if (result.left !== undefined || command.dryRun) {
            return result;
        }
        return await this.waitForAggregate(command);
    }

    private async waitForAggregate(
        command: AdminPruneCommand
    ): Promise<Either<AppInboxFailure, AdminPruneEnqueueResult>> {
        try {
            const entry = await tryWithPolicy(async () => {
                const entry = await this.queueClient.resourceInboxResults.findByKey(
                    toAdminPruneAggregateKey(command.jobId)
                );
                if (entry === undefined || entry.status !== EntityStatus.COMPLETED) {
                    throw new Error('Admin prune aggregate is pending');
                }
                return entry;
            }, this.aggregateWaitPolicy);
            return Either.ofRight(toAdminPruneCompletedResultForCommand(
                decodeAdminPruneAggregate(JSON.parse(entry.resource)),
                command
            ));
        }
        catch (error) {
            if (error instanceof TryWithExhaustedError) {
                return Either.ofLeft(toUnavailableAppInboxFailure());
            }
            throw error;
        }
    }

    private async timeAdminPrunePhase<T>(
        operation: string,
        identity: AdminPruneTimingIdentity | AdminPruneCommand,
        action: () => Promise<T>
    ): Promise<T> {
        const timingIdentity = toAdminPruneTimingIdentity(identity);
        return await timeRallarAsync(
            this.config.timing,
            {
                component: 'admin-prune-inbox',
                operation,
                serviceId: this.serviceId,
                requestId: timingIdentity.requestId,
                principalId: timingIdentity.requestedBy,
                sessionId: timingIdentity.requestedSessionId
            },
            action
        );
    }

    private recordPhase(
        operation: string,
        identity: Pick<AdminPruneIdempotencyIdentityInput, 'requestId' | 'requestedBy' | 'requestedSessionId'>,
        details: Readonly<Record<string, string | number | boolean | undefined>>
    ): void {
        recordRallarTiming({
            sink: this.config.timing,
            event: {
                component: 'admin-prune-inbox',
                operation,
                serviceId: this.serviceId,
                requestId: identity.requestId,
                principalId: identity.requestedBy,
                sessionId: identity.requestedSessionId,
                details
            },
            status: 'ok',
            durationMs: 0
        });
    }
}

function createWaitPolicy(label: string, options: AppInboxOptions): TryWithPolicy {
    return TryWithPolicy.defaults()
        .label(label)
        .maxElapsedMsecs(options.waitMaxElapsedMsecs ?? DEFAULT_APP_INBOX_WAIT_MAX_ELAPSED_MSECS)
        .retryIntervalMsecs(options.waitRetryIntervalMsecs ?? DEFAULT_APP_INBOX_WAIT_RETRY_INTERVAL_MSECS)
        .maxRetryIntervalMsecs(
            options.waitMaxRetryIntervalMsecs ?? DEFAULT_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MSECS
        )
        .jitterRatio(options.waitJitterRatio ?? DEFAULT_APP_INBOX_WAIT_JITTER_RATIO);
}

function createInitialAdminPrunePages(
    command: AdminPruneCommand,
    serviceId: string
): readonly ResourceEntry[] {
    if (command.dryRun) {
        return [];
    }
    return command.categories.map((category) =>
        toAdminPruneOutbox(
            {
                kind: 'page',
                jobId: command.jobId,
                category,
                requestedBy: command.requestedBy,
                requestedSessionId: command.requestedSessionId,
                capturedAtEpochMs: command.capturedAtEpochMs,
                expireAtEpochMs: command.expireAtEpochMs,
                pageSize: command.pageSize,
                afterCursor: null,
                pageIndex: 0,
                appData: category === 'app-data' ? command.appData : null
            },
            serviceId
        )
    );
}

import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '../../app-inbox/app-inbox-contracts.ts';
import { type AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/app-inbox-handler-registry.ts';
import type { AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { AppInboxQueueClient, SIMPLER_GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-queue-client.ts';
import {
    encodeAppInboxCommand,
    encodeAppInboxResult
} from '../../app-inbox/app-inbox-registration-codecs.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { GroupFormationGroupMutationSink } from '../../observability/formation-metrics.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { GroupMutationAuthorizationError } from '../group-mutation-authority.ts';
import type { GroupStateService } from '../group-state-service-contracts.ts';
import type { GroupMutationCommand } from '../mutation/group-mutation-contracts.ts';
import {
    processGroupSessionCleanup,
    toExpiredPresenceEnqueue,
    toGroupSessionCleanupEnqueue
} from '../presence/group-presence-service.ts';
import type {
    GroupPresenceSessionCleanupAppInboxPayload
} from '../presence/group-presence-session-cleanup-app-inbox-payload.ts';
import {
    decodeGroupPresenceSessionCleanupAppInboxPayload
} from '../presence/group-presence-session-cleanup-app-inbox-payload.ts';
import { decodeGroupStateAppInboxCommand } from './decode-group-state-app-inbox-command.ts';
import {
    GROUP_MUTATION_INBOX_TYPES,
    isAuthenticatedGroupMutationEnqueue,
    type AuthenticatedGroupMutationEnqueue
} from './group-state-inbox-contracts.ts';
import { GroupStateInboxHandler } from './group-state-inbox-handler.ts';
import { decodeGroupStateInboxDurableResult } from './group-state-inbox-result-codec.ts';
import type { GroupStateInboxDurableResult } from './group-state-inbox-result.ts';
import { toGroupMutationDescriptor } from './to-group-mutation-descriptor.ts';

export namespace GroupStateInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxEntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
        readonly groupStateService: GroupStateService;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
        readonly formationMetrics?: GroupFormationGroupMutationSink;
    }
}

export class GroupStateInboxService {
    private readonly queueClient: AppInboxQueueClient;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly groupStateInboxHandler: GroupStateInboxHandler;
    private readonly wakeQueue?: () => void;
    private readonly serviceId: string;

    public readonly groupStateService: GroupStateService;

    constructor(
        dependencies: GroupStateInboxService.Dependencies,
        config: GroupStateInboxService.Config
    ) {
        this.queueClient = new AppInboxQueueClient(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxRepository: dependencies.resourceInboxRepository,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository
            },
            {
                serviceId: config.serviceId,
                defaultTopicId: SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
                timing: config.timing,
                options: config.options,
                wakeOwningQueue: config.wakeOwningQueue
            }
        );
        this.handlers = new AppInboxHandlerRegistry(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
                database: dependencies.database
            },
            {
                serviceId: config.serviceId,
                timing: config.timing,
                options: config.options
            }
        );
        this.groupStateService = dependencies.groupStateService;
        this.wakeQueue = config.wakeOwningQueue;
        this.serviceId = config.serviceId;
        this.groupStateInboxHandler = new GroupStateInboxHandler({
            mutationService: this.groupStateService,
            sessionGenerationLifecycle: this.groupStateService.sessionGenerationLifecycle,
            snapshotObserver: this.groupStateService,
            transactionWriter: this.handlers.transactionWriter,
            wakeQueue: this.wakeQueue,
            formationMetrics: config.formationMetrics,
            prepareMutation: (descriptor, authority) =>
                this.groupStateService.prepareAppInboxMutation(descriptor, authority),
            persistPreparation: (context, preparation) =>
                this.queueClient.persistReservedEntryAuthority(
                    context,
                    encodeAppInboxCommand(preparation, 'Group mutation AppInbox authority')
                )
        });
        this.registerMessageHandlers();
        this.handlers.assertRegistrationComplete(GROUP_MUTATION_INBOX_TYPES);
    }

    async enqueueExpiredPresenceSessions(atEpochMs: number): Promise<number> {
        const preparations = await this.groupStateService.prepareExpiredPresenceMutations(atEpochMs);
        for (const preparation of preparations) {
            await this.queueClient.enqueue(toExpiredPresenceEnqueue(preparation));
        }
        return preparations.length;
    }

    async enqueueFormationCriterionCommand(
        command: GroupMutationCommand,
        atEpochMs: number
    ): Promise<void> {
        const preparation = await this.groupStateService.prepareFormationCriterionMutation(
            command,
            atEpochMs
        );
        await this.queueClient.enqueue({
            type: AppInboxType.GROUP_FORMATION_CRITERION,
            resourceId: preparation.queueResourceId,
            authority: decodeJsonWireValue(
                preparation,
                'Group formation AppInbox authority'
            ),
            data: { commandId: preparation.command.commandId }
        });
    }

    async enqueueGroupSessionCleanup(
        input: GroupPresenceSessionCleanupAppInboxPayload
    ): Promise<number> {
        await this.queueClient.enqueue(toGroupSessionCleanupEnqueue(input, this.serviceId));
        return 1;
    }

    async processAuthenticatedGroupEntryUntilCompletion(
        enqueue: AuthenticatedGroupMutationEnqueue,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>> {
        return await this.processAuthenticatedGroupEntryUntilCompletionResult(enqueue, authority);
    }

    async processAuthenticatedGroupEntryUntilCompletionResult(
        enqueue: AuthenticatedGroupMutationEnqueue,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>> {
        const prepared = await this.prepareAuthenticatedGroupMutation(enqueue, authority);
        return await this.queueClient.processEntryUntilCompletionResult<GroupStateInboxDurableResult>(
            prepared,
            (value) => decodeGroupStateInboxDurableResult(value, enqueue.type)
        );
    }

    private async prepareAuthenticatedGroupMutation(
        enqueue: AuthenticatedGroupMutationEnqueue,
        authority: IssuedAuthSession
    ): Promise<AppInboxEnqueueInput> {
        if (!isAuthenticatedGroupMutationEnqueue(enqueue)) {
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.'
            );
        }
        const authorized = await this.groupStateService.authorizeMutation(
            toGroupMutationDescriptor(enqueue),
            authority
        );
        return {
            ...enqueue,
            authority: encodeAppInboxCommand(authorized, 'Group mutation AppInbox authority'),
            data: encodeAppInboxCommand(enqueue.data, 'Group mutation AppInbox command')
        };
    }

    private registerMessageHandlers(): void {
        for (
            const type of GROUP_MUTATION_INBOX_TYPES.filter(
                (candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP
            )
        ) {
            this.handlers.registerHandler({
                type,
                decodeCommand: (value) => decodeGroupStateAppInboxCommand(type, value),
                encodeResult: (result) => encodeAppInboxResult(result, 'Group state AppInbox result'),
                handle: async (_command, context) =>
                    await this.groupStateInboxHandler.processGroupStateMutation(context)
            });
        }
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
            decodeCommand: decodeGroupPresenceSessionCleanupAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Group cleanup AppInbox result'),
            handle: async (payload, context) =>
                await processGroupSessionCleanup({
                    facts: payload,
                    attemptCount: context.entry.dequeueAudit.attempts,
                    groupStateService: this.groupStateService,
                    writeMutation: async (write) => await this.handlers.writeMutation(context, write),
                    wakeQueue: this.wakeQueue
                })
        });
    }
}

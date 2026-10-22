import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '../../app-inbox/app-inbox-contracts.ts';
import { type AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-topics.ts';
import type { AppInboxCommandClient } from '../../app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxQueueEntryWriter } from '../../app-inbox/client/app-inbox-queue-entry-writer.ts';
import { createAppInboxClientRuntime } from '../../app-inbox/client/create-app-inbox-client-runtime.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '../../app-inbox/handler/app-inbox-handler-runtime.ts';
import { AppInboxTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { GroupFormationGroupMutationSink } from '../../observability/formation-metrics.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { GroupMutationAuthorizationError } from '../group-mutation-authority.ts';
import type { AuthorizedGroupMutation, GroupStateService } from '../group-state-service-contracts.ts';
import type { GroupMutationCommand } from '../mutation/group-mutation-contracts.ts';
import {
    toGroupSessionCleanupEnqueue,
    writeGroupSessionCleanup
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
import {
    GroupStateInboxHandler,
    type GroupStateInboxResultReader
} from './group-state-inbox-handler.ts';
import { decodeGroupStateInboxDurableResult } from './group-state-inbox-result-codec.ts';
import type { GroupStateInboxDurableResult } from './group-state-inbox-result.ts';
import { toAuthenticatedGroupMutationQueueKey } from './to-authenticated-group-mutation-queue-key.ts';
import { toGroupMutationDescriptor } from './to-group-mutation-descriptor.ts';
import { toGroupSystemCommandEnqueue } from './to-group-system-command-enqueue.ts';

export namespace GroupStateInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxEntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
        readonly groupStateService: GroupStateService;
        readonly resultReader: GroupStateInboxResultReader;
    }

    export interface Config {
        readonly serviceId: string;
        /** How long a finished command's fact and result stay before the expiry sweep removes them. */
        readonly finishedRetentionMs: number;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
        readonly formationMetrics?: GroupFormationGroupMutationSink;
    }
}

export class GroupStateInboxService {
    private readonly commandClient: AppInboxCommandClient;
    private readonly queueEntryWriter: AppInboxQueueEntryWriter;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly transactionWriter: AppInboxTransactionWriter;
    private readonly groupStateInboxHandler: GroupStateInboxHandler;
    private readonly wakeQueue?: () => void;
    private readonly serviceId: string;
    private readonly nowEpochMs: () => number;

    public readonly groupStateService: GroupStateService;

    constructor(
        dependencies: GroupStateInboxService.Dependencies,
        config: GroupStateInboxService.Config
    ) {
        const clientRuntime = createAppInboxClientRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resourceInboxRepository: dependencies.resourceInboxRepository,
            resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
            serviceId: config.serviceId,
            defaultTopicId: GROUP_STATE_APP_INBOX_TOPIC,
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
            finishedRetentionMs: config.finishedRetentionMs,
            timing: config.timing,
            options: config.options
        });
        this.handlers = handlerRuntime.registry;
        this.transactionWriter = handlerRuntime.transactionWriter;
        this.groupStateService = dependencies.groupStateService;
        this.wakeQueue = config.wakeOwningQueue;
        this.serviceId = config.serviceId;
        this.nowEpochMs = config.options?.nowEpochMs ?? Date.now;
        this.groupStateInboxHandler = new GroupStateInboxHandler({
            mutationService: this.groupStateService,
            sessionGenerationLifecycle: this.groupStateService.sessionGenerationLifecycle,
            resultReader: dependencies.resultReader,
            transactionWriter: this.transactionWriter,
            publicationTiming: config.timing === undefined
                ? undefined
                : { sink: config.timing, serviceId: config.serviceId },
            wakeQueue: this.wakeQueue,
            formationMetrics: config.formationMetrics,
            nowEpochMs: this.nowEpochMs
        });
        this.registerMessageHandlers();
        this.handlers.assertRegistrationComplete(GROUP_MUTATION_INBOX_TYPES);
    }

    async enqueueExpiredPresenceSessions(atEpochMs: number): Promise<number> {
        const ingresses = await this.groupStateService.captureExpiredPresenceMutationIngresses(atEpochMs);
        for (const ingress of ingresses) {
            await this.queueEntryWriter.enqueue(
                toGroupSystemCommandEnqueue(AppInboxType.GROUP_PRESENCE_EXPIRE, ingress)
            );
        }
        return ingresses.length;
    }

    async enqueueFormationCriterionCommand(
        command: GroupMutationCommand,
        atEpochMs: number
    ): Promise<void> {
        const ingress = await this.groupStateService.captureFormationCriterionMutationIngress(
            command,
            atEpochMs
        );
        await this.queueEntryWriter.enqueue(
            toGroupSystemCommandEnqueue(AppInboxType.GROUP_FORMATION_CRITERION, ingress)
        );
    }

    async enqueueFormationAutomationCommand(command: GroupMutationCommand, atEpochMs: number): Promise<void> {
        const ingress = await this.groupStateService.captureFormationAutomationMutationIngress(command, atEpochMs);
        await this.queueEntryWriter.enqueue(
            toGroupSystemCommandEnqueue(AppInboxType.GROUP_FORMATION_AUTOMATION, ingress)
        );
    }

    async enqueueTopologyPublicationCommand(
        command: GroupMutationCommand,
        atEpochMs: number
    ): Promise<void> {
        const ingress = await this.groupStateService.captureTopologyPublicationMutationIngress(
            command,
            atEpochMs
        );
        await this.queueEntryWriter.enqueue(
            toGroupSystemCommandEnqueue(AppInboxType.GROUP_TOPOLOGY_PUBLICATION, ingress)
        );
    }

    async enqueueActivationStatusCommand(
        command: GroupMutationCommand,
        atEpochMs: number
    ): Promise<void> {
        const ingress = await this.groupStateService.captureActivationStatusMutationIngress(
            command,
            atEpochMs
        );
        await this.queueEntryWriter.enqueue(toGroupSystemCommandEnqueue(AppInboxType.GROUP_ACTIVATION_STATUS, ingress));
    }

    async enqueueGroupSessionCleanup(
        input: GroupPresenceSessionCleanupAppInboxPayload
    ): Promise<number> {
        await this.queueEntryWriter.enqueue(toGroupSessionCleanupEnqueue(input, this.serviceId));
        return 1;
    }

    /**
     * The route's request is authorized and its ingress facts are captured at enqueue; the reservation stores the
     * winner's facts, so every attempt and replay of the queued command reuses them.
     */
    async processAuthenticatedGroupEntryUntilCompletion(
        enqueue: AuthenticatedGroupMutationEnqueue,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>> {
        const authorized = await this.authorizeAuthenticatedGroupMutation(enqueue, authority);
        const received: AppInboxEnqueueInput = {
            ...enqueue,
            authority: encodeAppInboxCommand(authorized, 'Group mutation AppInbox authority'),
            data: encodeAppInboxCommand(enqueue.data, 'Group mutation AppInbox command')
        };
        const placeholder: AppInboxEnqueueInput = {
            type: received.type,
            topicId: toAuthenticatedGroupMutationQueueKey(received).topicId,
            resourceId: received.resourceId,
            contextId: received.contextId,
            senderId: received.senderId,
            data: null
        };
        // Captured before the reservation's transaction opens; only the winner's facts are stored and reused.
        const materialized: AppInboxEnqueueInput = {
            ...placeholder,
            authority: encodeAppInboxCommand(
                await this.groupStateService.captureAppInboxMutationIngress(
                    authorized.descriptor,
                    authorized.authorityProof
                ),
                'Group mutation AppInbox authority'
            ),
            data: received.data
        };
        return await this.commandClient.reserveMaterializedAndWaitForResult(
            { received, placeholder, materialize: async () => materialized },
            (value) => decodeGroupStateInboxDurableResult(value, enqueue.type)
        );
    }

    private async authorizeAuthenticatedGroupMutation(
        enqueue: AuthenticatedGroupMutationEnqueue,
        authority: IssuedAuthSession
    ): Promise<AuthorizedGroupMutation> {
        if (!isAuthenticatedGroupMutationEnqueue(enqueue)) {
            throw new GroupMutationAuthorizationError(
                'App inbox type is not an authenticated group mutation.'
            );
        }
        return await this.groupStateService.authorizeMutation(toGroupMutationDescriptor(enqueue), authority);
    }

    private registerMessageHandlers(): void {
        const encodeGroupStateResult = (result: GroupStateInboxDurableResult) =>
            encodeAppInboxResult(result, 'Group state AppInbox result');
        const writeGroupStateMutation = async (
            _command: JsonWireValue,
            context: AppInboxMessageContext<GroupStateInboxDurableResult>
        ) => {
            const result = await this.groupStateInboxHandler.processGroupStateMutation(context);
            if ('status' in result && (result.status === 'created' || result.status === 'ok')) {
                await this.groupStateService.observeSnapshot(result.result.snapshot);
            }
            return result;
        };
        for (
            const type of GROUP_MUTATION_INBOX_TYPES.filter(
                (candidate) => candidate !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP
            )
        ) {
            this.handlers.registerHandler({
                type,
                decodeCommand: (value) => decodeGroupStateAppInboxCommand(type, value),
                encodeResult: encodeGroupStateResult,
                handle: writeGroupStateMutation
            });
        }
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
            decodeCommand: decodeGroupPresenceSessionCleanupAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Group cleanup AppInbox result'),
            handle: async (payload, context) =>
                await writeGroupSessionCleanup({
                    facts: payload,
                    attemptCount: context.entry.dequeueAudit.attempts,
                    laneNowEpochMs: this.nowEpochMs(),
                    context,
                    groupStateService: this.groupStateService,
                    transactionWriter: this.transactionWriter,
                    wakeQueue: this.wakeQueue
                })
        });
    }
}

import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '../../app-inbox/app-inbox-contracts.ts';
import { type AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import { normalizeAppInboxOptions, type AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-topics.ts';
import type { AppInboxQueueEntryWriter } from '../../app-inbox/client/app-inbox-queue-entry-writer.ts';
import type { AppInboxReservationClient } from '../../app-inbox/client/app-inbox-reservation-client.ts';
import type { AppInboxResultWaiter } from '../../app-inbox/client/app-inbox-result-waiter.ts';
import { createAppInboxClientRuntime } from '../../app-inbox/client/create-app-inbox-client-runtime.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '../../app-inbox/handler/app-inbox-handler-runtime.ts';
import { AppInboxTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import { toLogicalAppInboxCommand } from '../../app-inbox/logical-app-inbox-command.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { GroupFormationGroupMutationSink } from '../../observability/formation-metrics.ts';
import { timeRallarAsync, type RallarTimingSink } from '../../observability/timing.ts';
import {
    computeMutationCommandDigest,
    serializeCanonicalMutationCommand,
    type JsonWireValue
} from '../../protocol/json-wire-identity.ts';
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
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
        readonly formationMetrics?: GroupFormationGroupMutationSink;
    }
}

export class GroupStateInboxService {
    private readonly queueEntryWriter: AppInboxQueueEntryWriter;
    private readonly reservationClient: AppInboxReservationClient;
    private readonly resultWaiter: AppInboxResultWaiter;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly transactionWriter: AppInboxTransactionWriter;
    private readonly groupStateInboxHandler: GroupStateInboxHandler;
    private readonly wakeQueue?: () => void;
    private readonly serviceId: string;
    private readonly timing: RallarTimingSink | undefined;
    private readonly phaseTiming: boolean;

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
        this.queueEntryWriter = clientRuntime.queueEntryWriter;
        this.reservationClient = clientRuntime.reservationClient;
        this.resultWaiter = clientRuntime.resultWaiter;
        const handlerRuntime = createAppInboxHandlerRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resultRepository: dependencies.resourceInboxResultsRepository,
            database: dependencies.database,
            serviceId: config.serviceId,
            timing: config.timing,
            options: config.options
        });
        this.handlers = handlerRuntime.registry;
        this.transactionWriter = handlerRuntime.transactionWriter;
        this.groupStateService = dependencies.groupStateService;
        this.wakeQueue = config.wakeOwningQueue;
        this.serviceId = config.serviceId;
        this.timing = config.timing;
        this.phaseTiming = normalizeAppInboxOptions(config.options ?? {}).phaseTiming;
        this.groupStateInboxHandler = new GroupStateInboxHandler({
            mutationService: this.groupStateService,
            sessionGenerationLifecycle: this.groupStateService.sessionGenerationLifecycle,
            resultReader: dependencies.resultReader,
            transactionWriter: this.transactionWriter,
            publicationTiming: config.timing === undefined
                ? undefined
                : { sink: config.timing, serviceId: config.serviceId },
            wakeQueue: this.wakeQueue,
            formationMetrics: config.formationMetrics
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
        const key = toAuthenticatedGroupMutationQueueKey(received);
        return await this.timeEnqueueOperation('enqueueAndWaitForResult', received, async () => {
            const reserved = await this.timeEnqueueOperation(
                'enqueue',
                received,
                async () => await this.reserveAuthenticatedGroupMutation(received, key, authorized)
            );
            return await this.resultWaiter.waitForReservedResult(
                reserved,
                (value) => decodeGroupStateInboxDurableResult(value, enqueue.type)
            );
        });
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

    private async reserveAuthenticatedGroupMutation(
        received: AppInboxEnqueueInput,
        key: Key,
        authorized: AuthorizedGroupMutation
    ): Promise<AppInboxReservationClient.MaterializedReservation> {
        const placeholder: AppInboxEnqueueInput = {
            type: received.type,
            topicId: key.topicId,
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
        const reserved = await this.reservationClient.reserveMaterializedEntry(placeholder, async () => materialized);
        const existing = toLogicalAppInboxCommand(reserved.enqueue);
        const incoming = toLogicalAppInboxCommand(received);
        if (serializeCanonicalMutationCommand(existing) !== serializeCanonicalMutationCommand(incoming)) {
            throw new AppInboxIdempotencyConflictError(
                key.resourceId,
                computeMutationCommandDigest(existing),
                computeMutationCommandDigest(incoming)
            );
        }
        return reserved;
    }

    private async timeEnqueueOperation<Result>(
        operation: 'enqueueAndWaitForResult' | 'enqueue',
        enqueue: AppInboxEnqueueInput,
        action: () => Promise<Result>
    ): Promise<Result> {
        if (operation === 'enqueue' && !this.phaseTiming) {
            return await action();
        }
        return await timeRallarAsync(
            this.timing,
            {
                component: operation === 'enqueue' ? 'app-inbox-phase' : 'app-inbox',
                operation,
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: {
                    type: enqueue.type,
                    topicId: enqueue.topicId,
                    contextId: enqueue.contextId,
                    resourceId: enqueue.resourceId,
                    senderId: enqueue.senderId
                }
            },
            action
        );
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
                    context,
                    groupStateService: this.groupStateService,
                    transactionWriter: this.transactionWriter,
                    wakeQueue: this.wakeQueue
                })
        });
    }
}

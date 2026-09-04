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
import { decodeJsonWireValue, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
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
import {
    GroupStateInboxHandler,
    type GroupStateInboxResultReader
} from './group-state-inbox-handler.ts';
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
    private readonly commandClient: AppInboxCommandClient;
    private readonly queueEntryWriter: AppInboxQueueEntryWriter;
    private readonly handlers: AppInboxHandlerRegistry;
    private readonly transactionWriter: AppInboxTransactionWriter;
    private readonly groupStateInboxHandler: GroupStateInboxHandler;
    private readonly wakeQueue?: () => void;
    private readonly serviceId: string;

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
            timing: config.timing,
            options: config.options
        });
        this.handlers = handlerRuntime.registry;
        this.transactionWriter = handlerRuntime.transactionWriter;
        this.groupStateService = dependencies.groupStateService;
        this.wakeQueue = config.wakeOwningQueue;
        this.serviceId = config.serviceId;
        this.groupStateInboxHandler = new GroupStateInboxHandler({
            mutationService: this.groupStateService,
            sessionGenerationLifecycle: this.groupStateService.sessionGenerationLifecycle,
            resultReader: dependencies.resultReader,
            transactionWriter: this.transactionWriter,
            wakeQueue: this.wakeQueue,
            formationMetrics: config.formationMetrics,
            readAuthenticatedMutation: (descriptor, authority) =>
                this.groupStateService.prepareAppInboxMutation(descriptor, authority)
        });
        this.registerMessageHandlers();
        this.handlers.assertRegistrationComplete(GROUP_MUTATION_INBOX_TYPES);
    }

    async enqueueExpiredPresenceSessions(atEpochMs: number): Promise<number> {
        const preparations = await this.groupStateService.prepareExpiredPresenceMutations(atEpochMs);
        for (const preparation of preparations) {
            await this.queueEntryWriter.enqueue(toExpiredPresenceEnqueue(preparation));
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
        await this.queueEntryWriter.enqueue({
            type: AppInboxType.GROUP_FORMATION_CRITERION,
            resourceId: preparation.queueResourceId,
            authority: decodeJsonWireValue(
                preparation,
                'Group formation AppInbox authority'
            ),
            data: { commandId: preparation.command.commandId }
        });
    }

    async enqueueFormationAutomationCommand(command: GroupMutationCommand, atEpochMs: number): Promise<void> {
        const preparation = await this.groupStateService.prepareFormationAutomationMutation(command, atEpochMs);
        await this.queueEntryWriter.enqueue({
            type: AppInboxType.GROUP_FORMATION_AUTOMATION,
            resourceId: preparation.queueResourceId,
            authority: decodeJsonWireValue(preparation, 'Group formation automation authority'),
            data: { commandId: preparation.command.commandId }
        });
    }

    async enqueueTopologyPublicationCommand(
        command: GroupMutationCommand,
        atEpochMs: number
    ): Promise<void> {
        const preparation = await this.groupStateService.prepareTopologyPublicationMutation(
            command,
            atEpochMs
        );
        await this.queueEntryWriter.enqueue({
            type: AppInboxType.GROUP_TOPOLOGY_PUBLICATION,
            resourceId: preparation.queueResourceId,
            authority: decodeJsonWireValue(preparation, 'Group topology publication AppInbox authority'),
            data: { commandId: preparation.command.commandId }
        });
    }

    async enqueueGroupSessionCleanup(
        input: GroupPresenceSessionCleanupAppInboxPayload
    ): Promise<number> {
        await this.queueEntryWriter.enqueue(toGroupSessionCleanupEnqueue(input, this.serviceId));
        return 1;
    }

    async processAuthenticatedGroupEntryUntilCompletion(
        enqueue: AuthenticatedGroupMutationEnqueue,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>> {
        const prepared = await this.prepareAuthenticatedGroupMutation(enqueue, authority);
        return await this.commandClient.enqueueAndWaitForResult<GroupStateInboxDurableResult>(
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
        const encodeGroupStateResult = (result: GroupStateInboxDurableResult) =>
            encodeAppInboxResult(result, 'Group state AppInbox result');
        const processGroupStateMutation = async (
            _command: JsonWireValue,
            context: AppInboxMessageContext<GroupStateInboxDurableResult>
        ) => {
            const result = await this.groupStateInboxHandler.processGroupStateMutation(context);
            if ('status' in result && (result.status === 'created' || result.status === 'ok')) {
                await this.groupStateService.observeSnapshot(result.result.snapshot);
            }
            return result;
        };
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_CREATE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_CREATE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_UPDATE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_UPDATE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_DIRECTOR_APPOINT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_DIRECTOR_APPOINT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PLAN,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_PLAN, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_CONNECT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_CONNECT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_ACTIVATE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_ACTIVATE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_RECONFIGURE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_RECONFIGURE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_JOIN,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_JOIN, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_INVITE_CREATE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_INVITE_CREATE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_INVITE_REVOKE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_INVITE_REVOKE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_INVITE_ACCEPT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_INVITE_ACCEPT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_ADMISSION_GRANT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_ADMISSION_GRANT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_ADMISSION_DECLINE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_ADMISSION_DECLINE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_JOIN_CODE_ROTATE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_MEMBER_REMOVE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_MEMBER_REMOVE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_MEMBER_BAN,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_MEMBER_BAN, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_MEMBER_UNBAN,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_MEMBER_UNBAN, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_MEMBER_ROLE_SET,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_MEMBER_ROLE_SET, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_OWNERSHIP_TRANSFER, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_MEMBER_UPSERT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_PRESENCE_CONNECT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_PRESENCE_HEARTBEAT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_PRESENCE_DISCONNECT, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_TRANSPORT_PAUSE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_TRANSPORT_PAUSE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_TRANSPORT_RESUME,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_TRANSPORT_RESUME, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_FORMATION_START,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_FORMATION_START, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_FORMATION_RESET,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_FORMATION_RESET, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_EXPIRE,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_PRESENCE_EXPIRE, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_FORMATION_AUTOMATION,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_FORMATION_AUTOMATION, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_FORMATION_CRITERION,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_FORMATION_CRITERION, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_TOPOLOGY_PUBLICATION,
            decodeCommand: (value) => decodeGroupStateAppInboxCommand(AppInboxType.GROUP_TOPOLOGY_PUBLICATION, value),
            encodeResult: encodeGroupStateResult,
            handle: processGroupStateMutation
        });
        this.handlers.registerHandler({
            type: AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
            decodeCommand: decodeGroupPresenceSessionCleanupAppInboxPayload,
            encodeResult: (result) => encodeAppInboxResult(result, 'Group cleanup AppInbox result'),
            handle: async (payload, context) =>
                await processGroupSessionCleanup({
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

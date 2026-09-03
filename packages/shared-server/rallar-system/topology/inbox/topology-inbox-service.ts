import { toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxType,
    type AppInboxEnqueueInput
} from '../../app-inbox/app-inbox-contracts.ts';
import { type AppInboxFailure } from '../../app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { encodeAppInboxCommand, encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import { GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-topics.ts';
import type { AppInboxCommandClient } from '../../app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxReservationClient } from '../../app-inbox/client/app-inbox-reservation-client.ts';
import type { AppInboxResultWaiter } from '../../app-inbox/client/app-inbox-result-waiter.ts';
import { createAppInboxClientRuntime } from '../../app-inbox/client/create-app-inbox-client-runtime.ts';
import { createAppInboxHandlerRuntime } from '../../app-inbox/handler/app-inbox-handler-runtime.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import {
    readDurableTopologyAppInboxCommand,
    toPersistedTopologyHttpMutationSemanticHash,
    toTopologyAppInboxType,
    toTopologyHttpMutationContextId
} from './topology-app-inbox-command.ts';
import type { TopologyAppInboxCommand } from './topology-app-inbox-contracts.ts';
import {
    decodeTopologyAppInboxResult,
    TopologyAppInboxHandler,
    type TopologyAppInboxMutationOwners,
    type TopologyAppInboxResult
} from './topology-app-inbox-handler.ts';

const TOPOLOGY_CONFIG_INBOX_TYPES: readonly AppInboxType[] = [
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE
];

export namespace TopologyInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxEntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
        readonly groupStateService: GroupStateService;
        readonly mutationOwners: TopologyAppInboxMutationOwners;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }

    export interface HttpCommandReservation {
        readonly operation: TopologyAppInboxCommand['operation'];
        readonly requestId: string;
        readonly callerId: string;
        readonly groupRef: TopologyAppInboxCommand['groupRef'];
        readonly semanticHash: string;
        readonly materialize: () => Promise<TopologyAppInboxCommand>;
    }
}

export class TopologyInboxService {
    private readonly commandClient: AppInboxCommandClient;
    private readonly reservationClient: AppInboxReservationClient;
    private readonly resultWaiter: AppInboxResultWaiter;
    private readonly handler: TopologyAppInboxHandler;

    constructor(
        dependencies: TopologyInboxService.Dependencies,
        config: TopologyInboxService.Config
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
        const handlers = handlerRuntime.registry;
        this.handler = new TopologyAppInboxHandler({
            groupStateService: dependencies.groupStateService,
            transactionWriter: handlerRuntime.transactionWriter,
            nowEpochMs: config.options?.nowEpochMs ?? Date.now,
            wakeQueue: config.wakeOwningQueue
        });
        for (const type of TOPOLOGY_CONFIG_INBOX_TYPES) {
            handlers.registerHandler({
                type,
                decodeCommand: readDurableTopologyAppInboxCommand,
                encodeResult: (result) => encodeAppInboxResult(result, 'Topology AppInbox result'),
                handle: async (_command, context) =>
                    await this.handler.processMutation(context, dependencies.mutationOwners)
            });
        }
        handlers.assertRegistrationComplete(TOPOLOGY_CONFIG_INBOX_TYPES);
    }

    async processAuthenticatedEntryUntilCompletion(
        enqueue: AppInboxEnqueueInput,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
        return await this.processAuthenticatedEntryUntilCompletionResult(enqueue, authority);
    }

    async processAuthenticatedEntryUntilCompletionResult(
        enqueue: AppInboxEnqueueInput,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
        if (!TOPOLOGY_CONFIG_INBOX_TYPES.includes(enqueue.type)) {
            throw new TypeError('Topology AppInbox type is required');
        }
        return await this.commandClient.enqueueAndWaitForResult(
            await this.handler.createAuthenticatedEnqueue(enqueue, authority),
            decodeTopologyAppInboxResult
        );
    }

    async processAuthenticatedHttpEntryUntilCompletionResult(
        reservation: TopologyInboxService.HttpCommandReservation,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
        const currentSession = await this.handler.readAndValidateCurrentSession(
            reservation.callerId,
            authority
        );
        const type = toTopologyAppInboxType(reservation.operation);
        const key = toStrictAppInboxQueueKey({
            topicId: type,
            resourceId: reservation.requestId,
            contextId: toTopologyHttpMutationContextId(reservation.groupRef, reservation.callerId)
        });
        const reserved = await this.reservationClient.reserveMaterializedEntry(
            {
                type,
                ...key,
                senderId: reservation.callerId,
                data: null
            },
            async () =>
                await this.handler.createAuthenticatedEnqueueFromValidatedSession(
                    {
                        type,
                        ...key,
                        senderId: reservation.callerId,
                        data: encodeAppInboxCommand(
                            await reservation.materialize(),
                            'Topology AppInbox command'
                        )
                    },
                    currentSession
                )
        );
        const command = readDurableTopologyAppInboxCommand(reserved.enqueue.data);
        if (
            command.operation !== reservation.operation ||
            command.requestId !== reservation.requestId ||
            command.actor.principalId !== reservation.callerId ||
            !sameGroupRef(command.groupRef, reservation.groupRef) ||
            reserved.enqueue.type !== type ||
            reserved.enqueue.topicId !== key.topicId ||
            reserved.enqueue.resourceId !== key.resourceId ||
            reserved.enqueue.contextId !== key.contextId ||
            reserved.enqueue.senderId !== reservation.callerId ||
            (await toPersistedTopologyHttpMutationSemanticHash(command)) !== reservation.semanticHash
        ) {
            throw new AppInboxIdempotencyConflictError(
                reservation.requestId,
                command.commandHash,
                reservation.semanticHash
            );
        }
        return await this.resultWaiter.waitForReservedResult(
            reserved,
            decodeTopologyAppInboxResult
        );
    }
}

function sameGroupRef(
    left: TopologyAppInboxCommand['groupRef'],
    right: TopologyAppInboxCommand['groupRef']
): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId
    );
}

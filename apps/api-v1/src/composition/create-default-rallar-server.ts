import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import type { RallarServerApplication } from '@shared-server/rallar-server/rallar-server-application.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';
import type { RallarServerWsRouterOptions } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import { toApiV1PublicConfiguration } from '../configuration/to-api-v1-public-configuration.ts';
import { createCrdtAdminMutations, type CrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import type { ApiV1DatabaseLifecycle } from '../db/api-v1-database-lifecycle.ts';
import { createLocalQueuePubSubBus } from '../db/local-queue-pubsub-bridge.ts';
import { createApiV1QueueResilience } from '../middleware-resilience.ts';
import { myPublisherId, myRtcTopologyStreamId, myServerId } from '../runtime/runtime-identity.ts';
import { createRuntimeStateExpiryLifecycle } from '../services/runtime-state-expiry-startup.ts';
import { createApiTimingSink, toApiAppInboxServiceOptions } from '../services/timing-service.ts';
import { createApiV1RoomWsAuthorizer } from '../services/ws-topic-room-authorizer.ts';
import {
    createApiV1BackgroundTaskLifecycle,
    type ApiV1BackgroundTaskLifecycle
} from './api-v1-background-task-lifecycle.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import {
    createApiV1AdminServices,
    readApiV1WebSocketStatus,
    type ApiV1AdminServices
} from './create-api-v1-admin-services.ts';
import { createApiV1RouteInstallers } from './create-api-v1-route-installers.ts';
import { createApiV1Runtime } from './create-api-v1-runtime.ts';
import { createApiV1SystemInstallers } from './create-api-v1-system-installers.ts';
import { createRallarServer } from './create-rallar-server.ts';

export interface CreateDefaultRallarServerInput {
    readonly configuration: ApiV1Configuration;
    readonly databaseLifecycle: ApiV1DatabaseLifecycle;
    readonly ws?: RallarServerWsRouterOptions;
}

export async function createDefaultRallarServer(
    input: CreateDefaultRallarServerInput
): Promise<RallarServerApplication<ApiV1Runtime, Hono>> {
    const backgroundTasks = createApiV1BackgroundTaskLifecycle({
        runtimeStateExpiry: createRuntimeStateExpiryLifecycle()
    });
    backgroundTasks.register(input.databaseLifecycle.close);
    try {
        return constructDefaultRallarServer(input, backgroundTasks);
    }
    catch (constructionError) {
        try {
            await backgroundTasks.stop();
        }
        catch (shutdownError) {
            throw new AggregateError(
                [constructionError, shutdownError],
                'API-v1 server construction and cleanup failed'
            );
        }
        throw constructionError;
    }
}

function constructDefaultRallarServer(
    input: CreateDefaultRallarServerInput,
    backgroundTasks: ApiV1BackgroundTaskLifecycle
): RallarServerApplication<ApiV1Runtime, Hono> {
    const configuration = input.configuration;
    const database = input.databaseLifecycle.database;
    const nowEpochMs = Date.now;
    const timing = createApiTimingSink(configuration.observability);
    const runtime = createConfiguredApiV1Runtime({ input, backgroundTasks, nowEpochMs, timing });

    const crdtLogRepository = new PSqlCrdtLogRepository(database, {
        policies: configuration.crdt.documentTypePolicies
    });
    const runtimeStateRepository = new PSqlRuntimeStateRepository(database);
    const authUserRepository = new AuthUserRepository(runtimeStateRepository);
    const topology = runtime.topologyServices;

    const { admin, crdtAdminMutations } = createDefaultApiV1AdminServices({
        input,
        runtime,
        nowEpochMs,
        timing,
        crdtLogRepository
    });

    const systemInstallers = createApiV1SystemInstallers({
        database,
        serviceId: myServerId,
        nowEpochMs,
        topology,
        crdtLogRepository,
        crdtPolicies: configuration.crdt.documentTypePolicies
    });
    const routeInstallers = createDefaultApiV1RouteInstallers({
        configuration,
        runtime,
        admin,
        crdtLogRepository,
        crdtAdminMutations,
        authUserRepository,
        nowEpochMs
    });

    return createRallarServer({
        runtime,
        repositories: defaultRepositoryManager,
        appDataRepository: new PSqlAppDataRepository(database),
        nowEpochMs,
        ws: {
            authorizeRoomMessage: createApiV1RoomWsAuthorizer(runtime.groupStateService, {
                readLifecyclePolicy: (ref) => topology.groupStateRepository.readLifecyclePolicy(ref)
            }),
            ...input.ws
        },
        systemInstallers,
        routeInstallers
    });
}

interface ConfiguredApiV1RuntimeInput {
    readonly input: CreateDefaultRallarServerInput;
    readonly backgroundTasks: ApiV1BackgroundTaskLifecycle;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
}

function createConfiguredApiV1Runtime(
    { input, backgroundTasks, nowEpochMs, timing }: ConfiguredApiV1RuntimeInput
): ApiV1Runtime {
    const configuration = input.configuration;
    const database = input.databaseLifecycle.database;
    const planning = configuration.topology.planning;
    const rtcTopologyOptions = {
        topologyKind: planning.topologyKind,
        degreeLimit: planning.degreeLimit,
        rttReportingDegreeLimit: planning.rttReportingDegreeLimit,
        treeMinSize: planning.treeMinSize,
        meshMinSize: planning.meshMinSize,
        meshParamK: planning.meshParamK,
        meshExitWidth: planning.meshExitWidth,
        treeExitWidth: planning.treeExitWidth,
        rttRebuildDebounceMs: configuration.topology.recompute.rttRebuildDebounceMs
    };

    return createApiV1Runtime({
        database,
        databasePubSubMode: configuration.database.pubSub,
        databaseNotification: input.databaseLifecycle.notification,
        serviceId: myServerId,
        publisherStreamId: myRtcTopologyStreamId,
        queuePubSubPublisherId: myPublisherId,
        queuePubSubChannel: 'ws-channel',
        queuePubSubLocalBus: createLocalQueuePubSubBus(),
        wsRuntimeName: 'default-qbox-server',
        authCredentialSecret: configuration.authentication.credentialSecret,
        nowEpochMs,
        timing,
        appInboxOptions: toApiAppInboxServiceOptions(configuration.appInbox),
        groupCapacity: {
            defaultMaxMembers: configuration.group.defaultMaxMembers
        },
        groupFormationRecomputeDebounceMs: configuration.topology.recompute.formationDebounceMs,
        topologyReplay: configuration.topology.replay,
        topologyDelivery: configuration.topology.delivery,
        adminClientIds: configuration.authentication.adminClientIds,
        rtcTopologyOptions,
        rttRefinementGateConfig: configuration.topology.rttRefinement,
        crdtPolicies: configuration.crdt.documentTypePolicies,
        resilience: {
            inbox: createApiV1QueueResilience(configuration.topology.queueResilience),
            outbox: createApiV1QueueResilience(configuration.topology.queueResilience),
            appOutbox: createApiV1QueueResilience(configuration.topology.queueResilience)
        },
        backgroundTasks
    });
}

interface DefaultApiV1AdminServicesInput {
    readonly input: CreateDefaultRallarServerInput;
    readonly runtime: ApiV1Runtime;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
    readonly crdtLogRepository: PSqlCrdtLogRepository;
}

interface DefaultApiV1AdminServices {
    readonly admin: ApiV1AdminServices;
    readonly crdtAdminMutations: CrdtAdminMutations;
}

function createDefaultApiV1AdminServices(
    { input, runtime, nowEpochMs, timing, crdtLogRepository }: DefaultApiV1AdminServicesInput
): DefaultApiV1AdminServices {
    const configuration = input.configuration;
    const database = input.databaseLifecycle.database;
    const topology = runtime.topologyServices;
    const appAdminInboxService = runtime.appAdminInboxService;
    const appCrdtInboxService = runtime.appCrdtInboxService;
    if (!appAdminInboxService || !appCrdtInboxService) {
        throw new Error('Admin database mutations require AppInbox services');
    }
    const crdtAdminMutations = createCrdtAdminMutations({
        appCrdtInboxService,
        nowEpochMs,
        createId: () => crypto.randomUUID(),
        serviceId: myServerId
    });
    const admin = createApiV1AdminServices({
        database,
        databaseMode: configuration.database.mode,
        databasePubSubMode: configuration.database.pubSub,
        nowEpochMs,
        serviceId: myServerId,
        timing,
        readWebSocketStatus: () => readApiV1WebSocketStatus(runtime.wsQBoxServerService.socket),
        // Durable, never the snapshot cache: an operator explanation must not
        // read a policy that lags a cross-server write.
        readLifecyclePolicy: (ref) => topology.groupStateRepository.readLifecyclePolicy(ref),
        readRtcTopologyMetrics: topology.readRtcTopologyMetrics,
        resetRtcTopologyMetrics: topology.resetRtcTopologyMetrics,
        readGroupFormationMetrics: runtime.groupFormationMetrics.readMetrics,
        resetGroupFormationMetrics: runtime.groupFormationMetrics.resetMetrics,
        crdtAdminRepository: crdtLogRepository,
        topologyQuery: topology.topologyQuery,
        clientStateService: runtime.clientStateService,
        groupStateService: runtime.groupStateService,
        appAdminInboxService,
        crdtAdminMutations,
        topologyInboxService: runtime.topologyInboxService
    });

    return { admin, crdtAdminMutations };
}

interface DefaultApiV1RouteInstallersInput {
    readonly configuration: ApiV1Configuration;
    readonly runtime: ApiV1Runtime;
    readonly admin: ApiV1AdminServices;
    readonly crdtLogRepository: PSqlCrdtLogRepository;
    readonly crdtAdminMutations: CrdtAdminMutations;
    readonly authUserRepository: AuthUserRepository;
    readonly nowEpochMs: () => number;
}

function createDefaultApiV1RouteInstallers({
    configuration,
    runtime,
    admin,
    crdtLogRepository,
    crdtAdminMutations,
    authUserRepository,
    nowEpochMs
}: DefaultApiV1RouteInstallersInput) {
    const topology = runtime.topologyServices;
    return createApiV1RouteInstallers({
        runtime,
        topology,
        admin,
        crdtLogRepository,
        crdtMutations: crdtAdminMutations,
        authUserRepository,
        authentication: {
            adminClientIds: configuration.authentication.adminClientIds,
            agentSessionTicketTtlMs: configuration.authentication.agentSessionTicketTtlMs,
            rateLimits: configuration.authentication.rateLimits,
            registrationMode: configuration.authentication.registrationMode,
            sessionTtlMs: configuration.authentication.sessionTtlMs,
            staticClients: configuration.authentication.staticClients,
            webSocketTicketTtlMs: configuration.authentication.webSocketTicketTtlMs
        },
        operatorToken: configuration.blackBox.operatorToken,
        publicConfiguration: toApiV1PublicConfiguration(configuration.publicApi),
        ice: configuration.ice,
        groupAdmission: configuration.group.admission,
        strictReadAuthorization: configuration.stateApi.strictReadAuthorization,
        nowEpochMs,
        createTokenId: () => crypto.randomUUID(),
        createWsAuthRequestFacts: () => ({
            requestId: crypto.randomUUID()
        })
    });
}

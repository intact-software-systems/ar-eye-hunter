import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { PSqlAppDataRepository } from '@shared-server/postgres/app-data/PSqlAppDataRepository.ts';
import {
    createAuthUserRepository,
    createRuntimeStateRepository
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import type { RallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';
import type { RallarServerWsFacadeOptions } from '@shared-server/rallar-facade/ws-topic-router.ts';
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import { toApiV1PublicConfiguration } from '../configuration/to-api-v1-public-configuration.ts';
import { createCrdtAdminMutations } from '../crdt/create-crdt-admin-mutations.ts';
import type { ApiV1DatabaseLifecycle } from '../db/api-v1-database-lifecycle.ts';
import { toResilienceDto } from '../middleware-resilience.ts';
import { myPublisherId, myRtcTopologyStreamId, myServerId } from '../runtime/runtime-identity.ts';
import { createRuntimeStateExpiryLifecycle } from '../services/runtime-state-expiry-startup.ts';
import { createApiTimingSink, toApiAppInboxServiceOptions } from '../services/timing-service.ts';
import { createApiV1RoomWsAuthorizer } from '../services/ws-topic-room-authorizer.ts';
import { createApiV1BackgroundTaskLifecycle } from './api-v1-background-task-lifecycle.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';
import { createApiV1AdminServices, readApiV1WebSocketStatus } from './create-api-v1-admin-services.ts';
import { createApiV1RouteInstallers } from './create-api-v1-route-installers.ts';
import { createApiV1Runtime } from './create-api-v1-runtime.ts';
import { createApiV1SystemInstallers } from './create-api-v1-system-installers.ts';
import { createApiV1TopologyServices } from './create-api-v1-topology-services.ts';
import { createRallarServer } from './create-rallar-server.ts';

export interface CreateDefaultRallarServerInput {
    readonly configuration: ApiV1Configuration;
    readonly databaseLifecycle: ApiV1DatabaseLifecycle;
    readonly ws?: RallarServerWsFacadeOptions;
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
    backgroundTasks: ReturnType<typeof createApiV1BackgroundTaskLifecycle>
): RallarServerApplication<ApiV1Runtime, Hono> {
    const configuration = input.configuration;
    const database = input.databaseLifecycle.database;
    const nowEpochMs = Date.now;
    const timing = createApiTimingSink(configuration.observability);

    const runtime = createApiV1Runtime({
        database,
        databasePubSubMode: configuration.database.pubSub,
        databaseNotification: input.databaseLifecycle.notification,
        serviceId: myServerId,
        publisherStreamId: myRtcTopologyStreamId,
        queuePubSubPublisherId: myPublisherId,
        queuePubSubChannel: 'ws-channel',
        wsRuntimeName: 'default-qbox-server',
        authCredentialSecret: configuration.authentication.credentialSecret,
        nowEpochMs,
        timing,
        appInboxOptions: toApiAppInboxServiceOptions(configuration.appInbox),
        clientFormationDamping: 'damped',
        groupCapacity: configuration.group,
        groupStateDissemination: 'delta-primary',
        createGroupFormationTopologyIntent: (outboxQueueReader) => ({
            damping: 'damped',
            outboxQueueReader,
            recomputeDebounceMs: configuration.topology.recompute.formationDebounceMs
        }),
        topologyReplay: configuration.topology.replay,
        topologyDelivery: configuration.topology.delivery,
        adminClientIds: configuration.authentication.adminClientIds,
        crdtPolicies: configuration.crdt.documentTypePolicies,
        resilience: {
            inbox: toResilienceDto(configuration.topology.queueResilience),
            outbox: toResilienceDto(configuration.topology.queueResilience),
            appOutbox: toResilienceDto(configuration.topology.queueResilience)
        },
        backgroundTasks
    });

    const crdtLogRepository = new PSqlCrdtLogRepository(database, {
        policies: configuration.crdt.documentTypePolicies
    });
    const runtimeStateRepository = createRuntimeStateRepository(database);
    const authUserRepository = createAuthUserRepository(runtimeStateRepository);
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
    const topology = createApiV1TopologyServices({
        runtimeStateRepository,
        groupStateService: runtime.groupStateService,
        groupInbox: runtime.appGroupInboxService,
        groupFormationRttMutation: runtime.groupFormationMetrics.rttMutation,
        webSocketServer: runtime.wsQBoxServerService.socket,
        topologyReplayMetrics: runtime.rtcTopologyReplay,
        serviceId: myServerId,
        adminClientIds: configuration.authentication.adminClientIds,
        rtcTopologyOptions,
        rttRefinementGateConfig: configuration.topology.rttRefinement,
        nowEpochMs,
        timing
    });

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
        readRtcTopologyMetrics: topology.readRtcTopologyMetrics,
        resetRtcTopologyMetrics: topology.resetRtcTopologyMetrics,
        readGroupFormationMetrics: runtime.groupFormationMetrics.readMetrics,
        resetGroupFormationMetrics: runtime.groupFormationMetrics.resetMetrics,
        crdtAdminRepository: crdtLogRepository,
        topologyManagement: topology.topologyManagement,
        clientStateService: runtime.clientStateService,
        groupStateService: runtime.groupStateService,
        appAdminInboxService,
        crdtAdminMutations,
        appGroupInboxService: runtime.appGroupInboxService
    });

    const systemInstallers = createApiV1SystemInstallers({
        database,
        serviceId: myServerId,
        nowEpochMs,
        topology,
        crdtLogRepository,
        crdtPolicies: configuration.crdt.documentTypePolicies,
        globalGraphRecomputeLimit: {
            windowMs: configuration.topology.recompute.globalWindowMs,
            maxPerWindow: configuration.topology.recompute.globalMaxPerWindow
        }
    });
    const routeInstallers = createApiV1RouteInstallers({
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

    return createRallarServer({
        runtime,
        repositories: defaultRepositoryManager,
        appDataRepository: new PSqlAppDataRepository(database),
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
